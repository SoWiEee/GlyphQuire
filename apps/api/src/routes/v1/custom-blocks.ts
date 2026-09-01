import {
  createCustomBlockInputSchema,
  customBlockIdParamsSchema,
  publishCustomBlockInputSchema,
  updateCustomBlockDraftInputSchema,
  workspaceIdParamsSchema,
} from "@glyphquire/api-contract";
import { Hono } from "hono";
import { PublicApiError } from "../../middleware/error-handler.js";
import { getRequestContext } from "../../middleware/request-context.js";
import type { SecurityVariables } from "../../middleware/security.js";
import type { CustomBlockService } from "../../modules/custom-blocks/CustomBlockService.js";

function invalid(): never {
  throw new PublicApiError("DOCUMENT_INVALID", 400);
}
async function json(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    invalid();
  }
}

export function createCustomBlockRoutes(service: CustomBlockService) {
  return new Hono<{ Variables: SecurityVariables }>()
    .get("/workspaces/:workspaceId/custom-blocks", async (context) => {
      const params = workspaceIdParamsSchema.safeParse({
        workspaceId: context.req.param("workspaceId"),
      });
      if (!params.success) invalid();
      const { actorId } = getRequestContext(context);
      return context.json(await service.list(actorId, params.data.workspaceId), 200);
    })
    .post("/workspaces/:workspaceId/custom-blocks", async (context) => {
      const params = workspaceIdParamsSchema.safeParse({
        workspaceId: context.req.param("workspaceId"),
      });
      if (!params.success) invalid();
      const body = createCustomBlockInputSchema.safeParse(await json(context.req.raw));
      if (!body.success) invalid();
      const { actorId } = getRequestContext(context);
      return context.json(await service.create(actorId, params.data.workspaceId, body.data), 201);
    })
    .put("/custom-blocks/:id/draft", async (context) => {
      const params = customBlockIdParamsSchema.safeParse({ id: context.req.param("id") });
      const body = updateCustomBlockDraftInputSchema.safeParse(await json(context.req.raw));
      if (!params.success || !body.success) invalid();
      const { actorId } = getRequestContext(context);
      return context.json(await service.updateDraft(actorId, params.data.id, body.data), 200);
    })
    .post("/custom-blocks/:id/publish", async (context) => {
      const params = customBlockIdParamsSchema.safeParse({ id: context.req.param("id") });
      const body = publishCustomBlockInputSchema.safeParse(await json(context.req.raw));
      if (!params.success || !body.success) invalid();
      const { actorId } = getRequestContext(context);
      return context.json(await service.publish(actorId, params.data.id, body.data), 200);
    })
    .delete("/custom-blocks/:id", async (context) => {
      const params = customBlockIdParamsSchema.safeParse({ id: context.req.param("id") });
      if (!params.success) invalid();
      const { actorId } = getRequestContext(context);
      await service.removeDraft(actorId, params.data.id);
      return context.json({ ok: true }, 200);
    });
}
