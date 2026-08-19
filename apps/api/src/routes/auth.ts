import { Hono } from "hono";
import type { Auth } from "@glyphquire/auth";

export function createAuthRoutes(auth: Auth) {
  return new Hono().all("/auth/*", (c) => {
    return auth.handler(c.req.raw);
  });
}
