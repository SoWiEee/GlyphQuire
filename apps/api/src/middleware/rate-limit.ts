import { createHmac, randomUUID } from "node:crypto";
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

export interface RateLimitReservationToken {
  readonly reservationId: string;
  readonly key: string;
  readonly windowStartedAt: number;
}

export type RateLimitReservation =
  | {
      readonly acquired: true;
      readonly decision: RateLimitDecision;
      readonly token: RateLimitReservationToken;
    }
  | {
      readonly acquired: false;
      readonly decision: RateLimitDecision;
      readonly token: null;
    };

export interface RateLimitPort {
  readonly distributed: boolean;
  initialize?(): Promise<void>;
  consume(key: string, limit: number, windowMs: number): Promise<RateLimitDecision>;
  reserve(key: string, limit: number, windowMs: number): Promise<RateLimitReservation>;
  release(reservation: RateLimitReservationToken): Promise<void>;
}

interface InMemoryBucket {
  count: number;
  startedAt: number;
}

interface InMemoryReservation {
  key: string;
  windowStartedAt: number;
  released: boolean;
}

export class InMemoryRateLimitAdapter implements RateLimitPort {
  readonly distributed = false;
  readonly #buckets = new Map<string, InMemoryBucket>();
  readonly #reservations = new Map<string, InMemoryReservation>();
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

  async reserve(key: string, limit: number, windowMs: number): Promise<RateLimitReservation> {
    assertRateLimitArguments(key, limit, windowMs);
    const now = this.#clock();
    assertClockValue(now);
    const existing = this.#buckets.get(key);
    if (!existing || now >= existing.startedAt + windowMs) {
      const bucket = { count: 1, startedAt: now };
      this.#buckets.set(key, bucket);
      return this.#acquiredReservation(key, bucket.count, bucket.startedAt, now, limit, windowMs);
    }
    if (existing.count >= limit) {
      return deniedReservation(existing.count, existing.startedAt, now, limit, windowMs);
    }

    const bucket = { count: existing.count + 1, startedAt: existing.startedAt };
    this.#buckets.set(key, bucket);
    return this.#acquiredReservation(key, bucket.count, bucket.startedAt, now, limit, windowMs);
  }

  async release(reservation: RateLimitReservationToken): Promise<void> {
    assertReservationToken(reservation);
    const stored = this.#reservations.get(reservation.reservationId);
    if (
      !stored ||
      stored.released ||
      stored.key !== reservation.key ||
      stored.windowStartedAt !== reservation.windowStartedAt
    ) {
      return;
    }
    stored.released = true;

    const existing = this.#buckets.get(reservation.key);
    if (!existing || existing.startedAt !== reservation.windowStartedAt || existing.count === 0) {
      return;
    }
    this.#buckets.set(reservation.key, { ...existing, count: existing.count - 1 });
  }

  #acquiredReservation(
    key: string,
    count: number,
    startedAt: number,
    now: number,
    limit: number,
    windowMs: number,
  ): RateLimitReservation {
    const reservationId = randomUUID();
    this.#reservations.set(reservationId, {
      key,
      windowStartedAt: startedAt,
      released: false,
    });
    return acquiredReservation(reservationId, key, count, startedAt, now, limit, windowMs);
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

export function assertClockValue(now: number) {
  if (!Number.isSafeInteger(now) || now < 0) {
    throw new Error("rate-limit clock must return a nonnegative safe integer");
  }
}

export function assertReservationToken(reservation: RateLimitReservationToken) {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      reservation.reservationId,
    ) ||
    reservation.key.length === 0 ||
    Buffer.byteLength(reservation.key) > 255 ||
    !Number.isSafeInteger(reservation.windowStartedAt) ||
    reservation.windowStartedAt < 0
  ) {
    throw new Error("invalid rate-limit reservation token");
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

function acquiredReservation(
  reservationId: string,
  key: string,
  count: number,
  startedAt: number,
  now: number,
  limit: number,
  windowMs: number,
): RateLimitReservation {
  return {
    acquired: true,
    decision: decisionFor(count, startedAt, now, limit, windowMs),
    token: { reservationId, key, windowStartedAt: startedAt },
  };
}

function deniedReservation(
  count: number,
  startedAt: number,
  now: number,
  limit: number,
  windowMs: number,
): RateLimitReservation {
  return {
    acquired: false,
    decision: {
      ...decisionFor(count, startedAt, now, limit, windowMs),
      allowed: false,
      remaining: 0,
    },
    token: null,
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

  async function reserve(material: string, limit: number, windowMs: number) {
    try {
      return await options.rateLimit.reserve(
        opaqueKey(options.keySecret, material),
        limit,
        windowMs,
      );
    } catch {
      throw new PublicApiError("SERVICE_UNAVAILABLE", 503);
    }
  }

  async function release(reservation: RateLimitReservationToken) {
    try {
      await options.rateLimit.release(reservation);
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

    const failureReservation = await reserve(
      `auth:failed-login:${clientIp}:${account}`,
      10,
      900_000,
    );
    if (!failureReservation.acquired) {
      return rateLimitedResponse(context, failureReservation.decision);
    }

    await next();
    if (context.res.status >= 200 && context.res.status < 300) {
      await release(failureReservation.token);
    }
  };
}
