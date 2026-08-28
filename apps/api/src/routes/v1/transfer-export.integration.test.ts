import { randomUUID } from "node:crypto";
import type { ExportFormat, ExportResult, ImportJobResult } from "@glyphquire/api-contract";
import { Hono, type Context } from "hono";
import { describe, expect, it } from "vitest";
import { createErrorHandler } from "../../middleware/error-handler.js";
import type { SecurityVariables } from "../../middleware/security.js";
import type { ExportService, ExportStartScope } from "../../modules/transfer/ExportService.js";
import type { ImportService, ImportStartInput } from "../../modules/transfer/ImportService.js";
import { createTransferRoutes } from "./transfer.js";

const baseUrl = "http://localhost:3000";

class FakeImportService implements ImportService {
  async start(
    _actorId: string,
    _workspaceId: string,
    _input: ImportStartInput,
    _idempotencyKey: string,
  ): Promise<ImportJobResult> {
    throw new Error("not used by export routes");
  }

  async getStatus(_actorId: string, _importId: string): Promise<ImportJobResult> {
    throw new Error("not used by export routes");
  }
}

class FakeExportService implements ExportService {
  readonly startCalls: Array<{
    actorId: string;
    scope: ExportStartScope;
    format: ExportFormat;
    idempotencyKey: string;
  }> = [];
  readonly statusCalls: Array<{ actorId: string; exportId: string }> = [];
  readonly downloadCalls: Array<{ actorId: string; exportId: string }> = [];

  constructor(private readonly result: ExportResult) {}

  async start(
    actorId: string,
    scope: ExportStartScope,
    format: ExportFormat,
    idempotencyKey: string,
  ): Promise<ExportResult> {
    this.startCalls.push({ actorId, scope, format, idempotencyKey });
    return this.result;
  }

  async getStatus(actorId: string, exportId: string): Promise<ExportResult> {
    this.statusCalls.push({ actorId, exportId });
    return this.result;
  }

  async getDownload(actorId: string, exportId: string): Promise<ExportResult> {
    this.downloadCalls.push({ actorId, exportId });
    return {
      ...this.result,
      status: "completed",
      downloadUrl: "https://download.example/artifact",
    };
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

function buildApp(exportService: ExportService) {
  return new Hono<{ Variables: SecurityVariables }>()
    .use("*", testAuthMiddleware())
    .onError(createErrorHandler({ error() {} }))
    .route("/api/v1", createTransferRoutes(new FakeImportService(), exportService));
}

function resultFor(workspaceId: string, exportId: string): ExportResult {
  return {
    id: exportId,
    workspaceId,
    status: "pending",
    format: "zip",
    scope: { type: "workspace", workspaceId },
    createdAt: "2026-08-28T00:00:00.000Z",
    expiresAt: "2026-08-29T00:00:00.000Z",
  };
}

describe("export routes", () => {
  it("forwards only authenticated path scope and validated format/key to export operations", async () => {
    const actorId = `actor-${randomUUID()}`;
    const workspaceId = randomUUID();
    const noteId = randomUUID();
    const exportId = randomUUID();
    const idempotencyKey = randomUUID();
    const service = new FakeExportService(resultFor(workspaceId, exportId));
    const app = buildApp(service);

    const workspaceResponse = await app.request(
      `${baseUrl}/api/v1/workspaces/${workspaceId}/export`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": idempotencyKey,
          "x-test-actor-id": actorId,
        },
        body: JSON.stringify({ format: "zip" }),
      },
    );
    const noteResponse = await app.request(`${baseUrl}/api/v1/notes/${noteId}/export`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": `${idempotencyKey}-note`,
        "x-test-actor-id": actorId,
      },
      body: JSON.stringify({ format: "html" }),
    });
    const statusResponse = await app.request(`${baseUrl}/api/v1/exports/${exportId}`, {
      headers: { "x-test-actor-id": actorId },
    });
    const downloadResponse = await app.request(`${baseUrl}/api/v1/exports/${exportId}/download`, {
      headers: { "x-test-actor-id": actorId },
    });

    expect(workspaceResponse.status).toBe(202);
    expect(noteResponse.status).toBe(202);
    expect(statusResponse.status).toBe(200);
    expect(downloadResponse.status).toBe(200);
    expect(service.startCalls).toEqual([
      { actorId, scope: { workspaceId }, format: "zip", idempotencyKey },
      {
        actorId,
        scope: { noteId },
        format: "html",
        idempotencyKey: `${idempotencyKey}-note`,
      },
    ]);
    expect(service.statusCalls).toEqual([{ actorId, exportId }]);
    expect(service.downloadCalls).toEqual([{ actorId, exportId }]);
  });

  it("rejects client object keys in bodies or download queries before service access", async () => {
    const actorId = `actor-${randomUUID()}`;
    const workspaceId = randomUUID();
    const exportId = randomUUID();
    const service = new FakeExportService(resultFor(workspaceId, exportId));
    const app = buildApp(service);

    const bodyResponse = await app.request(`${baseUrl}/api/v1/workspaces/${workspaceId}/export`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": randomUUID(),
        "x-test-actor-id": actorId,
      },
      body: JSON.stringify({ format: "zip", objectKey: "workspace/victim/private" }),
    });
    const queryResponse = await app.request(
      `${baseUrl}/api/v1/exports/${exportId}/download?objectKey=workspace/victim/private`,
      { headers: { "x-test-actor-id": actorId } },
    );

    expect(bodyResponse.status).toBe(400);
    expect(queryResponse.status).toBe(400);
    expect(service.startCalls).toEqual([]);
    expect(service.downloadCalls).toEqual([]);
  });
});
