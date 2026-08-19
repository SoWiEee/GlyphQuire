import { cors } from "hono/cors";

export function createCorsMiddleware(origin: string) {
  return cors({
    origin,
    allowMethods: ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization"],
    credentials: true,
  });
}
