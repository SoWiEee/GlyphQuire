import { assetIdParamsSchema, workspaceIdParamsSchema } from "@glyphquire/api-contract";
import { Hono } from "hono";
import { PublicApiError } from "../../middleware/error-handler.js";
import { getRequestContext } from "../../middleware/request-context.js";
import type { SecurityVariables } from "../../middleware/security.js";
import type { AssetService } from "../../modules/assets/AssetService.js";

const MAX_IDEMPOTENCY_KEY_BYTES = 200;

function invalidRequest(): never {
  throw new PublicApiError("ASSET_INVALID", 400);
}

function requireIdempotencyKey(context: {
  req: { header(name: string): string | undefined };
}): string {
  const key = context.req.header("idempotency-key");
  if (
    !key ||
    key.length === 0 ||
    new TextEncoder().encode(key).byteLength > MAX_IDEMPOTENCY_KEY_BYTES
  ) {
    invalidRequest();
  }
  return key;
}

export function createAssetRoutes(assetService: AssetService) {
  return new Hono<{ Variables: SecurityVariables }>()
    .post("/workspaces/:workspaceId/assets", async (context) => {
      const params = workspaceIdParamsSchema.safeParse({
        workspaceId: context.req.param("workspaceId"),
      });
      if (!params.success) invalidRequest();
      const idempotencyKey = requireIdempotencyKey(context);

      let body: Record<string, string | File>;
      try {
        body = await context.req.parseBody();
      } catch {
        invalidRequest();
      }
      const file = body.file;
      if (!(file instanceof File)) invalidRequest();

      const arrayBuffer = await file.arrayBuffer();
      const { actorId } = getRequestContext(context);
      const result = await assetService.create(
        actorId,
        params.data.workspaceId,
        {
          originalName: file.name,
          declaredMimeType: file.type || "application/octet-stream",
          declaredSize: file.size,
          body: Buffer.from(arrayBuffer),
        },
        idempotencyKey,
      );
      return context.json(result, 201);
    })
    .get("/assets/:assetId", async (context) => {
      const params = assetIdParamsSchema.safeParse({ assetId: context.req.param("assetId") });
      if (!params.success) invalidRequest();

      const { actorId } = getRequestContext(context);
      const result = await assetService.get(actorId, params.data.assetId);
      return context.json(result, 200);
    })
    .get("/assets/:assetId/download", async (context) => {
      const params = assetIdParamsSchema.safeParse({ assetId: context.req.param("assetId") });
      if (!params.success) invalidRequest();

      const { actorId } = getRequestContext(context);
      const result = await assetService.getDownloadUrl(actorId, params.data.assetId);
      return context.json(result, 200);
    })
    .get("/assets/:assetId/thumbnail", async (context) => {
      const params = assetIdParamsSchema.safeParse({ assetId: context.req.param("assetId") });
      if (!params.success) invalidRequest();

      const { actorId } = getRequestContext(context);
      const result = await assetService.getThumbnailUrl(actorId, params.data.assetId);
      return context.json(result, 200);
    })
    .delete("/assets/:assetId", async (context) => {
      const params = assetIdParamsSchema.safeParse({ assetId: context.req.param("assetId") });
      if (!params.success) invalidRequest();
      const idempotencyKey = requireIdempotencyKey(context);

      const { actorId } = getRequestContext(context);
      const result = await assetService.delete(actorId, params.data.assetId, idempotencyKey);
      return context.json(result, 200);
    });
}
