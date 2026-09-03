import { meResultSchema } from "@glyphquire/api-contract";
import { Hono } from "hono";
import { PublicApiError } from "../../middleware/error-handler.js";
import { getRequestContext } from "../../middleware/request-context.js";
import type { SecurityVariables } from "../../middleware/security.js";
import type { PersonalWorkspaceProvisioner } from "../../modules/workspaces/WorkspaceService.js";

function requireNoQuery(request: Request): void {
  if ([...new URL(request.url).searchParams.keys()].length > 0) {
    throw new PublicApiError("DOCUMENT_INVALID", 400);
  }
}

export function createMeRoutes(workspaceService: PersonalWorkspaceProvisioner) {
  return new Hono<{ Variables: SecurityVariables }>().get("/me", async (context) => {
    requireNoQuery(context.req.raw);
    const actorId = getRequestContext(context).actorId;
    const workspace = await workspaceService.ensurePersonalWorkspace(actorId);
    const result = meResultSchema.parse({
      userId: actorId,
      personalWorkspaceId: workspace.id,
    });
    return context.json(result, 200);
  });
}
