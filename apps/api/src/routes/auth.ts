import { Hono } from "hono";
import { createAuth } from "@glyphquire/auth";
import type { Database } from "@glyphquire/database";
import type { PersonalWorkspaceProvisioner } from "../modules/workspaces/WorkspaceService.js";

interface AuthRouteOptions {
  baseUrl: string;
  secret: string;
  workspaceService: PersonalWorkspaceProvisioner;
}

export function createAuthRoutes(db: Database, options: AuthRouteOptions) {
  const auth = createAuth(db, {
    baseUrl: options.baseUrl,
    secret: options.secret,
    onUserCreated: async (userId) => {
      await options.workspaceService.ensurePersonalWorkspace(userId);
    },
  });
  const routes = new Hono().all("/auth/*", (c) => {
    return auth.handler(c.req.raw);
  });

  return { auth, routes };
}
