import { createHash, createHmac, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAuth } from "@glyphquire/auth";
import {
  createDb,
  rateLimitBuckets,
  readRepositoryMigrations,
  runDatabaseMigrations,
  verifyMigrationBaseline,
  type Database,
} from "@glyphquire/database";
import { createApp, type AppSecurityLogger } from "../app.js";
import { parseEnv } from "../env.js";
import { createCorsMiddleware } from "./cors.js";
import {
  PublicApiError,
  createErrorHandler,
  type SecurityLogEntry,
  type SecurityLogger,
} from "./error-handler.js";
import {
  InMemoryRateLimitAdapter,
  createAuthRateLimitMiddleware,
  enforceNoteRateLimits,
  type Clock,
} from "./rate-limit.js";
import { PostgresRateLimitAdapter } from "./PostgresRateLimitAdapter.js";
import {
  createRequestContextMiddleware,
  getRequestContext,
  type SessionReader,
} from "./request-context.js";
import {
  MAX_JSON_BODY_BYTES,
  createClientIpMiddleware,
  createRequestSecurityMiddleware,
  createSecurityHeadersMiddleware,
  createTrustedProxyPolicy,
  deriveClientIp,
  type SecurityVariables,
} from "./security.js";

const webOrigin = new URL("http://localhost:5173");

function noOpWorkspaceService() {
  return {
    async ensurePersonalWorkspace() {
      return {
        id: "00000000-0000-4000-8000-000000000005",
        name: "Personal" as const,
        role: "owner" as const,
      };
    },
  };
}

function jsonRequest(path: string, init: Omit<RequestInit, "body"> & { body?: string } = {}) {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  headers.set("origin", webOrigin.origin);
  return new Request(`http://localhost:3000${path}`, { ...init, headers });
}

function exactJsonBody(totalBytes: number, character = "a") {
  const prefix = '{"content":"';
  const suffix = '"}';
  const fixedBytes = Buffer.byteLength(prefix + suffix);
  const characterBytes = Buffer.byteLength(character);
  const repeatedBytes = totalBytes - fixedBytes;
  if (repeatedBytes < 0) {
    throw new Error("requested JSON size cannot be represented by the selected character");
  }
  const repetitions = Math.floor(repeatedBytes / characterBytes);
  const remainder = repeatedBytes - repetitions * characterBytes;
  const body = `${prefix}${character.repeat(repetitions)}${"a".repeat(remainder)}${suffix}`;
  expect(Buffer.byteLength(body)).toBe(totalBytes);
  return body;
}

function fakeSessionReader(actorId = "server-session-actor"): SessionReader {
  return {
    async getSession() {
      return {
        session: {
          id: "session-id",
          token: "server-session-token",
          userId: actorId,
          expiresAt: new Date("2030-01-01T00:00:00.000Z"),
          createdAt: new Date("2026-08-22T00:00:00.000Z"),
          updatedAt: new Date("2026-08-22T00:00:00.000Z"),
          ipAddress: null,
          userAgent: null,
        },
        user: {
          id: actorId,
          name: "Authenticated User",
          email: "authenticated@example.test",
          emailVerified: true,
          image: null,
          createdAt: new Date("2026-08-22T00:00:00.000Z"),
          updatedAt: new Date("2026-08-22T00:00:00.000Z"),
        },
      };
    },
  };
}

function createProtectedFixture(
  options: {
    sessionReader?: SessionReader;
    logger?: SecurityLogger;
  } = {},
) {
  let writes = 0;
  const app = new Hono<{ Variables: SecurityVariables }>();
  app.use("*", createSecurityHeadersMiddleware());
  app.use("/api/*", createRequestSecurityMiddleware({ webOrigin }));
  app.use(
    "/api/v1/*",
    createRequestContextMiddleware(options.sessionReader ?? fakeSessionReader()),
  );
  app.onError(createErrorHandler(options.logger));
  app.post("/api/v1/write", async (context) => {
    const body = (await context.req.json()) as { actorId?: string; content?: string };
    const requestContext = getRequestContext(context);
    writes += 1;
    return context.json({
      actorId: requestContext.actorId,
      bodyActorId: body.actorId ?? null,
      bodyBytes: Buffer.byteLength(JSON.stringify(body)),
    });
  });
  app.post("/api/v1/error", () => {
    throw new Error("MARKDOWN_SENTINEL cookie=session-secret SELECT * FROM users STACK_SENTINEL");
  });
  return { app, writes: () => writes };
}

describe("authenticated request boundary", () => {
  it.each([
    ["missing", undefined],
    ["null", "null"],
    ["malformed", "://not-an-origin"],
    ["unlisted", "https://evil.example"],
  ])("rejects a %s Origin on unsafe /api/v1 requests", async (_label, origin) => {
    const { app, writes } = createProtectedFixture();
    const request = jsonRequest("/api/v1/write", {
      method: "POST",
      body: JSON.stringify({ content: "safe" }),
    });
    if (origin === undefined) request.headers.delete("origin");
    else request.headers.set("origin", origin);

    const response = await app.request(request);

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: {
        code: "DOCUMENT_INVALID",
        message: "The request is not allowed",
        requestId: expect.any(String),
      },
    });
    expect(writes()).toBe(0);
  });

  it.each(["application/x-www-form-urlencoded", "multipart/form-data", "text/plain"])(
    "rejects unsafe cross-site form media type %s",
    async (contentType) => {
      const { app, writes } = createProtectedFixture();
      const response = await app.request("http://localhost:3000/api/v1/write", {
        method: "POST",
        headers: { "content-type": contentType, origin: webOrigin.origin },
        body: "actorId=forged-user",
      });

      expect(response.status).toBe(415);
      expect((await response.json()) as object).toMatchObject({
        error: { code: "DOCUMENT_INVALID" },
      });
      expect(writes()).toBe(0);
    },
  );

  it("rejects cross-site Fetch Metadata even when an exact Origin is supplied", async () => {
    const { app, writes } = createProtectedFixture();
    const request = jsonRequest("/api/v1/write", {
      method: "POST",
      headers: { "sec-fetch-site": "cross-site" },
      body: JSON.stringify({ content: "safe" }),
    });

    const response = await app.request(request);

    expect(response.status).toBe(403);
    expect(writes()).toBe(0);
  });

  it("uses only the authenticated server session actor", async () => {
    const { app } = createProtectedFixture();
    const response = await app.request(
      jsonRequest("/api/v1/write", {
        method: "POST",
        body: JSON.stringify({ actorId: "forged-body-actor", content: "safe" }),
      }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      actorId: "server-session-actor",
      bodyActorId: "forged-body-actor",
    });
  });

  it("rejects unauthenticated protected requests before the handler", async () => {
    const { app, writes } = createProtectedFixture({
      sessionReader: {
        async getSession() {
          return null;
        },
      },
    });

    const response = await app.request(
      jsonRequest("/api/v1/write", { method: "POST", body: "{}" }),
    );

    expect(response.status).toBe(404);
    expect((await response.json()) as object).toMatchObject({
      error: { code: "NOTE_NOT_FOUND" },
    });
    expect(writes()).toBe(0);
  });

  it("does not expose a mutation through GET", async () => {
    const { app, writes } = createProtectedFixture();

    const response = await app.request("http://localhost:3000/api/v1/write", {
      method: "GET",
    });

    expect(response.status).toBe(404);
    expect(writes()).toBe(0);
  });
});

describe("raw JSON body limit", () => {
  it("accepts exactly 2.25 MiB with Content-Length", async () => {
    const { app, writes } = createProtectedFixture();
    const body = exactJsonBody(MAX_JSON_BODY_BYTES);
    const request = jsonRequest("/api/v1/write", { method: "POST", body });
    request.headers.set("content-length", String(MAX_JSON_BODY_BYTES));

    const response = await app.request(request);

    expect(response.status).toBe(200);
    expect(writes()).toBe(1);
  });

  it("rejects Content-Length at 2.25 MiB + 1 before reading or writing", async () => {
    let pulls = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        controller.enqueue(new Uint8Array([123, 125]));
        controller.close();
      },
    });
    const { app, writes } = createProtectedFixture();
    const request = new Request("http://localhost:3000/api/v1/write", {
      method: "POST",
      headers: {
        "content-length": String(MAX_JSON_BODY_BYTES + 1),
        "content-type": "application/json",
        origin: webOrigin.origin,
      },
      body,
      duplex: "half",
    } as RequestInit & { duplex: "half" });

    const response = await app.request(request);

    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({
      error: {
        code: "DOCUMENT_TOO_LARGE",
        message: "The request body is too large",
        requestId: expect.any(String),
      },
    });
    // A WHATWG stream may pre-pull during Request construction. The handler
    // counter is the reliable assertion that Content-Length short-circuited
    // before parsing or persistence.
    expect(pulls).toBeLessThanOrEqual(1);
    expect(writes()).toBe(0);
  });

  it.each([
    ["chunked", "a", MAX_JSON_BODY_BYTES + 1],
    ["multibyte exact", "界", MAX_JSON_BODY_BYTES],
    ["multibyte too large", "界", MAX_JSON_BODY_BYTES + 1],
  ])("measures %s bodies by raw bytes before JSON parsing", async (_label, character, size) => {
    const source = exactJsonBody(size, character);
    const bytes = new TextEncoder().encode(source);
    let offset = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (offset >= bytes.byteLength) {
          controller.close();
          return;
        }
        const end = Math.min(offset + 65_537, bytes.byteLength);
        controller.enqueue(bytes.slice(offset, end));
        offset = end;
      },
    });
    const { app, writes } = createProtectedFixture();
    const request = new Request("http://localhost:3000/api/v1/write", {
      method: "POST",
      headers: { "content-type": "application/json", origin: webOrigin.origin },
      body,
      duplex: "half",
    } as RequestInit & { duplex: "half" });

    const response = await app.request(request);

    if (size <= MAX_JSON_BODY_BYTES) {
      expect(response.status).toBe(200);
      expect(writes()).toBe(1);
    } else {
      expect(response.status).toBe(413);
      expect((await response.json()) as object).toMatchObject({
        error: { code: "DOCUMENT_TOO_LARGE" },
      });
      expect(writes()).toBe(0);
    }
  });
});

describe("safe responses, logs, and hardening headers", () => {
  it("emits a validated request ID and the fixed security headers", async () => {
    const { app } = createProtectedFixture();
    const request = jsonRequest("/api/v1/write", { method: "POST", body: "{}" });
    request.headers.set("x-request-id", "client-request_123");

    const response = await app.request(request);

    expect(response.headers.get("x-request-id")).toBe("client-request_123");
    expect(response.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(response.headers.get("x-frame-options")).toBe("DENY");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("replaces an invalid request ID", async () => {
    const { app } = createProtectedFixture();
    const request = jsonRequest("/api/v1/write", { method: "POST", body: "{}" });
    request.headers.set("x-request-id", "bad id STACK_SENTINEL");

    const response = await app.request(request);

    expect(response.headers.get("x-request-id")).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it("never returns or logs raw exception, Markdown, cookie, SQL, or stack strings", async () => {
    const entries: SecurityLogEntry[] = [];
    const logger: SecurityLogger = {
      error(entry) {
        entries.push(entry);
      },
    };
    const { app } = createProtectedFixture({ logger });
    const request = jsonRequest("/api/v1/error", {
      method: "POST",
      body: JSON.stringify({ content: "MARKDOWN_SENTINEL" }),
    });
    request.headers.set("cookie", "session=COOKIE_SENTINEL");

    const response = await app.request(request);
    const combined = `${await response.text()} ${JSON.stringify(entries)}`;

    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(combined).not.toContain("MARKDOWN_SENTINEL");
    expect(combined).not.toContain("COOKIE_SENTINEL");
    expect(combined).not.toContain("SELECT * FROM users");
    expect(combined).not.toContain("STACK_SENTINEL");
    expect(entries).toEqual([
      expect.objectContaining({
        event: "api_request_failed",
        code: "SERVICE_UNAVAILABLE",
        requestId: expect.any(String),
        method: "POST",
        path: "/api/v1/error",
        status: 503,
      }),
    ]);
  });

  it("maps only allowlisted public errors", async () => {
    const app = new Hono<{ Variables: SecurityVariables }>();
    app.use("*", createSecurityHeadersMiddleware());
    app.onError(createErrorHandler());
    app.get("/expected", () => {
      throw new PublicApiError("RATE_LIMITED", 429);
    });
    app.get("/unexpected", () => {
      throw Object.assign(new Error("raw failure"), { code: "RAW_SQL_ERROR", status: 418 });
    });

    const expected = await app.request("http://localhost/expected");
    const unexpected = await app.request("http://localhost/unexpected");

    expect((await expected.json()) as object).toMatchObject({
      error: { code: "RATE_LIMITED" },
    });
    expect(unexpected.status).toBe(503);
    expect((await unexpected.json()) as object).toMatchObject({
      error: { code: "SERVICE_UNAVAILABLE" },
    });
  });

  it("keeps the public response stable when the structured logger fails", async () => {
    const { app } = createProtectedFixture({
      logger: {
        error() {
          throw new Error("LOG_SINK_SECRET");
        },
      },
    });

    const response = await app.request(
      jsonRequest("/api/v1/error", { method: "POST", body: "{}" }),
    );
    const body = await response.text();

    expect(response.status).toBe(503);
    expect(response.headers.get("x-request-id")).toMatch(/^[0-9a-f-]{36}$/);
    expect(body).toContain('"code":"SERVICE_UNAVAILABLE"');
    expect(body).not.toContain("LOG_SINK_SECRET");
  });
});

describe("same-origin CORS behavior", () => {
  it("emits no credentialed CORS headers in HTTPS production", async () => {
    const app = new Hono()
      .use("*", createCorsMiddleware(new URL("https://app.example")))
      .get("/api/health", (context) => context.json({ ok: true }));
    const response = await app.request("https://app.example/api/health", {
      headers: { origin: "https://app.example" },
    });

    expect(response.headers.get("access-control-allow-origin")).toBeNull();
    expect(response.headers.get("access-control-allow-credentials")).toBeNull();
  });

  it("permits only the exact configured development origin", async () => {
    const app = new Hono()
      .use("*", createCorsMiddleware(webOrigin))
      .get("/api/health", (c) => c.json({ ok: true }));
    const allowed = await app.request("http://localhost:3000/api/health", {
      headers: { origin: webOrigin.origin },
    });
    const denied = await app.request("http://localhost:3000/api/health", {
      headers: { origin: "http://evil.example" },
    });

    expect(allowed.headers.get("access-control-allow-origin")).toBe(webOrigin.origin);
    expect(allowed.headers.get("access-control-allow-credentials")).toBe("true");
    expect(denied.headers.get("access-control-allow-origin")).toBeNull();
    expect(denied.headers.get("access-control-allow-credentials")).toBeNull();
  });
});

describe("trusted proxy client IP", () => {
  it("ignores forwarding headers from an untrusted direct peer", () => {
    const policy = createTrustedProxyPolicy("10.0.0.0/8", "x-forwarded-for");
    const headers = new Headers({ "x-forwarded-for": "198.51.100.8" });

    expect(deriveClientIp("203.0.113.7", headers, policy)).toBe("203.0.113.7");
  });

  it("walks a trusted forwarding chain from right to left", () => {
    const policy = createTrustedProxyPolicy("10.0.0.0/8, 2001:db8:ffff::/48", "x-forwarded-for");
    const headers = new Headers({
      "x-forwarded-for": "198.51.100.8, 10.20.30.40",
    });

    expect(deriveClientIp("10.1.2.3", headers, policy)).toBe("198.51.100.8");
  });

  it("fails startup on malformed trusted CIDRs or forwarded header names", () => {
    expect(() => createTrustedProxyPolicy("10.0.0.0/99", "x-forwarded-for")).toThrow(
      "TRUSTED_PROXY_CIDRS",
    );
    expect(() => createTrustedProxyPolicy("10.0.0.0/8", "x forwarded for")).toThrow(
      "FORWARDED_IP_HEADER",
    );
  });

  it("stores the derived client IP in request context variables", async () => {
    const policy = createTrustedProxyPolicy("10.0.0.0/8", "x-forwarded-for");
    const app = new Hono<{ Variables: SecurityVariables }>();
    app.use(
      "*",
      createClientIpMiddleware(policy, () => "10.1.2.3"),
    );
    app.get("/", (context) => context.text(context.get("clientIp")));

    const response = await app.request("http://localhost/", {
      headers: { "x-forwarded-for": "198.51.100.8" },
    });

    expect(await response.text()).toBe("198.51.100.8");
  });
});

function mutableClock(initial = Date.parse("2026-08-22T00:00:00.000Z")) {
  let now = initial;
  return {
    clock: (() => now) satisfies Clock,
    advance(milliseconds: number) {
      now += milliseconds;
    },
  };
}

describe("note rate limits", () => {
  it.each([
    [
      "autosave user",
      60,
      (index: number) => ({
        actorId: "actor",
        workspaceId: `w-${index}`,
        clientIp: `192.0.2.${index % 250}`,
      }),
    ],
    [
      "autosave workspace",
      300,
      (index: number) => ({
        actorId: `actor-${index}`,
        workspaceId: "workspace",
        clientIp: `192.0.${Math.floor(index / 250)}.${index % 250}`,
      }),
    ],
    [
      "autosave IP",
      600,
      (index: number) => ({
        actorId: `actor-${index}`,
        workspaceId: `w-${index}`,
        clientIp: "192.0.2.44",
      }),
    ],
  ])("allows the exact %s boundary and rejects N+1", async (_label, limit, identity) => {
    const time = mutableClock();
    const adapter = new InMemoryRateLimitAdapter({ clock: time.clock });
    const secret = "rate-limit-test-secret";

    for (let index = 0; index < limit; index += 1) {
      const decision = await enforceNoteRateLimits(adapter, {
        kind: "autosave",
        ...identity(index),
        keySecret: secret,
      });
      expect(decision.allowed).toBe(true);
    }
    const rejected = await enforceNoteRateLimits(adapter, {
      kind: "autosave",
      ...identity(limit),
      keySecret: secret,
    });

    expect(rejected.allowed).toBe(false);
    expect(rejected.retryAfterSeconds).toBe(60);
  });

  it("limits other note mutations to 30 per user and performs no rejected write", async () => {
    const adapter = new InMemoryRateLimitAdapter();
    let writes = 0;
    for (let index = 0; index < 31; index += 1) {
      const result = await enforceNoteRateLimits(adapter, {
        kind: "mutation",
        actorId: "actor",
        workspaceId: `workspace-${index}`,
        clientIp: `192.0.2.${index}`,
        keySecret: "test-secret",
      });
      if (result.allowed) writes += 1;
      if (index < 30) expect(result.allowed).toBe(true);
      else expect(result.allowed).toBe(false);
    }
    expect(writes).toBe(30);
  });

  it("resets only when the injected clock reaches the next window", async () => {
    const time = mutableClock();
    const adapter = new InMemoryRateLimitAdapter({ clock: time.clock });
    const input = {
      kind: "mutation" as const,
      actorId: "actor",
      workspaceId: "workspace",
      clientIp: "192.0.2.4",
      keySecret: "test-secret",
    };
    for (let index = 0; index < 30; index += 1) {
      expect((await enforceNoteRateLimits(adapter, input)).allowed).toBe(true);
    }

    time.advance(59_999);
    expect((await enforceNoteRateLimits(adapter, input)).allowed).toBe(false);
    time.advance(1);
    expect((await enforceNoteRateLimits(adapter, input)).allowed).toBe(true);
  });

  it("returns the longest reset when multiple autosave scopes are exhausted", async () => {
    const time = mutableClock();
    const adapter = new InMemoryRateLimitAdapter({ clock: time.clock });
    const keySecret = "strictest-scope-test-secret";
    for (let index = 0; index < 300; index += 1) {
      expect(
        (
          await enforceNoteRateLimits(adapter, {
            kind: "autosave",
            actorId: `workspace-fill-${index}`,
            workspaceId: "shared-workspace",
            clientIp: `192.0.${Math.floor(index / 250)}.${index % 250}`,
            keySecret,
          })
        ).allowed,
      ).toBe(true);
    }

    time.advance(30_000);
    let strictest;
    for (let index = 0; index <= 60; index += 1) {
      strictest = await enforceNoteRateLimits(adapter, {
        kind: "autosave",
        actorId: "shared-actor",
        workspaceId: "shared-workspace",
        clientIp: `198.51.100.${index + 1}`,
        keySecret,
      });
    }

    expect(strictest).toMatchObject({ allowed: false, limit: 60, retryAfterSeconds: 60 });
  });
});

function createAuthLimitFixture(
  options: {
    responseStatus?: 200 | 401;
    clock?: Clock;
    directPeer?: string;
  } = {},
) {
  const adapter = new InMemoryRateLimitAdapter({ clock: options.clock });
  const policy = createTrustedProxyPolicy("10.0.0.0/8", "x-forwarded-for");
  let handlerCalls = 0;
  const app = new Hono<{ Variables: SecurityVariables }>();
  app.use("*", createSecurityHeadersMiddleware());
  app.use(
    "/api/auth/*",
    createClientIpMiddleware(policy, () => options.directPeer ?? "203.0.113.9"),
  );
  app.use(
    "/api/auth/*",
    createAuthRateLimitMiddleware({
      rateLimit: adapter,
      keySecret: "auth-rate-limit-secret",
    }),
  );
  app.onError(createErrorHandler());
  app.post("/api/auth/*", (context) => {
    handlerCalls += 1;
    return context.json({ handled: true }, options.responseStatus ?? 200);
  });
  return { app, handlerCalls: () => handlerCalls };
}

describe("authentication route limits", () => {
  it("allows 10 failed account-and-IP logins and rate-limits the 11th", async () => {
    const { app } = createAuthLimitFixture({ responseStatus: 401 });
    for (let index = 1; index <= 11; index += 1) {
      const response = await app.request(
        jsonRequest("/api/auth/sign-in/email", {
          method: "POST",
          body: JSON.stringify({ email: "Case@Example.Test", password: "wrong" }),
        }),
      );
      expect(response.status).toBe(index <= 10 ? 401 : 429);
      if (index === 11) {
        expect(response.headers.get("retry-after")).toBe("900");
        expect(response.headers.get("cache-control")).toBe("no-store");
      }
    }
  });

  it("allows 30 total IP login attempts and blocks the 31st before the handler", async () => {
    const { app, handlerCalls } = createAuthLimitFixture();
    for (let index = 1; index <= 31; index += 1) {
      const response = await app.request(
        jsonRequest("/api/auth/sign-in/email", {
          method: "POST",
          body: JSON.stringify({ email: `user-${index}@example.test`, password: "valid" }),
        }),
      );
      expect(response.status).toBe(index <= 30 ? 200 : 429);
    }
    expect(handlerCalls()).toBe(30);
  });

  it.each([
    ["registration", "/api/auth/sign-up/email", 5, { email: "new@example.test" }],
    ["password reset", "/api/auth/request-password-reset", 5, { email: "user@example.test" }],
  ])("allows 5 %s attempts and rate-limits the 6th", async (_label, path, limit, body) => {
    const { app, handlerCalls } = createAuthLimitFixture();
    for (let index = 1; index <= limit + 1; index += 1) {
      const response = await app.request(
        jsonRequest(path, { method: "POST", body: JSON.stringify(body) }),
      );
      expect(response.status).toBe(index <= limit ? 200 : 429);
      if (index === limit + 1) expect(response.headers.get("retry-after")).toBe("3600");
    }
    expect(handlerCalls()).toBe(limit);
  });

  it("resets an auth window only after the injected clock reaches its boundary", async () => {
    const time = mutableClock();
    const { app, handlerCalls } = createAuthLimitFixture({ clock: time.clock });
    const request = () =>
      jsonRequest("/api/auth/sign-up/email", {
        method: "POST",
        body: JSON.stringify({ email: "window@example.test" }),
      });

    for (let index = 0; index < 5; index += 1) {
      expect((await app.request(request())).status).toBe(200);
    }
    expect((await app.request(request())).status).toBe(429);
    time.advance(3_599_999);
    const beforeBoundary = await app.request(request());
    expect(beforeBoundary.status).toBe(429);
    expect(beforeBoundary.headers.get("retry-after")).toBe("1");
    time.advance(1);
    expect((await app.request(request())).status).toBe(200);
    expect(handlerCalls()).toBe(6);
  });

  it("uses a keyed digest rather than raw account or IP text in bucket keys", async () => {
    const consumedKeys: string[] = [];
    const base = new InMemoryRateLimitAdapter();
    const app = new Hono<{ Variables: SecurityVariables }>();
    app.use("*", (context, next) => {
      context.set("clientIp", "203.0.113.12");
      return next();
    });
    app.use(
      "/api/auth/*",
      createAuthRateLimitMiddleware({
        rateLimit: {
          distributed: false,
          async consume(key, limit, windowMs) {
            consumedKeys.push(key);
            return base.consume(key, limit, windowMs);
          },
        },
        keySecret: "digest-secret",
      }),
    );
    app.post("/api/auth/*", (context) => context.json({ ok: true }));

    await app.request(
      jsonRequest("/api/auth/request-password-reset", {
        method: "POST",
        body: JSON.stringify({ email: "Sensitive.Account@Example.Test" }),
      }),
    );

    const raw = consumedKeys.join(" ");
    expect(raw).not.toContain("Sensitive.Account");
    expect(raw).not.toContain("203.0.113.12");
    expect(raw).toContain(
      createHmac("sha256", "digest-secret")
        .update("auth:password-reset:203.0.113.12:sensitive.account@example.test")
        .digest("hex"),
    );
  });

  it("fails closed before the auth handler when shared storage is unavailable", async () => {
    let handlerCalls = 0;
    const app = new Hono<{ Variables: SecurityVariables }>();
    app.use("*", createSecurityHeadersMiddleware());
    app.use("*", (context, next) => {
      context.set("clientIp", "203.0.113.20");
      return next();
    });
    app.use(
      "/api/auth/*",
      createAuthRateLimitMiddleware({
        keySecret: "failure-test-secret",
        rateLimit: {
          distributed: true,
          async consume() {
            throw new Error("postgres unavailable SQL_SENTINEL");
          },
        },
      }),
    );
    app.onError(createErrorHandler({ error() {} }));
    app.post("/api/auth/*", (context) => {
      handlerCalls += 1;
      return context.json({ ok: true });
    });

    const response = await app.request(
      jsonRequest("/api/auth/sign-up/email", { method: "POST", body: "{}" }),
    );

    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("SQL_SENTINEL");
    expect(handlerCalls).toBe(0);
  });
});

describe("production limiter selection", () => {
  it("marks the in-memory adapter as process-local", () => {
    expect(new InMemoryRateLimitAdapter().distributed).toBe(false);
  });

  it("retains a deterministic UUID-shaped correlation fallback", () => {
    expect(randomUUID()).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("rejects a process-local limiter for HTTPS production", async () => {
    const db = createDb("postgresql://unused:unused@localhost:5432/unused");
    try {
      expect(() =>
        createApp(
          {
            DATABASE_URL: "postgresql://unused:unused@localhost:5432/unused",
            BETTER_AUTH_SECRET: "production-limiter-secret-at-least-32-characters",
            BETTER_AUTH_URL: "https://app.example.test",
            WEB_ORIGIN: "https://app.example.test",
          },
          {
            db,
            workspaceService: noOpWorkspaceService(),
            rateLimit: new InMemoryRateLimitAdapter(),
          },
        ),
      ).toThrow("Production requires an initializable distributed rate limiter");
    } finally {
      await db.$client.end();
    }
  });

  it("fails closed when production limiter initialization fails", async () => {
    const db = createDb("postgresql://unused:unused@localhost:5432/unused");
    const logs: Array<Parameters<AppSecurityLogger["error"]>[0]> = [];
    try {
      const app = createApp(
        {
          DATABASE_URL: "postgresql://unused:unused@localhost:5432/unused",
          BETTER_AUTH_SECRET: "production-init-secret-at-least-32-characters",
          BETTER_AUTH_URL: "https://app.example.test",
          WEB_ORIGIN: "https://app.example.test",
        },
        {
          db,
          workspaceService: noOpWorkspaceService(),
          logger: {
            error(entry) {
              logs.push(entry);
            },
          },
          rateLimit: {
            distributed: true,
            async initialize() {
              throw new Error("DATABASE_PASSWORD SQL_SENTINEL STACK_SENTINEL");
            },
            async consume() {
              throw new Error("must not consume before initialization");
            },
          },
        },
      );
      const response = await app.request("https://app.example.test/api/auth/sign-up/email", {
        method: "POST",
        headers: { "content-type": "application/json", origin: "https://app.example.test" },
        body: "{}",
      });
      const serialized = JSON.stringify({ body: await response.json(), logs });

      expect(response.status).toBe(503);
      expect(response.headers.get("x-request-id")).toMatch(/^[0-9a-f-]{36}$/);
      expect(serialized).not.toContain("DATABASE_PASSWORD");
      expect(serialized).not.toContain("SQL_SENTINEL");
      expect(serialized).not.toContain("STACK_SENTINEL");
    } finally {
      await db.$client.end();
    }
  });
});

describe("trusted origin environment", () => {
  const baseEnvironment = {
    DATABASE_URL: "postgresql://app:secret@localhost:5432/glyphquire",
    BETTER_AUTH_SECRET: "test-secret-at-least-thirty-two-characters",
    BETTER_AUTH_URL: "http://localhost:3000",
    API_PORT: "3000",
    WEB_PORT: "5173",
  };

  it("parses WEB_ORIGIN once into the canonical URL used by the application", () => {
    const parsed = parseEnv({
      ...baseEnvironment,
      WEB_ORIGIN: "http://localhost:5173/",
      TRUSTED_PROXY_CIDRS: "10.0.0.0/8",
      FORWARDED_IP_HEADER: "x-forwarded-for",
    });

    expect(parsed.WEB_ORIGIN).toBeInstanceOf(URL);
    expect(parsed.WEB_ORIGIN.origin).toBe("http://localhost:5173");
    expect(parsed.PRODUCTION).toBe(false);
  });

  it.each([
    "*",
    "https://*.example.test",
    "https://app.example.test/path",
    "https://user:password@app.example.test",
    "file:///tmp/glyphquire",
    "http://public.example.test",
  ])("rejects unsafe WEB_ORIGIN value %s", (origin) => {
    expect(() => parseEnv({ ...baseEnvironment, WEB_ORIGIN: origin })).toThrow(
      "Invalid environment variables",
    );
  });

  it("requires the Better Auth origin to match the web origin in production", () => {
    expect(() =>
      parseEnv({
        ...baseEnvironment,
        WEB_ORIGIN: "https://app.example.test",
        BETTER_AUTH_URL: "https://api.example.test",
      }),
    ).toThrow("BETTER_AUTH_URL and WEB_ORIGIN must be same-origin in production");
  });
});

const migrationDatabaseUrl = process.env.TEST_MIGRATION_DATABASE_URL;
const describeWithPostgres = migrationDatabaseUrl ? describe : describe.skip;
const migrationsDirectory = fileURLToPath(
  new URL("../../../../packages/database/src/migrations", import.meta.url),
);

function sessionCookie(response: Response) {
  const setCookie = response.headers.get("set-cookie");
  expect(setCookie).toBeTruthy();
  const firstCookie = setCookie!.split(",").find((cookie) => cookie.includes("session_token"));
  expect(firstCookie).toBeTruthy();
  return firstCookie!;
}

function expectSessionCookieAttributes(cookie: string, secure: boolean) {
  expect(cookie).toMatch(/(?:^|;\s*)HttpOnly(?:;|$)/i);
  expect(cookie).toMatch(/(?:^|;\s*)Path=\/(?:;|$)/i);
  expect(cookie).toMatch(/(?:^|;\s*)SameSite=Lax(?:;|$)/i);
  expect(cookie).not.toMatch(/(?:^|;\s*)Domain=/i);
  if (secure) expect(cookie).toMatch(/(?:^|;\s*)Secure(?:;|$)/i);
  else expect(cookie).not.toMatch(/(?:^|;\s*)Secure(?:;|$)/i);
}

describeWithPostgres("Better Auth cookie and trusted-origin integration", () => {
  let adminDb: Database;
  let db: Database;
  let databaseName: string;

  beforeAll(async () => {
    const adminUrl = new URL(migrationDatabaseUrl!);
    if (!["127.0.0.1", "localhost"].includes(adminUrl.hostname)) {
      throw new Error("security integration requires a loopback PostgreSQL URL");
    }
    adminDb = createDb(adminUrl.toString());
    databaseName = `glyphquire_t5_cookie_${randomUUID().replaceAll("-", "")}`;
    expect(databaseName).toMatch(/^[a-z0-9_]+$/);
    await adminDb.$client.unsafe(`create database "${databaseName}"`);
    adminUrl.pathname = `/${databaseName}`;
    db = createDb(adminUrl.toString());
    await runDatabaseMigrations(db, { migrationsFolder: migrationsDirectory });
  });

  afterAll(async () => {
    if (db) await db.$client.end();
    if (adminDb && databaseName) {
      await adminDb.$client`
        select pg_catalog.pg_terminate_backend(activity.pid)
        from pg_catalog.pg_stat_activity activity
        where activity.datname = ${databaseName}
          and activity.pid <> pg_catalog.pg_backend_pid()
      `;
      await adminDb.$client.unsafe(`drop database "${databaseName}"`);
      await adminDb.$client.end();
    }
  });

  it("issues and clears host-only secure session cookies for HTTPS production", async () => {
    const origin = new URL("https://app.example.test");
    const auth = createAuth(db, {
      baseUrl: origin.origin,
      webOrigin: origin,
      secret: "production-cookie-test-secret-at-least-32-characters",
      async onUserCreated() {},
    });
    const email = `secure-cookie-${randomUUID()}@example.test`;
    const registration = await auth.handler(
      new Request(`${origin.origin}/api/auth/sign-up/email`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: origin.origin },
        body: JSON.stringify({
          name: "Secure Cookie",
          email,
          password: "correct-horse-battery-staple",
        }),
      }),
    );
    expect(registration.status).toBe(200);
    const issued = sessionCookie(registration);
    expectSessionCookieAttributes(issued, true);

    const cookieHeader = issued.split(";", 1)[0]!;
    const authenticated = await auth.api.getSession({
      headers: new Headers({ cookie: cookieHeader }),
    });
    expect(authenticated?.user.email).toBe(email);

    const logout = await auth.handler(
      new Request(`${origin.origin}/api/auth/sign-out`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: cookieHeader,
          origin: origin.origin,
        },
        body: "{}",
      }),
    );
    expect(logout.status).toBe(200);
    const cleared = sessionCookie(logout);
    expectSessionCookieAttributes(cleared, true);
    expect(cleared).toMatch(/Max-Age=0/i);
  });

  it("trusts the exact HTTP development web origin without setting Secure", async () => {
    const apiOrigin = "http://localhost:3000";
    const developmentOrigin = new URL("http://localhost:5173");
    const auth = createAuth(db, {
      baseUrl: apiOrigin,
      webOrigin: developmentOrigin,
      secret: "development-cookie-test-secret-at-least-32-characters",
      async onUserCreated() {},
    });
    const registration = await auth.handler(
      new Request(`${apiOrigin}/api/auth/sign-up/email`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: developmentOrigin.origin },
        body: JSON.stringify({
          name: "Development Cookie",
          email: `development-cookie-${randomUUID()}@example.test`,
          password: "correct-horse-battery-staple",
        }),
      }),
    );

    expect(registration.status).toBe(200);
    expectSessionCookieAttributes(sessionCookie(registration), false);
  });

  it("never records a password-reset token in an auth failure log", async () => {
    const token = "RESET_TOKEN_SENTINEL";
    const entries: Array<Parameters<AppSecurityLogger["error"]>[0]> = [];
    const failingDb = new Proxy(db, {
      get(target, property) {
        if (property === "select") {
          return () => {
            throw new Error("injected reset lookup failure");
          };
        }
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const origin = new URL("https://app.example.test");
    const auth = createAuth(failingDb, {
      baseUrl: origin.origin,
      webOrigin: origin,
      secret: "reset-log-test-secret-at-least-32-characters",
      errorLogger: {
        error(entry) {
          entries.push(entry);
        },
      },
      async onUserCreated() {},
    });

    const response = await auth.handler(
      new Request(
        `${origin.origin}/api/auth/reset-password/${token}?callbackURL=${encodeURIComponent(origin.origin)}`,
        {
          headers: {
            origin: origin.origin,
            "x-request-id": "reset-log-request",
          },
        },
      ),
    );

    expect(response.status).toBe(503);
    expect(JSON.stringify(entries)).not.toContain(token);
    expect(entries).toEqual([
      expect.objectContaining({
        event: "auth_request_failed",
        requestId: "reset-log-request",
        path: "/api/auth/*",
      }),
    ]);
  });

  it("feeds the same validated origin to Hono and Better Auth", async () => {
    const apiOrigin = "http://localhost:3000";
    const configuredWebOrigin = "http://localhost:5173";
    const app = createApp(
      {
        DATABASE_URL: migrationDatabaseUrl!,
        BETTER_AUTH_SECRET: "shared-origin-test-secret-at-least-32-characters",
        BETTER_AUTH_URL: apiOrigin,
        WEB_ORIGIN: configuredWebOrigin,
        API_PORT: 3000,
        WEB_PORT: 5173,
      },
      {
        db,
        workspaceService: noOpWorkspaceService(),
        logger: { error() {} },
      },
    );
    const registrationBody = (email: string) =>
      JSON.stringify({
        name: "Shared Origin",
        email,
        password: "correct-horse-battery-staple",
      });

    const wrongAuthOrigin = await app.request(`${apiOrigin}/api/auth/sign-up/email`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: apiOrigin },
      body: registrationBody(`wrong-origin-${randomUUID()}@example.test`),
    });
    expect(wrongAuthOrigin.status).toBe(403);

    const acceptedAuthOrigin = await app.request(`${apiOrigin}/api/auth/sign-up/email`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: configuredWebOrigin },
      body: registrationBody(`shared-origin-${randomUUID()}@example.test`),
    });
    expect(acceptedAuthOrigin.status).toBe(200);

    const wrongApiOrigin = await app.request(`${apiOrigin}/api/v1/not-yet-mounted`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: apiOrigin },
      body: "{}",
    });
    expect(wrongApiOrigin.status).toBe(403);
    const acceptedApiOrigin = await app.request(`${apiOrigin}/api/v1/not-yet-mounted`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: configuredWebOrigin },
      body: "{}",
    });
    expect(acceptedApiOrigin.status).toBe(404);
  });
});

describe("rate-limit persistence contract", () => {
  it("exports the constrained PostgreSQL bucket schema", () => {
    expect(rateLimitBuckets.bucketKey.name).toBe("bucket_key");
    expect(rateLimitBuckets.bucketKey.primary).toBe(true);
    expect(rateLimitBuckets.windowStartedAt.name).toBe("window_started_at");
    expect(rateLimitBuckets.requestCount.name).toBe("request_count");
    expect(rateLimitBuckets.requestCount.notNull).toBe(true);
  });

  it("commits exactly the frozen 0000-0002 prefix followed by 0003", async () => {
    const migrations = await readRepositoryMigrations(migrationsDirectory);
    expect(migrations.map(({ idx, tag, hash }) => ({ idx, tag, hash }))).toEqual([
      {
        idx: 0,
        tag: "0000_phase0_auth",
        hash: "7fbba803d17ce335f8acc41fd7027c3c1278d4af79225c48ac6d0ab885028863",
      },
      {
        idx: 1,
        tag: "0001_phase2_workspaces",
        hash: "c0aac84d7bb3fd4766604dfa46d2f0df18b5b4f027e42e5ec6696e9386f1f162",
      },
      {
        idx: 2,
        tag: "0002_phase2_notes",
        hash: "7d4bb87aae2f390f35070ed3e696a92222d2613bef64de573f3314eddbae3f3c",
      },
      {
        idx: 3,
        tag: "0003_phase2_rate_limits",
        hash: "1bb138216bc401bf4f62c9806fb4c3c1f1fcfb056ad153a190e21a75386a25bb",
      },
    ]);
    expect(migrations.every(({ hash }) => /^[a-f0-9]{64}$/.test(hash))).toBe(true);
    expect(new Set(migrations.map(({ when }) => when)).size).toBe(4);

    const sql = await readFile(
      new URL(
        "../../../../packages/database/src/migrations/0003_phase2_rate_limits.sql",
        import.meta.url,
      ),
      "utf8",
    );
    expect(sql).toContain('CREATE TABLE "rate_limit_buckets"');
    expect(sql).toContain('REVOKE DELETE ON TABLE "rate_limit_buckets"');
    expect(createHash("sha256").update(sql).digest("hex")).toBe(migrations[3]?.hash);
  });
});

const runtimeDatabaseUrl = process.env.TEST_DATABASE_URL;

describeWithPostgres("atomic PostgreSQL rate limiting and migration paths", () => {
  let adminDb: Database;
  let freshDb: Database;
  let secondFreshDb: Database;
  let phase0Db: Database;
  let freshName: string;
  let phase0Name: string;
  let freshUrl: string;
  let phase0Url: string;
  let phase0AuthConsoleOutput = "";
  let phase0AppResponse!: { status: number; requestId: string | null; body: unknown };
  const phase0AppLogEntries: Array<Parameters<AppSecurityLogger["error"]>[0]> = [];

  beforeAll(async () => {
    const adminUrl = new URL(migrationDatabaseUrl!);
    if (!["127.0.0.1", "localhost"].includes(adminUrl.hostname)) {
      throw new Error("security migration integration requires a loopback PostgreSQL URL");
    }
    adminDb = createDb(adminUrl.toString());
    freshName = `glyphquire_t5_fresh_${randomUUID().replaceAll("-", "")}`;
    phase0Name = `glyphquire_t5_phase0_${randomUUID().replaceAll("-", "")}`;
    expect(freshName).toMatch(/^[a-z0-9_]+$/);
    expect(phase0Name).toMatch(/^[a-z0-9_]+$/);
    await adminDb.$client.unsafe(`create database "${freshName}"`);
    await adminDb.$client.unsafe(`create database "${phase0Name}"`);

    const freshTarget = new URL(adminUrl);
    freshTarget.pathname = `/${freshName}`;
    freshUrl = freshTarget.toString();
    freshDb = createDb(freshUrl);
    secondFreshDb = createDb(freshUrl);
    if (runtimeDatabaseUrl) {
      const runtimeUrl = new URL(runtimeDatabaseUrl);
      const runtimeRole = decodeURIComponent(runtimeUrl.username);
      const migrationRole = decodeURIComponent(adminUrl.username);
      if (
        !/^[a-z_][a-z0-9_]{0,62}$/.test(runtimeRole) ||
        !/^[a-z_][a-z0-9_]{0,62}$/.test(migrationRole)
      ) {
        throw new Error("database roles must be simple identifiers");
      }
      await adminDb.$client.unsafe(`grant connect on database "${freshName}" to "${runtimeRole}"`);
      await freshDb.$client.unsafe(`grant usage on schema public to "${runtimeRole}"`);
      await freshDb.$client.unsafe(
        `alter default privileges for role "${migrationRole}" in schema public ` +
          `grant select, insert, update, delete on tables to "${runtimeRole}"`,
      );
      await freshDb.$client.unsafe(
        `alter default privileges for role "${migrationRole}" in schema public ` +
          `grant usage on sequences to "${runtimeRole}"`,
      );
    }
    expect(await verifyMigrationBaseline(freshUrl, migrationsDirectory)).toBe("empty");
    await runDatabaseMigrations(freshDb, { migrationsFolder: migrationsDirectory });

    const phase0Target = new URL(adminUrl);
    phase0Target.pathname = `/${phase0Name}`;
    phase0Url = phase0Target.toString();
    phase0Db = createDb(phase0Url);
    const phase0Sql = await readFile(
      new URL("../../../../packages/database/src/migrations/0000_phase0_auth.sql", import.meta.url),
      "utf8",
    );
    await phase0Db.$client.unsafe(phase0Sql);
    const phase0Auth = createAuth(phase0Db, {
      baseUrl: "http://localhost:3000",
      webOrigin: new URL("http://localhost:3000"),
      secret: "phase-zero-error-test-secret-at-least-32-characters",
      async onUserCreated() {},
    });
    const originalConsoleError = console.error;
    const capturedConsoleErrors: string[] = [];
    console.error = (...values: unknown[]) => {
      capturedConsoleErrors.push(values.map(String).join(" "));
    };
    try {
      const incompatibleSignup = await phase0Auth.handler(
        new Request("http://localhost:3000/api/auth/sign-up/email", {
          method: "POST",
          headers: { "content-type": "application/json", origin: "http://localhost:3000" },
          body: JSON.stringify({
            name: "Phase Zero Error",
            email: `phase-zero-error-${randomUUID()}@example.test`,
            password: "correct-horse-battery-staple",
          }),
        }),
      );
      expect(incompatibleSignup.status).toBe(500);
    } finally {
      console.error = originalConsoleError;
    }
    phase0AuthConsoleOutput = capturedConsoleErrors.join("\n");
    const phase0App = createApp(
      {
        DATABASE_URL: phase0Url,
        BETTER_AUTH_SECRET: "phase-zero-app-error-secret-at-least-32-characters",
        BETTER_AUTH_URL: "http://localhost:3000",
        WEB_ORIGIN: "http://localhost:5173",
        API_PORT: 3000,
        WEB_PORT: 5173,
      },
      {
        db: phase0Db,
        workspaceService: noOpWorkspaceService(),
        logger: {
          error(entry) {
            phase0AppLogEntries.push(entry);
          },
        },
      },
    );
    const phase0AppHttpResponse = await phase0App.request(
      new Request("http://localhost:3000/api/auth/sign-up/email", {
        method: "POST",
        headers: { "content-type": "application/json", origin: "http://localhost:5173" },
        body: JSON.stringify({
          name: "Phase Zero App Error",
          email: `phase-zero-app-error-${randomUUID()}@example.test`,
          password: "correct-horse-battery-staple",
        }),
      }),
    );
    phase0AppResponse = {
      status: phase0AppHttpResponse.status,
      requestId: phase0AppHttpResponse.headers.get("x-request-id"),
      body: await phase0AppHttpResponse.json(),
    };
    expect(await verifyMigrationBaseline(phase0Url, migrationsDirectory)).toBe("baselined");
    await runDatabaseMigrations(phase0Db, { migrationsFolder: migrationsDirectory });
  });

  afterAll(async () => {
    for (const db of [freshDb, secondFreshDb, phase0Db]) {
      if (db) await db.$client.end();
    }
    if (adminDb) {
      for (const databaseName of [freshName, phase0Name]) {
        if (!databaseName) continue;
        await adminDb.$client`
          select pg_catalog.pg_terminate_backend(activity.pid)
          from pg_catalog.pg_stat_activity activity
          where activity.datname = ${databaseName}
            and activity.pid <> pg_catalog.pg_backend_pid()
        `;
        await adminDb.$client.unsafe(`drop database "${databaseName}"`);
      }
      await adminDb.$client.end();
    }
  });

  it("records identical ordered hashes for fresh and exact Phase 0 upgrade paths", async () => {
    const expected = (await readRepositoryMigrations(migrationsDirectory)).map(
      ({ hash, when }) => ({ hash, created_at: String(when) }),
    );
    for (const db of [freshDb, phase0Db]) {
      const rows = await db.$client<{ hash: string; created_at: string }[]>`
        select hash, created_at::text
        from drizzle.__drizzle_migrations
        order by created_at, id
      `;
      expect(rows).toEqual(expected);
    }
  });

  it("replaces raw Better Auth adapter exceptions with a scrubbed structured event", () => {
    expect(phase0AuthConsoleOutput).not.toContain("insert into");
    expect(phase0AuthConsoleOutput).not.toContain("params:");
    expect(phase0AuthConsoleOutput).not.toContain("DrizzleQueryError");
    expect(JSON.parse(phase0AuthConsoleOutput)).toEqual({
      event: "auth_request_failed",
      requestId: "unavailable",
      code: "SERVICE_UNAVAILABLE",
      status: 500,
      method: "POST",
      path: "/api/auth/sign-up/email",
    });
  });

  it("shares the scrubbed logger and stable request ID through the app auth seam", () => {
    expect(phase0AppResponse.status).toBe(503);
    expect(phase0AppResponse.requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(phase0AppResponse.body).toEqual({
      error: {
        code: "SERVICE_UNAVAILABLE",
        message: "The service is temporarily unavailable",
        requestId: phase0AppResponse.requestId,
      },
    });
    expect(phase0AppLogEntries).toEqual([
      {
        event: "auth_request_failed",
        requestId: phase0AppResponse.requestId,
        code: "SERVICE_UNAVAILABLE",
        status: 503,
        method: "POST",
        path: "/api/auth/sign-up/email",
      },
    ]);
  });

  it("atomically shares one bucket across two API instances", async () => {
    const time = mutableClock();
    const first = new PostgresRateLimitAdapter(freshDb, { clock: time.clock });
    const second = new PostgresRateLimitAdapter(secondFreshDb, { clock: time.clock });
    await Promise.all([first.initialize(), second.initialize()]);

    const decisions = await Promise.all(
      Array.from({ length: 31 }, (_, index) =>
        (index % 2 === 0 ? first : second).consume("shared-concurrency-bucket", 30, 60_000),
      ),
    );

    expect(decisions.filter(({ allowed }) => allowed)).toHaveLength(30);
    expect(decisions.filter(({ allowed }) => !allowed)).toHaveLength(1);
  });

  it("resets the PostgreSQL bucket only at the injected window boundary", async () => {
    const time = mutableClock();
    const adapter = new PostgresRateLimitAdapter(freshDb, { clock: time.clock });
    expect((await adapter.consume("postgres-window-bucket", 1, 60_000)).allowed).toBe(true);
    time.advance(59_999);
    expect((await adapter.consume("postgres-window-bucket", 1, 60_000)).allowed).toBe(false);
    time.advance(1);
    expect((await adapter.consume("postgres-window-bucket", 1, 60_000)).allowed).toBe(true);
  });

  it.runIf(Boolean(runtimeDatabaseUrl))(
    "allows runtime DML while denying bucket deletion, DDL, and journal writes",
    async () => {
      const runtimeUrl = new URL(runtimeDatabaseUrl!);
      if (!["127.0.0.1", "localhost"].includes(runtimeUrl.hostname)) {
        throw new Error("least-privilege integration requires a loopback PostgreSQL URL");
      }
      if ((runtimeUrl.port || "5432") !== (new URL(freshUrl).port || "5432")) {
        throw new Error("migration and runtime PostgreSQL URLs must use the same server");
      }
      const runtimeRole = decodeURIComponent(runtimeUrl.username);
      if (!/^[a-z_][a-z0-9_]{0,62}$/.test(runtimeRole)) {
        throw new Error("runtime database role must be a simple identifier");
      }

      runtimeUrl.pathname = `/${freshName}`;
      const runtimeDb = createDb(runtimeUrl.toString());
      try {
        const actorId = `rate-limit-runtime-${randomUUID()}`;
        await runtimeDb.$client`
          insert into "user" (id, name, email)
          values (${actorId}, 'Runtime DML', ${`${actorId}@example.test`})
        `;
        await runtimeDb.$client`update "user" set name = 'Updated' where id = ${actorId}`;
        expect(await runtimeDb.$client`select id from "user" where id = ${actorId}`).toHaveLength(
          1,
        );
        await runtimeDb.$client`delete from "user" where id = ${actorId}`;

        const adapter = new PostgresRateLimitAdapter(runtimeDb);
        expect((await adapter.consume("runtime-adapter-bucket", 2, 60_000)).allowed).toBe(true);
        await expect(
          runtimeDb.$client`delete from rate_limit_buckets where bucket_key = 'runtime-adapter-bucket'`,
        ).rejects.toMatchObject({ code: "42501" });
        await expect(
          runtimeDb.$client.unsafe("create table task5_forbidden_create (id integer)"),
        ).rejects.toMatchObject({ code: "42501" });
        await expect(
          runtimeDb.$client.unsafe("alter table rate_limit_buckets add column forbidden integer"),
        ).rejects.toMatchObject({ code: "42501" });
        await expect(
          runtimeDb.$client.unsafe("drop table rate_limit_buckets"),
        ).rejects.toMatchObject({ code: "42501" });
        await expect(
          runtimeDb.$client`
            insert into drizzle.__drizzle_migrations (hash, created_at)
            values ('forbidden', 1)
          `,
        ).rejects.toMatchObject({ code: "42501" });
      } finally {
        await runtimeDb.$client.end();
      }
    },
  );
});
