import { Hono } from "hono";
import { createDb } from "@glyphquire/database";
import { createAuth } from "@glyphquire/auth";
import { healthRoutes } from "./routes/health.js";
import { createAuthRoutes } from "./routes/auth.js";
import { createCorsMiddleware } from "./middleware/cors.js";
import { errorHandler } from "./middleware/error-handler.js";
import type { Env } from "./env.js";

export function createApp(env: Env) {
  const db = createDb(env.DATABASE_URL);
  const auth = createAuth(db, {
    baseUrl: env.BETTER_AUTH_URL,
    secret: env.BETTER_AUTH_SECRET,
  });

  const app = new Hono()
    .use("*", createCorsMiddleware(env.CORS_ORIGIN))
    .onError(errorHandler)
    .route("/api", healthRoutes)
    .route("/api", createAuthRoutes(auth));

  return app;
}

export type AppType = ReturnType<typeof createApp>;
