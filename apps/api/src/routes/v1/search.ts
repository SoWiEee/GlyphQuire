import { searchQuerySchema } from "@glyphquire/api-contract";
import { jobPayloadSchemas } from "@glyphquire/api-contract/jobs";
import { normalizeSearchText } from "@glyphquire/search";
import { Hono, type MiddlewareHandler } from "hono";
import { PublicApiError } from "../../middleware/error-handler.js";
import { getRequestContext } from "../../middleware/request-context.js";
import type { SecurityVariables } from "../../middleware/security.js";
import type { OperatorAuthorizer } from "../../modules/search/OperatorAuthorizer.js";
import type { SearchService } from "../../modules/search/SearchService.js";

const SEARCH_QUERY_PARAMETERS = new Set(["workspaceId", "q", "cursor", "pageSize", "ranking"]);

function invalidRequest(): never {
  throw new PublicApiError("SEARCH_UNAVAILABLE", 400);
}

function operatorOnly(
  operatorAuthorizer: OperatorAuthorizer,
): MiddlewareHandler<{ Variables: SecurityVariables }> {
  return async (context, next) => {
    operatorAuthorizer.authorize(getRequestContext(context).actorId);
    await next();
  };
}

export function createSearchRoutes(
  searchService: SearchService,
  operatorAuthorizer: OperatorAuthorizer,
) {
  return new Hono<{ Variables: SecurityVariables }>()
    .get("/search", async (context) => {
      const searchParams = new URL(context.req.url).searchParams;
      if (
        [...searchParams.keys()].some((key) => !SEARCH_QUERY_PARAMETERS.has(key)) ||
        [...SEARCH_QUERY_PARAMETERS].some((key) => searchParams.getAll(key).length > 1)
      ) {
        invalidRequest();
      }
      const query = searchQuerySchema.safeParse({
        workspaceId: context.req.query("workspaceId"),
        q: context.req.query("q"),
        cursor: context.req.query("cursor"),
        pageSize: context.req.query("pageSize"),
        ranking: context.req.query("ranking"),
      });
      if (!query.success || normalizeSearchText(query.data.q).length === 0) invalidRequest();

      const { actorId } = getRequestContext(context);
      const result = await searchService.search(actorId, query.data);
      return context.json(result, 200);
    })
    .use("/workspaces/:workspaceId/notes/:noteId/search-rebuild", operatorOnly(operatorAuthorizer))
    .post("/workspaces/:workspaceId/notes/:noteId/search-rebuild", async (context) => {
      const searchParams = new URL(context.req.url).searchParams;
      if (
        [...searchParams.keys()].some((key) => key !== "cursor") ||
        searchParams.getAll("cursor").length > 1
      ) {
        invalidRequest();
      }
      const payload = jobPayloadSchemas["search.rebuild"].safeParse({
        workspaceId: context.req.param("workspaceId"),
        scope: "note",
        noteId: context.req.param("noteId"),
        batchSize: 1,
        cursor: context.req.query("cursor"),
      });
      if (!payload.success || payload.data.scope !== "note") invalidRequest();

      const { actorId } = getRequestContext(context);
      const result = await searchService.rebuildNote(actorId, payload.data);
      return context.json(result, 202);
    });
}
