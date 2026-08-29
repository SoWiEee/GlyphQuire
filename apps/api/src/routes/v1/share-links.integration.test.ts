import { randomBytes, randomUUID } from "node:crypto";
import type { CreateShareLinkInput, ShareLinkResponse } from "@glyphquire/api-contract";
import { Hono, type Context } from "hono";
import { describe, expect, it } from "vitest";
import { createErrorHandler, PublicApiError } from "../../middleware/error-handler.js";
import type { SecurityVariables } from "../../middleware/security.js";
import type { ShareLinkManagementService } from "../../modules/share-links/ShareLinkService.js";
import { createShareLinkRoutes } from "./share-links.js";

const baseUrl = "http://localhost:3000";

class FakeShareLinkService implements ShareLinkManagementService {
  readonly creates: Array<{
    actorId: string;
    noteId: string;
    input: CreateShareLinkInput;
    idempotencyKey: string;
  }> = [];
  readonly revokes: Array<{ actorId: string; linkId: string }> = [];
  createResult: ShareLinkResponse = {
    id: randomUUID(),
    workspaceId: randomUUID(),
    noteId: randomUUID(),
    token: randomBytes(32).toString("base64url"),
    url: "https://glyphquire.example/api/v1/shared/test",
    expiresAt: null,
    createdAt: "2026-08-29T00:00:00.000Z",
  };

  async create(
    actorId: string,
    noteId: string,
    input: CreateShareLinkInput,
    idempotencyKey: string,
  ): Promise<ShareLinkResponse> {
    this.creates.push({ actorId, noteId, input, idempotencyKey });
    return { ...this.createResult, noteId };
  }

  async revoke(actorId: string, linkId: string): Promise<void> {
    this.revokes.push({ actorId, linkId });
  }
}

function testAuthMiddleware() {
  return async (context: Context<{ Variables: SecurityVariables }>, next: () => Promise<void>) => {
    const actorId = context.req.header("x-test-actor-id");
    if (!actorId) throw new PublicApiError("SHARE_NOT_FOUND", 404);
    context.set("requestId", randomUUID());
    context.set("clientIp", "127.0.0.1");
    context.set("requestContext", {
      requestId: context.get("requestId"),
      actorId,
      session: {} as never,
    });
    await next();
  };
}

function buildApp(service: ShareLinkManagementService) {
  return new Hono<{ Variables: SecurityVariables }>()
    .use("*", testAuthMiddleware())
    .onError(createErrorHandler())
    .route("/api/v1", createShareLinkRoutes(service));
}

function request(
  app: ReturnType<typeof buildApp>,
  path: string,
  actorId: string,
  init: RequestInit = {},
) {
  const headers = new Headers(init.headers);
  headers.set("x-test-actor-id", actorId);
  return app.request(`${baseUrl}/api/v1${path}`, { ...init, headers });
}

describe("share-link management routes", () => {
  it("creates a link with canonical input and a required idempotency key", async () => {
    const service = new FakeShareLinkService();
    const app = buildApp(service);
    const actorId = "opaque-route-actor";
    const noteId = randomUUID();
    const idempotencyKey = `share.${randomUUID()}`;
    const expiresAt = "2026-08-30T00:00:00.000Z";

    const response = await request(app, `/notes/${noteId}/share-links`, actorId, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": idempotencyKey,
      },
      body: JSON.stringify({ expiresAt }),
    });

    expect(response.status).toBe(201);
    expect(await response.json()).toEqual(expect.objectContaining({ noteId }));
    expect(service.creates).toEqual([{ actorId, noteId, input: { expiresAt }, idempotencyKey }]);
  });

  it("rejects missing, malformed, or oversized idempotency keys before service invocation", async () => {
    for (const key of [undefined, "contains space", "x".repeat(201)]) {
      const service = new FakeShareLinkService();
      const app = buildApp(service);
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (key !== undefined) headers["idempotency-key"] = key;
      const response = await request(app, `/notes/${randomUUID()}/share-links`, "actor", {
        method: "POST",
        headers,
        body: "{}",
      });
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: { code: "DOCUMENT_INVALID" } });
      expect(service.creates).toHaveLength(0);
    }
  });

  it("strictly rejects malformed note ids and bodies without reflecting input", async () => {
    const service = new FakeShareLinkService();
    const app = buildApp(service);
    const badId = "not-a-note-id";
    const malformedId = await request(app, `/notes/${badId}/share-links`, "actor", {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": randomUUID() },
      body: "{}",
    });
    expect(malformedId.status).toBe(404);
    const malformedEnvelope = JSON.stringify(await malformedId.json());
    expect(malformedEnvelope).toContain("SHARE_NOT_FOUND");
    expect(malformedEnvelope).not.toContain(badId);

    const extraBody = await request(app, `/notes/${randomUUID()}/share-links`, "actor", {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": randomUUID() },
      body: JSON.stringify({ expiresAt: null, creatorId: "attacker" }),
    });
    expect(extraBody.status).toBe(400);
    expect(await extraBody.json()).toMatchObject({ error: { code: "DOCUMENT_INVALID" } });
    expect(service.creates).toHaveLength(0);
  });

  it("revokes by canonical link id and returns an empty 204 response", async () => {
    const service = new FakeShareLinkService();
    const app = buildApp(service);
    const linkId = randomUUID();
    const response = await request(app, `/share-links/${linkId}`, "route-owner", {
      method: "DELETE",
    });

    expect(response.status).toBe(204);
    expect(await response.text()).toBe("");
    expect(service.revokes).toEqual([{ actorId: "route-owner", linkId }]);
  });

  it("maps malformed revoke ids and authorization failures to stable scrubbed errors", async () => {
    const service = new FakeShareLinkService();
    service.revoke = async () => {
      throw new PublicApiError("SHARE_NOT_FOUND", 404);
    };
    const app = buildApp(service);

    for (const linkId of ["not-a-link-id-plaintext", randomUUID()]) {
      const response = await request(app, `/share-links/${linkId}`, "outsider", {
        method: "DELETE",
      });
      expect(response.status).toBe(404);
      const body = JSON.stringify(await response.json());
      expect(body).toContain("SHARE_NOT_FOUND");
      expect(body).not.toContain(linkId);
    }
  });
});
