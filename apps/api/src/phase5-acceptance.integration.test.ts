import { randomBytes, randomUUID } from "node:crypto";
import { createDb, type Database } from "@glyphquire/database";
import type {
  CreateShareLinkInput,
  ShareLinkResponse,
  SharedNoteResponse,
} from "@glyphquire/api-contract";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "./app.js";
import { parseEnv } from "./env.js";
import { InMemoryRateLimitAdapter } from "./middleware/rate-limit.js";
import type { ShareLinkService } from "./modules/share-links/ShareLinkService.js";

const BASE_ENV = {
  DATABASE_URL: "postgresql://app:secret@localhost:5432/glyphquire",
  BETTER_AUTH_SECRET: "phase5-app-test-secret-at-least-32-characters",
  BETTER_AUTH_URL: "http://localhost:3000",
  WEB_ORIGIN: "http://localhost:5173",
};

const PHASE5_ENV = {
  S3_ENDPOINT: "http://localhost:9000",
  S3_ACCESS_KEY: "phase5-access",
  S3_SECRET_KEY: "phase5-storage-secret",
  S3_BUCKET: "glyphquire-assets",
  S3_REGION: "us-east-1",
  S3_FORCE_PATH_STYLE: "true",
  IDEMPOTENCY_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64url"),
  BACKUP_ENCRYPTION_KEY: Buffer.alloc(32, 2).toString("base64url"),
  PHASE5_ALERT_WEBHOOK_URL: "https://alerts.example/phase5",
  PHASE5_ALERT_DELIVERY_SECONDS: "300",
};

class FakeShareService implements ShareLinkService {
  readonly resolve = vi.fn(async (_token: string): Promise<SharedNoteResponse> => ({
    noteId: "11111111-1111-4111-8111-111111111111",
    title: "Read-only projection",
    contentMarkdown: "# Bounded public Markdown",
    schemaVersion: 1,
    updatedAt: "2026-08-30T00:00:00.000Z",
  }));

  async create(
    _actorId: string,
    _noteId: string,
    _input: CreateShareLinkInput,
    _idempotencyKey: string,
  ): Promise<ShareLinkResponse> {
    throw new Error("not used by anonymous acceptance");
  }

  async revoke(_actorId: string, _linkId: string): Promise<void> {
    throw new Error("not used by anonymous acceptance");
  }
}

const databases: Database[] = [];

afterEach(async () => {
  await Promise.all(databases.splice(0).map((db) => db.$client.end()));
});

describe("Phase 5 final environment and route acceptance", () => {
  it("enables the complete validated storage/encryption/alert group without exposing secrets", () => {
    const parsed = parseEnv({ ...BASE_ENV, ...PHASE5_ENV });

    expect(parsed.PHASE5_ENABLED).toBe(true);
    if (!parsed.PHASE5_ENABLED) throw new Error("expected Phase 5 environment");
    expect(parsed.S3_FORCE_PATH_STYLE).toBe(true);
    expect(parsed.PHASE5_ALERT_WEBHOOK_URL).toBeInstanceOf(URL);
    expect(parsed.PHASE5_ALERT_DELIVERY_SECONDS).toBe(300);
    expect(parsed.WEB_ORIGIN.origin).toBe("http://localhost:5173");
  });

  it("rejects a partial or over-broad Phase 5 group without echoing supplied values", () => {
    const secret = "must-not-appear-in-error";
    for (const candidate of [
      { ...BASE_ENV, S3_ENDPOINT: "http://localhost:9000", S3_SECRET_KEY: secret },
      { ...BASE_ENV, ...PHASE5_ENV, PHASE5_ALERT_DELIVERY_SECONDS: "301" },
      { ...BASE_ENV, ...PHASE5_ENV, PHASE5_ALERT_WEBHOOK_URL: "http://public.example/alert" },
    ]) {
      let message = "";
      try {
        parseEnv(candidate);
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      expect(message).toContain("Invalid environment variables");
      expect(message).not.toContain(secret);
      expect(message).not.toContain("phase5-storage-secret");
    }
  });

  it("mounts the anonymous share route before authentication while retaining security limits", async () => {
    const db = createDb(BASE_ENV.DATABASE_URL);
    databases.push(db);
    const service = new FakeShareService();
    const ensurePersonalWorkspace = vi.fn(async () => ({
      id: randomUUID(),
      name: "Personal" as const,
      role: "owner" as const,
    }));
    const app = createApp(BASE_ENV, {
      db,
      shareLinkService: service,
      workspaceService: { ensurePersonalWorkspace },
      rateLimit: new InMemoryRateLimitAdapter(),
      getDirectPeer: () => "203.0.113.5",
      logger: { error: vi.fn() },
    });
    const token = randomBytes(32).toString("base64url");

    const response = await app.request(`http://localhost:3000/api/v1/shared/${token}`);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ title: "Read-only projection" });
    expect(service.resolve).toHaveBeenCalledWith(token);
    expect(ensurePersonalWorkspace).not.toHaveBeenCalled();
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(response.headers.get("x-request-id")).toMatch(/^[0-9a-f-]{36}$/u);
  });
});
