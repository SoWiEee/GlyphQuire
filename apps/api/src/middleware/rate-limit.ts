import { createHmac } from "node:crypto";
import type { MiddlewareHandler } from "hono";
import { PublicApiError } from "./error-handler.js";
import type { SecurityVariables } from "./security.js";

export type Clock = () => number;

export interface RateLimitDecision {
  allowed: boolean;
  limit: number;
  remaining: number;
  resetAt: number;
  retryAfterSeconds: number;
}

export interface RateLimitPort {
  readonly distributed: boolean;
  initialize?(): Promise<void>;
  consume(key: string, limit: number, windowMs: number): Promise<RateLimitDecision>;
}

interface InMemoryBucket {
  count: number;
  startedAt: number;
}

export class InMemoryRateLimitAdapter implements RateLimitPort {
  readonly distributed = false;
  readonly #buckets = new Map<string, InMemoryBucket>();
  readonly #clock: Clock;

  constructor(options: { clock?: Clock } = {}) {
    this.#clock = options.clock ?? Date.now;
  }

  async consume(key: string, limit: number, windowMs: number): Promise<RateLimitDecision> {
    assertRateLimitArguments(key, limit, windowMs);
    const now = this.#clock();
    const existing = this.#buckets.get(key);
    const bucket =
      !existing || now >= existing.startedAt + windowMs
        ? { count: 1, startedAt: now }
        : { count: existing.count + 1, startedAt: existing.startedAt };
    this.#buckets.set(key, bucket);
    return decisionFor(bucket.count, bucket.startedAt, now, limit, windowMs);
  }
}

export function assertRateLimitArguments(key: string, limit: number, windowMs: number) {
  if (key.length === 0 || Buffer.byteLength(key) > 255) {
    throw new Error("rate-limit key must contain between 1 and 255 UTF-8 bytes");
  }
  if (!Number.isSafeInteger(limit) || limit <= 0) {
    throw new Error("rate-limit limit must be a positive safe integer");
  }
  if (!Number.isSafeInteger(windowMs) || windowMs <= 0) {
    throw new Error("rate-limit window must be a positive safe integer");
  }
}

export function decisionFor(
  count: number,
  startedAt: number,
  now: number,
  limit: number,
  windowMs: number,
): RateLimitDecision {
  const resetAt = startedAt + windowMs;
  return {
    allowed: count <= limit,
    limit,
    remaining: Math.max(0, limit - count),
    resetAt,
    retryAfterSeconds: Math.max(1, Math.ceil((resetAt - now) / 1000)),
  };
}

function opaqueKey(secret: string, material: string) {
  const digest = createHmac("sha256", secret).update(material).digest("hex");
  return `rl:${digest}`;
}

interface NoteRateLimitInput {
  kind: "autosave" | "mutation";
  actorId: string;
  workspaceId: string;
  clientIp: string;
  keySecret: string;
}

export async function enforceNoteRateLimits(
  port: RateLimitPort,
  input: NoteRateLimitInput,
): Promise<RateLimitDecision> {
  const policies =
    input.kind === "autosave"
      ? [
          { material: `note:autosave:user:${input.actorId}`, limit: 60 },
          { material: `note:autosave:workspace:${input.workspaceId}`, limit: 300 },
          { material: `note:autosave:ip:${input.clientIp}`, limit: 600 },
        ]
      : [{ material: `note:mutation:user:${input.actorId}`, limit: 30 }];

  let decisions: RateLimitDecision[];
  try {
    decisions = await Promise.all(
      policies.map(({ material, limit }) =>
        port.consume(opaqueKey(input.keySecret, material), limit, 60_000),
      ),
    );
  } catch {
    throw new PublicApiError("SERVICE_UNAVAILABLE", 503);
  }

  const exhausted = decisions.filter((decision) => !decision.allowed);
  if (exhausted.length > 0) {
    return exhausted.reduce((strictest, decision) =>
      decision.retryAfterSeconds > strictest.retryAfterSeconds ? decision : strictest,
    );
  }
  return decisions.reduce((strictest, decision) =>
    decision.remaining < strictest.remaining ? decision : strictest,
  );
}

function normalizedAccount(requestBody: unknown) {
  if (!requestBody || typeof requestBody !== "object") return "<invalid>";
  const email = (requestBody as { email?: unknown }).email;
  return typeof email === "string" && email.trim() !== ""
    ? email.trim().toLowerCase()
    : "<invalid>";
}

async function readAccount(request: Request) {
  try {
    return normalizedAccount(await request.clone().json());
  } catch {
    return "<invalid>";
  }
}

function rateLimitedResponse(
  context: Parameters<MiddlewareHandler<{ Variables: SecurityVariables }>>[0],
  decision: RateLimitDecision,
) {
  const requestId = context.get("requestId");
  context.header("retry-after", String(decision.retryAfterSeconds));
  context.header("cache-control", "no-store");
  const response = context.json(
    {
      error: {
        code: "RATE_LIMITED" as const,
        message: "Too many requests",
        requestId,
      },
    },
    429,
  );
  context.res = response;
  return response;
}

export function createAuthRateLimitMiddleware(options: {
  rateLimit: RateLimitPort;
  keySecret: string;
}): MiddlewareHandler<{ Variables: SecurityVariables }> {
  async function consume(material: string, limit: number, windowMs: number) {
    try {
      return await options.rateLimit.consume(
        opaqueKey(options.keySecret, material),
        limit,
        windowMs,
      );
    } catch {
      throw new PublicApiError("SERVICE_UNAVAILABLE", 503);
    }
  }

  return async (context, next) => {
    if (context.req.method !== "POST") {
      await next();
      return;
    }

    const path = context.req.path;
    const clientIp = context.get("clientIp") || "unknown";
    if (path === "/api/auth/sign-up/email") {
      const decision = await consume(`auth:registration:${clientIp}`, 5, 3_600_000);
      if (!decision.allowed) return rateLimitedResponse(context, decision);
      await next();
      return;
    }

    if (path === "/api/auth/request-password-reset") {
      const account = await readAccount(context.req.raw);
      const decision = await consume(`auth:password-reset:${clientIp}:${account}`, 5, 3_600_000);
      if (!decision.allowed) return rateLimitedResponse(context, decision);
      await next();
      return;
    }

    if (path !== "/api/auth/sign-in/email") {
      await next();
      return;
    }

    const account = await readAccount(context.req.raw);
    const allAttempts = await consume(`auth:login:${clientIp}`, 30, 900_000);
    if (!allAttempts.allowed) return rateLimitedResponse(context, allAttempts);

    await next();
    if (context.res.status >= 400) {
      const failures = await consume(`auth:failed-login:${clientIp}:${account}`, 10, 900_000);
      if (!failures.allowed) return rateLimitedResponse(context, failures);
    }
  };
}
