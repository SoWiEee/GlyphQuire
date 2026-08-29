import { createHmac } from "node:crypto";
import { sharedNoteResponseSchema } from "@glyphquire/api-contract";
import { Hono, type MiddlewareHandler } from "hono";
import { PublicApiError } from "../middleware/error-handler.js";
import type { RateLimitDecision } from "../middleware/rate-limit.js";
import type { SecurityVariables } from "../middleware/security.js";
import type { SharedNoteResolver } from "../modules/share-links/ShareLinkService.js";

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const PUBLIC_SHARE_LIMIT = 120;
const PUBLIC_SHARE_WINDOW_MS = 60_000;
const MAX_RATE_KEY_SECRET_BYTES = 4_096;

export interface PublicShareRateLimitPort {
  consume(key: string, limit: number, windowMs: number): Promise<RateLimitDecision>;
}

export interface SharedRouteOptions {
  rateLimit: PublicShareRateLimitPort;
  keySecret: string;
}

function notFound(): never {
  throw new PublicApiError("SHARE_NOT_FOUND", 404);
}

function canonicalToken(token: string): boolean {
  if (!TOKEN_PATTERN.test(token)) return false;
  const bytes = Buffer.from(token, "base64url");
  return bytes.byteLength === 32 && bytes.toString("base64url") === token;
}

function opaqueClientKey(secret: string, clientIp: string): string {
  const digest = createHmac("sha256", secret)
    .update("glyphquire:share-public-rate-limit:v1\0", "utf8")
    .update(clientIp, "utf8")
    .digest("hex");
  return `share-public:${digest}`;
}

function limitedResponse(
  context: Parameters<MiddlewareHandler<{ Variables: SecurityVariables }>>[0],
  decision: RateLimitDecision,
) {
  context.header("retry-after", String(decision.retryAfterSeconds));
  context.header("cache-control", "no-store");
  return context.json(
    {
      error: {
        code: "RATE_LIMITED" as const,
        message: "Too many requests",
        requestId: context.get("requestId"),
      },
    },
    429,
  );
}

function publicRateLimit(options: SharedRouteOptions): MiddlewareHandler<{
  Variables: SecurityVariables;
}> {
  return async (context, next) => {
    let decision: RateLimitDecision;
    try {
      decision = await options.rateLimit.consume(
        opaqueClientKey(options.keySecret, context.get("clientIp") || "unknown"),
        PUBLIC_SHARE_LIMIT,
        PUBLIC_SHARE_WINDOW_MS,
      );
    } catch {
      throw new PublicApiError("SERVICE_UNAVAILABLE", 503);
    }
    if (!decision.allowed) {
      context.res = limitedResponse(context, decision);
      return;
    }
    await next();
  };
}

export function createSharedRoutes(resolver: SharedNoteResolver, options: SharedRouteOptions) {
  if (
    options.keySecret.length === 0 ||
    Buffer.byteLength(options.keySecret, "utf8") > MAX_RATE_KEY_SECRET_BYTES
  ) {
    throw new Error("Invalid public share rate-limit key secret");
  }

  return new Hono<{ Variables: SecurityVariables }>()
    .use("/shared/*", publicRateLimit(options))
    .get("/shared/:token", async (context) => {
      const token = context.req.param("token");
      if (!canonicalToken(token)) notFound();
      const result = sharedNoteResponseSchema.parse(await resolver.resolve(token));
      context.header("cache-control", "no-store");
      return context.json(result, 200);
    })
    .all("/shared/:token", () => notFound())
    .all("/shared/*", () => notFound());
}
