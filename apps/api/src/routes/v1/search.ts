import { noteIdParamsSchema, searchQuerySchema, workspaceIdParamsSchema } from "@glyphquire/api-contract";
import { Hono } from "hono";
import { z } from "zod";
import { PublicApiError } from "../../middleware/error-handler.js";
import { getRequestContext } from "../../middleware/request-context.js";
import type { SecurityVariables } from "../../middleware/security.js";
import type { SearchService } from "../../modules/search/SearchService.js";

const searchRebuildParamsSchema = workspaceIdParamsSchema.merge(
  z.object({ noteId: noteIdParamsSchema.shape.noteId }),
);

function invalidRequest(): never {
  throw new PublicApiError("SEARCH_UNAVAILABLE", 400);
}

export function createSearchRoutes(searchService: SearchService) {
  return new Hono<{ Variables: SecurityVariables }>()
    .get("/search", async (context) => {
      const query = searchQuerySchema.safeParse({
        workspaceId: context.req.query("workspaceId"),
        q: context.req.query("q"),
        cursor: context.req.query("cursor"),
        pageSize: context.req.query("pageSize"),
      });
      if (!query.success) invalidRequest();

      const { actorId } = getRequestContext(context);
      const result = await searchService.search(actorId, query.data);
      return context.json(result, 200);
    })
    .post("/workspaces/:workspaceId/notes/:noteId/search-rebuild", async (context) => {
      const params = searchRebuildParamsSchema.safeParse({
        workspaceId: context.req.param("workspaceId"),
        noteId: context.req.param("noteId"),
      });
      if (!params.success) invalidRequest();

      const { actorId } = getRequestContext(context);
      const result = await searchService.rebuildNote(actorId, {
        workspaceId: params.data.workspaceId,
        noteId: params.data.noteId,
      });
      return context.json(result, 202);
    });
}
