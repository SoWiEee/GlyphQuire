import { Hono } from "hono";

export const healthRoutes = new Hono().get("/health", (c) => {
  return c.json({
    status: "ok" as const,
    timestamp: new Date().toISOString(),
  });
});
