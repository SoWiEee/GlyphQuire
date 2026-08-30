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
  readonly startCalls: Array<{
    actorId: string;
    workspaceId: string;
    input: ImportStartInput;
    idempotencyKey: string;
  }> = [];

  constructor(readonly result: ImportJobResult) {}

  async start(
    actorId: string,
    workspaceId: string,
    input: ImportStartInput,
    idempotencyKey: string,
  ): Promise<ImportJobResult> {
    this.startCalls.push({ actorId, workspaceId, input, idempotencyKey });
    return this.result;
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
  it("starts a bounded multipart import with authenticated scope and strict optional CAS", async () => {
    const actorId = `actor-${randomUUID()}`;
    const workspaceId = randomUUID();
    const noteId = randomUUID();
    const importId = randomUUID();
    const idempotencyKey = randomUUID();
    const importService = new FakeImportService({
      id: importId,
      workspaceId,
      status: "pending",
      noteId,
      progress: { completedItems: 0, totalItems: 1, processedBytes: 0, totalBytes: 12 },
    });
    const form = new FormData();
    const upload = new File(["# Imported"], "note.md", { type: "text/markdown" });
    form.set("file", upload);
    form.set("noteId", noteId);
    form.set("baseRevision", "3");

    const response = await buildApp(importService).request(
      `${baseUrl}/api/v1/workspaces/${workspaceId}/import`,
      {
        method: "POST",
        headers: { "idempotency-key": idempotencyKey, "x-test-actor-id": actorId },
        body: form,
      },
    );

    expect(response.status).toBe(202);
    expect(await response.json()).toEqual(importService.result);
    expect(importService.startCalls).toHaveLength(1);
    expect(importService.startCalls[0]).toMatchObject({
      actorId,
      workspaceId,
      idempotencyKey,
      input: { noteId, baseRevision: 3 },
    });
    expect(importService.startCalls[0]?.input.upload).toBeInstanceOf(Blob);
    await expect(importService.startCalls[0]?.input.upload.text()).resolves.toBe("# Imported");
  });

  it("rejects import body smuggling and incomplete CAS before service access", async () => {
    const actorId = `actor-${randomUUID()}`;
    const workspaceId = randomUUID();
    const noteId = randomUUID();
    const importService = new FakeImportService({
      id: randomUUID(),
      workspaceId,
      status: "pending",
      progress: { completedItems: 0, totalItems: 0, processedBytes: 0, totalBytes: 0 },
    });
    const candidates = [
      { noteId, objectKey: "workspace/victim/private" },
      { noteId },
      { baseRevision: "3" },
    ];

    for (const fields of candidates) {
      const form = new FormData();
      form.set("file", new File(["# Imported"], "note.md", { type: "text/markdown" }));
      for (const [key, value] of Object.entries(fields)) form.set(key, value);
      const response = await buildApp(importService).request(
        `${baseUrl}/api/v1/workspaces/${workspaceId}/import`,
        {
          method: "POST",
          headers: { "idempotency-key": randomUUID(), "x-test-actor-id": actorId },
          body: form,
        },
      );
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({ error: { code: "IMPORT_INVALID" } });
    }
    expect(importService.startCalls).toEqual([]);
  });

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
