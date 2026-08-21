import { Hono } from "hono";
import { createDb, type Database } from "@glyphquire/database";
import { healthRoutes } from "./routes/health.js";
import { createAuthRoutes } from "./routes/auth.js";
import { createCorsMiddleware } from "./middleware/cors.js";
import { errorHandler } from "./middleware/error-handler.js";
import { createPersonalWorkspaceMiddleware } from "./middleware/personal-workspace.js";
import {
  WorkspaceService,
  type PersonalWorkspaceProvisioner,
} from "./modules/workspaces/WorkspaceService.js";
import type { Env } from "./env.js";

export interface AppDependencies {
  db?: Database;
  workspaceService?: PersonalWorkspaceProvisioner;
}

export function createApp(env: Env, dependencies: AppDependencies = {}) {
  const db = dependencies.db ?? createDb(env.DATABASE_URL);
  const workspaceService = dependencies.workspaceService ?? new WorkspaceService(db);
  const { auth, routes: authRoutes } = createAuthRoutes(db, {
    baseUrl: env.BETTER_AUTH_URL,
    secret: env.BETTER_AUTH_SECRET,
    workspaceService,
  });

  const app = new Hono()
    .use("*", createCorsMiddleware(env.CORS_ORIGIN))
    .use("/api/v1/*", createPersonalWorkspaceMiddleware(auth, workspaceService))
    .onError(errorHandler)
    .route("/api", healthRoutes)
    .route("/api", authRoutes);

  return app;
}

export type AppType = ReturnType<typeof createApp>;
