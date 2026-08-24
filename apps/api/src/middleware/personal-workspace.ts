import type { Auth } from "@glyphquire/auth";
import type { MiddlewareHandler } from "hono";
import type { PersonalWorkspaceProvisioner } from "../modules/workspaces/WorkspaceService.js";

export function createPersonalWorkspaceMiddleware(
  auth: Auth,
  workspaceService: PersonalWorkspaceProvisioner,
): MiddlewareHandler {
  return async (context, next) => {
    try {
      const session = await auth.api.getSession({ headers: context.req.raw.headers });
      if (session?.user.id) {
        await workspaceService.ensurePersonalWorkspace(session.user.id);
      }
    } catch {
      return context.json(
        {
          code: "SERVICE_UNAVAILABLE",
          message: "Account setup is temporarily unavailable",
        },
        503,
      );
    }

    await next();
  };
}
