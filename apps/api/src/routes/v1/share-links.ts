import {
  canonicalUuidSchema,
  createShareLinkInputSchema,
  idempotencyKeySchema,
  noteIdParamsSchema,
  shareLinkResponseSchema,
} from "@glyphquire/api-contract";
import { Hono } from "hono";
import { PublicApiError } from "../../middleware/error-handler.js";
import { getRequestContext } from "../../middleware/request-context.js";
import type { SecurityVariables } from "../../middleware/security.js";
import type { ShareLinkManagementService } from "../../modules/share-links/ShareLinkService.js";

function invalidRequest(): never {
  throw new PublicApiError("DOCUMENT_INVALID", 400);
}

function notFound(): never {
  throw new PublicApiError("SHARE_NOT_FOUND", 404);
}

export function createShareLinkRoutes(service: ShareLinkManagementService) {
  return new Hono<{ Variables: SecurityVariables }>()
    .post("/notes/:noteId/share-links", async (context) => {
      const params = noteIdParamsSchema.safeParse({ noteId: context.req.param("noteId") });
      if (!params.success) notFound();
      const idempotencyKey = idempotencyKeySchema.safeParse(context.req.header("idempotency-key"));
      if (!idempotencyKey.success) invalidRequest();

      let untrustedBody: unknown;
      try {
        untrustedBody = await context.req.json();
      } catch {
        invalidRequest();
      }
      const body = createShareLinkInputSchema.safeParse(untrustedBody);
      if (!body.success) invalidRequest();

      const result = await service.create(
        getRequestContext(context).actorId,
        params.data.noteId,
        body.data,
        idempotencyKey.data,
      );
      return context.json(shareLinkResponseSchema.parse(result), 201);
    })
    .delete("/share-links/:linkId", async (context) => {
      const linkId = canonicalUuidSchema.safeParse(context.req.param("linkId"));
      if (!linkId.success) notFound();
      await service.revoke(getRequestContext(context).actorId, linkId.data);
      return context.body(null, 204);
    });
}
