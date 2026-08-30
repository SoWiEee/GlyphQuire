import { randomUUID } from "node:crypto";
import type { DeletionResponse } from "@glyphquire/api-contract";
import { Hono, type Context } from "hono";
import { describe, expect, it, vi } from "vitest";
import { createErrorHandler, type SecurityLogger } from "../../middleware/error-handler.js";
import type { SecurityVariables } from "../../middleware/security.js";
import type { AccountDeletionService } from "../../modules/lifecycle/AccountDeletionService.js";
import type { WorkspaceDeletionService } from "../../modules/lifecycle/WorkspaceDeletionService.js";
import { createDeletionRoutes } from "./deletion.js";

const baseUrl = "http://localhost:3000";

function testAuthMiddleware() {
  return async (context: Context<{ Variables: SecurityVariables }>, next: () => Promise<void>) => {
    const actorId = context.req.header("x-test-actor-id");
    if (!actorId) return context.json({ error: { code: "NOTE_NOT_FOUND" } }, 404);
    context.set("requestContext", {
      requestId: randomUUID(),
      actorId,
      session: {} as never,
    });
    await next();
  };
}

function response(): DeletionResponse {
  return {
    id: randomUUID(),
    status: "pending",
    confirmedAt: "2026-08-26T00:00:00.000Z",
    executeAfter: "2026-08-27T00:00:00.000Z",
  };
}

function buildApp(
  overrides: {
    workspaceDeletion?: WorkspaceDeletionService;
    accountDeletion?: AccountDeletionService;
    logger?: SecurityLogger;
  } = {},
) {
  const workspaceDeletion: WorkspaceDeletionService = overrides.workspaceDeletion ?? {
    request: vi.fn().mockResolvedValue(response()),
  };
  const accountDeletion: AccountDeletionService = overrides.accountDeletion ?? {
    request: vi.fn().mockResolvedValue(response()),
  };
  const app = new Hono<{ Variables: SecurityVariables }>()
    .use("*", testAuthMiddleware())
    .onError(createErrorHandler(overrides.logger))
    .route("/api/v1", createDeletionRoutes(workspaceDeletion, accountDeletion));
  return { app, workspaceDeletion, accountDeletion };
}

function request(
  app: ReturnType<typeof buildApp>["app"],
  path: string,
  body: unknown,
  key?: string,
) {
  const headers = new Headers({
    "content-type": "application/json",
    "x-test-actor-id": "opaque-actor",
  });
  if (key) headers.set("idempotency-key", key);
  return app.request(`${baseUrl}/api/v1${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

describe("lifecycle deletion routes", () => {
  it("forwards only the exact workspace confirmation and idempotency key", async () => {
    const { app, workspaceDeletion } = buildApp();
    const workspaceId = randomUUID();
    const result = await request(
      app,
      `/workspaces/${workspaceId}/deletion`,
      { confirm: "DELETE_WORKSPACE" },
      "delete-workspace-1",
    );

    expect(result.status).toBe(202);
    expect(workspaceDeletion.request).toHaveBeenCalledWith(
      "opaque-actor",
      workspaceId,
      { confirm: "DELETE_WORKSPACE" },
      "delete-workspace-1",
    );
  });

  it.each([
    [{ confirm: "delete_workspace" }, "key"],
    [{ confirm: "DELETE_WORKSPACE", accountId: "victim" }, "key"],
    [{ confirm: "DELETE_WORKSPACE" }, undefined],
  ])("rejects malformed workspace deletion input", async (body, key) => {
    const { app, workspaceDeletion } = buildApp();
    const result = await request(app, `/workspaces/${randomUUID()}/deletion`, body, key);

    expect(result.status).toBe(400);
    expect(workspaceDeletion.request).not.toHaveBeenCalled();
  });

  it("rejects malformed workspace ids and unexpected query parameters", async () => {
    const { app, workspaceDeletion } = buildApp();
    const body = { confirm: "DELETE_WORKSPACE" };

    expect((await request(app, "/workspaces/not-a-uuid/deletion", body, "key")).status).toBe(400);
    expect(
      (await request(app, `/workspaces/${randomUUID()}/deletion?accountId=victim`, body, "key"))
        .status,
    ).toBe(400);
    expect(workspaceDeletion.request).not.toHaveBeenCalled();
  });

  it("supports the same exact confirmation for a zero-workspace account", async () => {
    const { app, accountDeletion } = buildApp();
    const result = await request(
      app,
      "/account/deletion",
      { confirm: "DELETE_WORKSPACE" },
      "delete-account-1",
    );

    expect(result.status).toBe(202);
    expect(accountDeletion.request).toHaveBeenCalledWith(
      "opaque-actor",
      { confirm: "DELETE_WORKSPACE" },
      "delete-account-1",
    );
  });

  it.each([
    [{ confirm: "DELETE_ACCOUNT" }, "key"],
    [{ confirm: "DELETE_WORKSPACE", accountId: "victim" }, "key"],
    [{ confirm: "DELETE_WORKSPACE" }, undefined],
  ])("rejects malformed account deletion input", async (body, key) => {
    const { app, accountDeletion } = buildApp();
    const result = await request(app, "/account/deletion", body, key);

    expect(result.status).toBe(400);
    expect(accountDeletion.request).not.toHaveBeenCalled();
  });

  it("fails closed without leaking unexpected deletion response fields", async () => {
    const sentinel = "s3://private-bucket/secret-object-key";
    const entries: unknown[] = [];
    const workspaceDeletion = {
      request: vi.fn().mockResolvedValue({ ...response(), objectKey: sentinel }),
    } as unknown as WorkspaceDeletionService;
    const { app } = buildApp({
      workspaceDeletion,
      logger: { error: (entry) => entries.push(entry) },
    });

    const result = await request(
      app,
      `/workspaces/${randomUUID()}/deletion`,
      { confirm: "DELETE_WORKSPACE" },
      "delete-workspace-scrubbed",
    );
    const serialized = JSON.stringify({ body: await result.json(), entries });

    expect(result.status).toBe(503);
    expect(serialized).not.toContain(sentinel);
    expect(serialized).not.toContain("objectKey");
  });
});
