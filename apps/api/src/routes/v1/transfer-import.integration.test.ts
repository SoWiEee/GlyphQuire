import { randomUUID } from "node:crypto";
import type { ImportJobResult } from "@glyphquire/api-contract";
import { Hono, type Context } from "hono";
import { describe, expect, it } from "vitest";
import { createErrorHandler } from "../../middleware/error-handler.js";
import type { SecurityVariables } from "../../middleware/security.js";
import type { ImportService, ImportStartInput } from "../../modules/transfer/ImportService.js";
import { createTransferRoutes } from "./transfer.js";

const baseUrl = "http://localhost:3000";

class FakeImportService implements ImportService {
  readonly statusCalls: Array<{ actorId: string; importId: string }> = [];

  constructor(private readonly result: ImportJobResult) {}

  async start(
    _actorId: string,
    _workspaceId: string,
    _input: ImportStartInput,
    _idempotencyKey: string,
  ): Promise<ImportJobResult> {
    throw new Error("not used by the status route");
  }

  async getStatus(actorId: string, importId: string): Promise<ImportJobResult> {
    this.statusCalls.push({ actorId, importId });
    return this.result;
  }
}

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

function buildApp(importService: ImportService) {
  return new Hono<{ Variables: SecurityVariables }>()
    .use("*", testAuthMiddleware())
    .onError(createErrorHandler({ error() {} }))
    .route("/api/v1", createTransferRoutes(importService));
}

describe("import status route", () => {
  it("forwards the authenticated actor and canonical import id", async () => {
    const actorId = `actor-${randomUUID()}`;
    const importId = randomUUID();
    const result: ImportJobResult = {
      id: importId,
      workspaceId: randomUUID(),
      status: "processing",
      progress: {
        completedItems: 1,
        totalItems: 2,
        processedBytes: 128,
        totalBytes: 256,
      },
    };
    const importService = new FakeImportService(result);
    const response = await buildApp(importService).request(
      `${baseUrl}/api/v1/imports/${importId}`,
      {
        headers: { "x-test-actor-id": actorId },
      },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(result);
    expect(importService.statusCalls).toEqual([{ actorId, importId }]);
  });

  it("rejects a non-canonical import id before service access", async () => {
    const importService = new FakeImportService({
      id: randomUUID(),
      workspaceId: randomUUID(),
      status: "pending",
      progress: { completedItems: 0, totalItems: 0, processedBytes: 0, totalBytes: 0 },
    });
    const response = await buildApp(importService).request(
      `${baseUrl}/api/v1/imports/not-an-import-id`,
      { headers: { "x-test-actor-id": `actor-${randomUUID()}` } },
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "IMPORT_INVALID", message: "The import is invalid" },
    });
    expect(importService.statusCalls).toEqual([]);
  });
});
