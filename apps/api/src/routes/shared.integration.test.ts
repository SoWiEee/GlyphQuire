import { randomBytes, randomUUID } from "node:crypto";
import type { SharedNoteResponse } from "@glyphquire/api-contract";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import {
  createErrorHandler,
  PublicApiError,
  type SecurityLogEntry,
} from "../middleware/error-handler.js";
import type { RateLimitDecision } from "../middleware/rate-limit.js";
import {
  createClientIpMiddleware,
  createSecurityHeadersMiddleware,
  createTrustedProxyPolicy,
  type SecurityVariables,
} from "../middleware/security.js";
import type { SharedNoteResolver } from "../modules/share-links/ShareLinkService.js";
import { createSharedRoutes } from "./shared.js";

const baseUrl = "http://localhost:3000";

class FakeResolver implements SharedNoteResolver {
  readonly tokens: string[] = [];
  result: SharedNoteResponse = {
    noteId: randomUUID(),
    title: "Public projection",
    contentMarkdown: "# Read only",
    schemaVersion: 1,
    updatedAt: "2026-08-29T00:00:00.000Z",
  };
  failure: Error | undefined;

  async resolve(token: string): Promise<SharedNoteResponse> {
    this.tokens.push(token);
    if (this.failure) throw this.failure;
    return this.result;
  }
}

class CaptureRateLimit {
  readonly keys: string[] = [];
  decision: RateLimitDecision = {
    allowed: true,
    limit: 120,
    remaining: 119,
    resetAt: Date.now() + 60_000,
    retryAfterSeconds: 1,
  };
  failure: Error | undefined;

  async consume(key: string, _limit: number, _windowMs: number): Promise<RateLimitDecision> {
    this.keys.push(key);
    if (this.failure) throw this.failure;
    return this.decision;
  }
}

function buildApp(options: {
  resolver: SharedNoteResolver;
  rateLimit?: CaptureRateLimit;
  logs?: SecurityLogEntry[];
  directPeer?: string;
  authCalls?: { count: number };
}) {
  const rateLimit = options.rateLimit ?? new CaptureRateLimit();
  const logs = options.logs ?? [];
  const authCalls = options.authCalls ?? { count: 0 };
  const trusted = createTrustedProxyPolicy("", "x-forwarded-for");
  const app = new Hono<{ Variables: SecurityVariables }>()
    .use("*", createSecurityHeadersMiddleware())
    .use(
      "/api/v1/*",
      createClientIpMiddleware(trusted, () => options.directPeer ?? "203.0.113.10"),
    )
    .onError(
      createErrorHandler({
        error(entry) {
          logs.push(entry);
        },
      }),
    )
    // The anonymous route is deliberately registered before the generic
    // authenticated v1 middleware, matching the Task 8 integration seam.
    .route(
      "/api/v1",
      createSharedRoutes(options.resolver, {
        rateLimit,
        keySecret: "public-share-rate-limit-secret",
      }),
    )
    .use("/api/v1/*", async (_context, next) => {
      authCalls.count += 1;
      await next();
    });
  return { app, rateLimit, logs, authCalls };
}

describe("anonymous shared-note route", () => {
  it("serves only the bounded read-only projection without invoking authentication", async () => {
    const resolver = new FakeResolver();
    const token = randomBytes(32).toString("base64url");
    const { app, authCalls } = buildApp({ resolver });

    const response = await app.request(`${baseUrl}/api/v1/shared/${token}`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(resolver.result);
    expect(resolver.tokens).toEqual([token]);
    expect(authCalls.count).toBe(0);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("x-frame-options")).toBe("DENY");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("x-request-id")).toMatch(/^[0-9a-f-]{36}$/u);
  });

  it("rejects malformed, sequential, noncanonical, and oversized tokens with one stable 404", async () => {
    const resolver = new FakeResolver();
    const { app } = buildApp({ resolver });
    const candidates = [
      "",
      randomUUID(),
      "a".repeat(42),
      "a".repeat(44),
      "a".repeat(257),
      `${"a".repeat(42)}!`,
      "a/b",
    ];

    const results = await Promise.all(
      candidates.map(async (token) => {
        const response = await app.request(`${baseUrl}/api/v1/shared/${token}`);
        const body = (await response.json()) as {
          error: { code: string; message: string; requestId: string };
        };
        return {
          status: response.status,
          code: body.error.code,
          message: body.error.message,
          cacheControl: response.headers.get("cache-control"),
        };
      }),
    );

    expect(results).toEqual(
      candidates.map(() => ({
        status: 404,
        code: "SHARE_NOT_FOUND",
        message: "Share link not found",
        cacheControl: "no-store",
      })),
    );
    expect(resolver.tokens).toHaveLength(0);
  });

  it("does not expose the plaintext token through structured error logs", async () => {
    const resolver = new FakeResolver();
    resolver.failure = new PublicApiError("SHARE_NOT_FOUND", 404);
    const logs: SecurityLogEntry[] = [];
    const token = randomBytes(32).toString("base64url");
    const { app } = buildApp({ resolver, logs });

    const response = await app.request(`${baseUrl}/api/v1/shared/${token}`);
    expect(response.status).toBe(404);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({
      event: "api_request_failed",
      code: "SHARE_NOT_FOUND",
      status: 404,
      method: "GET",
      routeClass: "api_v1",
    });
    expect(JSON.stringify(logs)).not.toContain(token);
  });

  it("rate-limits by an opaque client-IP key without putting the token or IP in the key", async () => {
    const resolver = new FakeResolver();
    const rateLimit = new CaptureRateLimit();
    rateLimit.decision = {
      allowed: false,
      limit: 120,
      remaining: 0,
      resetAt: Date.now() + 60_000,
      retryAfterSeconds: 37,
    };
    const token = randomBytes(32).toString("base64url");
    const clientIp = "198.51.100.77";
    const { app } = buildApp({ resolver, rateLimit, directPeer: clientIp });

    const response = await app.request(`${baseUrl}/api/v1/shared/${token}`);
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("37");
    expect(await response.json()).toMatchObject({ error: { code: "RATE_LIMITED" } });
    expect(rateLimit.keys).toHaveLength(1);
    expect(rateLimit.keys[0]).toMatch(/^share-public:[0-9a-f]{64}$/u);
    expect(rateLimit.keys[0]).not.toContain(clientIp);
    expect(rateLimit.keys[0]).not.toContain(token);
    expect(resolver.tokens).toHaveLength(0);
  });

  it("fails closed when the public limiter is unavailable", async () => {
    const resolver = new FakeResolver();
    const rateLimit = new CaptureRateLimit();
    rateLimit.failure = new Error("provider details must be scrubbed");
    const token = randomBytes(32).toString("base64url");
    const { app, logs } = buildApp({ resolver, rateLimit });

    const response = await app.request(`${baseUrl}/api/v1/shared/${token}`);
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: { code: "SERVICE_UNAVAILABLE" } });
    expect(JSON.stringify(logs)).not.toContain("provider details");
    expect(resolver.tokens).toHaveLength(0);
  });

  it("exposes no mutation-capable route for a share token", async () => {
    const resolver = new FakeResolver();
    const authCalls = { count: 0 };
    const token = randomBytes(32).toString("base64url");
    const { app } = buildApp({ resolver, authCalls });

    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      const response = await app.request(`${baseUrl}/api/v1/shared/${token}`, { method });
      expect(response.status).toBe(404);
      expect(await response.json()).toMatchObject({ error: { code: "SHARE_NOT_FOUND" } });
    }
    expect(resolver.tokens).toHaveLength(0);
    expect(authCalls.count).toBe(0);
  });
});
