import type { MiddlewareHandler } from "hono";

const allowedMethods = "GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS";
const allowedHeaders = "Content-Type, Authorization, X-Request-ID";

export function createCorsMiddleware(webOrigin: URL): MiddlewareHandler {
  return async (context, next) => {
    // HTTPS is the production configuration. The web application and `/api`
    // share one origin there, so credentialed CORS is deliberately absent.
    if (webOrigin.protocol === "https:") {
      await next();
      return;
    }

    const requestOrigin = context.req.header("origin");
    if (requestOrigin !== webOrigin.origin) {
      await next();
      return;
    }

    context.header("vary", "Origin");
    context.header("access-control-allow-origin", webOrigin.origin);
    context.header("access-control-allow-credentials", "true");
    if (context.req.method === "OPTIONS") {
      context.header("access-control-allow-methods", allowedMethods);
      context.header("access-control-allow-headers", allowedHeaders);
      context.header("access-control-max-age", "600");
      context.status(204);
      return context.body(null);
    }

    await next();
  };
}
