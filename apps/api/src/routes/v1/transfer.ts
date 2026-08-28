import { canonicalUuidSchema, exportFormatSchema } from "@glyphquire/api-contract";
import { idempotencyKeySchema } from "@glyphquire/api-contract/jobs";
import { Hono } from "hono";
import { z } from "zod";
import { PublicApiError } from "../../middleware/error-handler.js";
import { getRequestContext } from "../../middleware/request-context.js";
import type { SecurityVariables } from "../../middleware/security.js";
import type { ExportService } from "../../modules/transfer/ExportService.js";
import type { ImportService } from "../../modules/transfer/ImportService.js";

function invalidImport(): never {
  throw new PublicApiError("IMPORT_INVALID", 400);
}

function invalidExport(): never {
  throw new PublicApiError("EXPORT_FAILED", 400);
}

const exportRequestSchema = z.object({ format: exportFormatSchema }).strict();

function requireIdempotencyKey(context: {
  req: { header(name: string): string | undefined };
}): string {
  const parsed = idempotencyKeySchema.safeParse(context.req.header("idempotency-key"));
  if (!parsed.success) invalidExport();
  return parsed.data;
}

async function parseExportRequest(context: { req: { json(): Promise<unknown> } }) {
  let body: unknown;
  try {
    body = await context.req.json();
  } catch {
    invalidExport();
  }
  const parsed = exportRequestSchema.safeParse(body);
  if (!parsed.success) invalidExport();
  return parsed.data;
}

function requireNoQuery(context: { req: { url: string } }): void {
  if (new URL(context.req.url).search !== "") invalidExport();
}

/**
 * The optional export service preserves the reviewed Task 5b import-only seam
 * while Task 5c mounts the additional endpoints with both services.
 */
export function createTransferRoutes(importService: ImportService, exportService?: ExportService) {
  const routes = new Hono<{ Variables: SecurityVariables }>().get(
    "/imports/:id",
    async (context) => {
      const importId = canonicalUuidSchema.safeParse(context.req.param("id"));
      if (!importId.success) invalidImport();

      const { actorId } = getRequestContext(context);
      const result = await importService.getStatus(actorId, importId.data);
      return context.json(result, 200);
    },
  );

  if (!exportService) return routes;

  return routes
    .post("/workspaces/:workspaceId/export", async (context) => {
      requireNoQuery(context);
      const workspaceId = canonicalUuidSchema.safeParse(context.req.param("workspaceId"));
      if (!workspaceId.success) invalidExport();
      const idempotencyKey = requireIdempotencyKey(context);
      const input = await parseExportRequest(context);
      const { actorId } = getRequestContext(context);
      const result = await exportService.start(
        actorId,
        { workspaceId: workspaceId.data },
        input.format,
        idempotencyKey,
      );
      return context.json(result, 202);
    })
    .post("/notes/:noteId/export", async (context) => {
      requireNoQuery(context);
      const noteId = canonicalUuidSchema.safeParse(context.req.param("noteId"));
      if (!noteId.success) invalidExport();
      const idempotencyKey = requireIdempotencyKey(context);
      const input = await parseExportRequest(context);
      const { actorId } = getRequestContext(context);
      const result = await exportService.start(
        actorId,
        { noteId: noteId.data },
        input.format,
        idempotencyKey,
      );
      return context.json(result, 202);
    })
    .get("/exports/:id", async (context) => {
      requireNoQuery(context);
      const exportId = canonicalUuidSchema.safeParse(context.req.param("id"));
      if (!exportId.success) invalidExport();
      const { actorId } = getRequestContext(context);
      return context.json(await exportService.getStatus(actorId, exportId.data), 200);
    })
    .get("/exports/:id/download", async (context) => {
      requireNoQuery(context);
      const exportId = canonicalUuidSchema.safeParse(context.req.param("id"));
      if (!exportId.success) invalidExport();
      const { actorId } = getRequestContext(context);
      return context.json(await exportService.getDownload(actorId, exportId.data), 200);
    });
}
