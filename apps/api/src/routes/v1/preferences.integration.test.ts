import { randomUUID } from "node:crypto";
import type { PutThemePreferenceInput, ThemePreferenceResult } from "@glyphquire/api-contract";
import { Hono, type Context } from "hono";
import { describe, expect, it } from "vitest";
import { createErrorHandler, PublicApiError } from "../../middleware/error-handler.js";
import type { SecurityVariables } from "../../middleware/security.js";
import type { UserPreferenceService } from "../../modules/preferences/UserPreferenceService.js";
import { createUserPreferenceRoutes } from "./preferences.js";

const baseUrl = "http://localhost:3000";
const defaultResult: ThemePreferenceResult = {
  themeId: null,
  mode: "light",
  customOverrides: {},
  variantOverrides: {},
  revision: 0,
  updatedAt: "1970-01-01T00:00:00.000Z",
};

class FakeUserPreferenceService implements UserPreferenceService {
  readonly reads: string[] = [];
  readonly writes: Array<{ actorId: string; input: PutThemePreferenceInput }> = [];
  result = defaultResult;

  async getThemePreference(actorId: string): Promise<ThemePreferenceResult> {
    this.reads.push(actorId);
    return this.result;
  }

  async putThemePreference(
    actorId: string,
    input: PutThemePreferenceInput,
  ): Promise<ThemePreferenceResult> {
    this.writes.push({ actorId, input });
    const { baseRevision, ...preference } = input;
    return { ...this.result, ...preference, revision: baseRevision + 1 };
  }
}

function testAuthMiddleware() {
  return async (context: Context<{ Variables: SecurityVariables }>, next: () => Promise<void>) => {
    const actorId = context.req.header("x-test-actor-id");
    if (!actorId) throw new PublicApiError("NOTE_NOT_FOUND", 404);
    const requestId = randomUUID();
    context.set("requestId", requestId);
    context.set("clientIp", "127.0.0.1");
    context.set("requestContext", { requestId, actorId, session: {} as never });
    await next();
  };
}

function buildApp(service: UserPreferenceService) {
  return new Hono<{ Variables: SecurityVariables }>()
    .use("*", testAuthMiddleware())
    .onError(createErrorHandler({ error() {} }))
    .route("/api/v1", createUserPreferenceRoutes(service));
}

describe("user theme preference routes", () => {
  it("rejects unauthenticated requests before service invocation", async () => {
    const service = new FakeUserPreferenceService();
    const response = await buildApp(service).request(`${baseUrl}/api/v1/me/preferences/theme`);

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: { code: "NOTE_NOT_FOUND" } });
    expect(service.reads).toHaveLength(0);
  });

  it("reads only the authenticated actor and rejects identity query parameters", async () => {
    const service = new FakeUserPreferenceService();
    const app = buildApp(service);
    const response = await app.request(`${baseUrl}/api/v1/me/preferences/theme`, {
      headers: { "x-test-actor-id": "authenticated-actor" },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(defaultResult);
    expect(service.reads).toEqual(["authenticated-actor"]);

    const forged = await app.request(`${baseUrl}/api/v1/me/preferences/theme?userId=victim`, {
      headers: { "x-test-actor-id": "authenticated-actor" },
    });
    expect(forged.status).toBe(400);
    expect(service.reads).toEqual(["authenticated-actor"]);
  });

  it("writes a complete payload with actor identity from request context", async () => {
    const service = new FakeUserPreferenceService();
    const input: PutThemePreferenceInput = {
      themeId: null,
      mode: "dark",
      customOverrides: { color: { background: "#111827" } },
      variantOverrides: { toggle: { variant: "card" } },
      baseRevision: 0,
    };
    const response = await buildApp(service).request(`${baseUrl}/api/v1/me/preferences/theme`, {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        "x-test-actor-id": "authenticated-actor",
      },
      body: JSON.stringify(input),
    });

    expect(response.status).toBe(200);
    expect(service.writes).toEqual([{ actorId: "authenticated-actor", input }]);
    expect(await response.json()).toMatchObject({ mode: "dark", revision: 1 });
  });

  it("rejects incomplete, forged, and malformed writes with the stable invalid envelope", async () => {
    const candidates = [
      { themeId: null, mode: "light", customOverrides: {}, baseRevision: 0 },
      {
        themeId: null,
        mode: "light",
        customOverrides: {},
        variantOverrides: {},
        baseRevision: 0,
        userId: "victim",
      },
      {
        themeId: null,
        mode: "light",
        customOverrides: { color: { background: "javascript:alert(1)" } },
        variantOverrides: {},
        baseRevision: 0,
      },
    ];

    for (const body of candidates) {
      const service = new FakeUserPreferenceService();
      const response = await buildApp(service).request(`${baseUrl}/api/v1/me/preferences/theme`, {
        method: "PUT",
        headers: {
          "content-type": "application/json",
          "x-test-actor-id": "authenticated-actor",
        },
        body: JSON.stringify(body),
      });
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: { code: "DOCUMENT_INVALID" } });
      expect(service.writes).toHaveLength(0);
    }
  });

  it("preserves the revision-conflict error envelope", async () => {
    const service = new FakeUserPreferenceService();
    service.putThemePreference = async () => {
      throw new PublicApiError("REVISION_CONFLICT", 409);
    };
    const response = await buildApp(service).request(`${baseUrl}/api/v1/me/preferences/theme`, {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        "x-test-actor-id": "authenticated-actor",
      },
      body: JSON.stringify({
        themeId: null,
        mode: "light",
        customOverrides: {},
        variantOverrides: {},
        baseRevision: 1,
      }),
    });

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: "REVISION_CONFLICT" } });
  });
});
