import { randomUUID } from "node:crypto";
import { Hono, type Context } from "hono";
import { describe, expect, it } from "vitest";
import type { PersonalWorkspaceProvisioner } from "../../modules/workspaces/WorkspaceService.js";
import { createErrorHandler, PublicApiError } from "../../middleware/error-handler.js";
import type { SecurityVariables } from "../../middleware/security.js";
import { createMeRoutes } from "./me.js";

const baseUrl = "http://localhost:3000";

// Distinct canonical-UUID workspace ids per actor. `personalWorkspaceId` is a
// real UUID column, so the fake must return schema-valid UUIDs (not `ws-...`),
// while still proving each caller is scoped to its own workspace.
const workspaceForA = "33333333-3333-4333-8333-333333333333";
const workspaceForB = "44444444-4444-4444-8444-444444444444";

class FakeWorkspaceProvisioner implements PersonalWorkspaceProvisioner {
  readonly calls: string[] = [];
  async ensurePersonalWorkspace(actorId: string) {
    this.calls.push(actorId);
    const id =
      actorId === userA
        ? workspaceForA
        : actorId === userB
          ? workspaceForB
          : "00000000-0000-4000-8000-000000000000";
    return { id, name: "Personal" as const, role: "owner" as const };
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

function buildApp(service: PersonalWorkspaceProvisioner) {
  return new Hono<{ Variables: SecurityVariables }>()
    .use("*", testAuthMiddleware())
    .onError(createErrorHandler({ error() {} }))
    .route("/api/v1", createMeRoutes(service));
}

const userA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const userB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

describe("GET /api/v1/me", () => {
  it("returns the authenticated caller's own userId + personalWorkspaceId", async () => {
    const app = buildApp(new FakeWorkspaceProvisioner());
    const response = await app.request(`${baseUrl}/api/v1/me`, {
      headers: { "x-test-actor-id": userA },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ userId: userA, personalWorkspaceId: workspaceForA });
  });

  it("scopes the workspace to each caller (user B never sees user A's)", async () => {
    const app = buildApp(new FakeWorkspaceProvisioner());
    const response = await app.request(`${baseUrl}/api/v1/me`, {
      headers: { "x-test-actor-id": userB },
    });
    expect(await response.json()).toEqual({ userId: userB, personalWorkspaceId: workspaceForB });
  });

  it("rejects an unauthenticated request", async () => {
    const app = buildApp(new FakeWorkspaceProvisioner());
    const response = await app.request(`${baseUrl}/api/v1/me`);
    expect(response.status).toBe(404);
  });

  it("rejects any query string", async () => {
    const app = buildApp(new FakeWorkspaceProvisioner());
    const response = await app.request(`${baseUrl}/api/v1/me?workspaceId=x`, {
      headers: { "x-test-actor-id": userA },
    });
    expect(response.status).toBe(400);
  });
});
