import { randomUUID } from "node:crypto";
import {
  createDb,
  jobs,
  user,
  workspaceMembers,
  workspaces,
  type Database,
} from "@glyphquire/database";
import { PostgresJobDispatcher, type JobDispatcher } from "@glyphquire/queue";
import { eq } from "drizzle-orm";
import type {
  MaintenanceService,
  BackupVerificationQuery,
  DeadLetterQuery,
} from "./maintenance.js";
import { encodeCursor } from "@glyphquire/api-contract";
import { createOperatorAuthorizer } from "../../modules/search/OperatorAuthorizer.js";
import { Hono, type Context } from "hono";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  createErrorHandler,
  PublicApiError,
  type SecurityLogger,
} from "../../middleware/error-handler.js";
import type { SecurityVariables } from "../../middleware/security.js";
import { createMaintenanceRoutes, MaintenanceServiceImpl } from "./maintenance.js";
import { createApp } from "../../app.js";

const actorId = "configured-operator";
const baseUrl = "http://localhost:3000";
const databaseUrl = process.env.TEST_DATABASE_URL;
const describeWithPostgres = databaseUrl ? describe : describe.skip;

function databaseReturningJob(row: unknown): Database {
  const limit = vi.fn().mockResolvedValue([row]);
  const where = vi.fn().mockReturnValue({ limit });
  const from = vi.fn().mockReturnValue({ where });
  return { select: vi.fn().mockReturnValue({ from }) } as unknown as Database;
}

function auth() {
  return async (context: Context<{ Variables: SecurityVariables }>, next: () => Promise<void>) => {
    context.set("requestContext", {
      requestId: randomUUID(),
      actorId: context.req.header("x-test-actor-id") ?? "normal-member",
      session: {} as never,
    });
    await next();
  };
}

function service(overrides: Partial<MaintenanceService> = {}): MaintenanceService {
  return {
    capabilities: vi.fn().mockResolvedValue({
      operator: true,
      capabilities: ["search.rebuild", "jobs.dead_letters", "asset.cleanup", "backup.verify"],
    }),
    startSearchRebuild: vi.fn().mockResolvedValue({ jobId: randomUUID(), duplicate: false }),
    listDeadLetters: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
    replayDeadLetter: vi.fn().mockResolvedValue({ jobId: randomUUID(), duplicate: false }),
    startAssetCleanup: vi.fn().mockResolvedValue({ jobId: randomUUID(), duplicate: false }),
    backupVerification: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
    ...overrides,
  };
}

function buildApp(
  operatorIds: unknown = [actorId],
  overrides: Partial<MaintenanceService> = {},
  logger?: SecurityLogger,
) {
  const maintenance = service(overrides);
  const authorizer = createOperatorAuthorizer(operatorIds);
  const app = new Hono<{ Variables: SecurityVariables }>()
    .use("*", auth())
    .onError(createErrorHandler(logger))
    .route("/api/v1", createMaintenanceRoutes(maintenance, authorizer));
  return { app, maintenance };
}

function v1(
  app: ReturnType<typeof buildApp>["app"],
  path: string,
  init: RequestInit = {},
  currentActor = actorId,
) {
  const headers = new Headers(init.headers);
  headers.set("x-test-actor-id", currentActor);
  return app.request(`${baseUrl}/api/v1${path}`, { ...init, headers });
}

describe("operator maintenance routes", () => {
  it("is mounted with both lifecycle deletion routes in the application runtime", async () => {
    const db = createDb("postgresql://unused:unused@localhost:5432/unused");
    try {
      const lifecycleDependencies = {
        maintenanceService: service(),
        workspaceDeletionService: { request: vi.fn() },
        accountDeletionService: { request: vi.fn() },
      };
      const app = createApp(
        {
          DATABASE_URL: "postgresql://unused:unused@localhost:5432/unused",
          BETTER_AUTH_SECRET: "maintenance-route-test-secret-at-least-32-characters",
          BETTER_AUTH_URL: baseUrl,
          WEB_ORIGIN: "http://localhost:5173",
          PHASE5_OPERATOR_IDS: actorId,
        },
        {
          db,
          workspaceService: { ensurePersonalWorkspace: vi.fn() },
          ...lifecycleDependencies,
        },
      );
      const routes = app.routes.map((route) => `${route.method} ${route.path}`);

      expect(routes).toEqual(
        expect.arrayContaining([
          "POST /api/v1/workspaces/:workspaceId/deletion",
          "POST /api/v1/account/deletion",
          "GET /api/v1/maintenance/capabilities",
          "POST /api/v1/maintenance/search-rebuild",
          "GET /api/v1/maintenance/dead-letters",
          "POST /api/v1/maintenance/dead-letters/:id/replay",
          "POST /api/v1/maintenance/asset-cleanup",
          "GET /api/v1/maintenance/backup-verification",
        ]),
      );
    } finally {
      await db.$client.end();
    }
  });

  it("fails closed for capabilities and every operation when the allowlist is absent", async () => {
    const { app, maintenance } = buildApp([]);
    for (const [path, init] of [
      ["/maintenance/capabilities", {}],
      [
        "/maintenance/search-rebuild",
        {
          method: "POST",
          headers: { "content-type": "application/json", "idempotency-key": "search-1" },
          body: JSON.stringify({ workspaceId: randomUUID(), batchSize: 10 }),
        },
      ],
      ["/maintenance/dead-letters?pageSize=10", {}],
      [
        `/maintenance/dead-letters/${randomUUID()}/replay`,
        { method: "POST", headers: { "idempotency-key": "replay-1" } },
      ],
      [
        "/maintenance/asset-cleanup",
        {
          method: "POST",
          headers: { "content-type": "application/json", "idempotency-key": "asset-1" },
          body: JSON.stringify({ workspaceId: randomUUID(), batchSize: 10 }),
        },
      ],
      ["/maintenance/backup-verification?pageSize=10", {}],
    ] as const) {
      const result = await v1(app, path, init, "normal-member");
      expect(result.status, path).toBe(404);
    }
    expect(maintenance.capabilities).not.toHaveBeenCalled();
    expect(maintenance.startSearchRebuild).not.toHaveBeenCalled();
    expect(maintenance.listDeadLetters).not.toHaveBeenCalled();
    expect(maintenance.replayDeadLetter).not.toHaveBeenCalled();
    expect(maintenance.startAssetCleanup).not.toHaveBeenCalled();
    expect(maintenance.backupVerification).not.toHaveBeenCalled();
  });

  it("passes bounded search rebuild input, actor, request id, and idempotency key", async () => {
    const { app, maintenance } = buildApp();
    const workspaceId = randomUUID();
    const result = await v1(app, "/maintenance/search-rebuild", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": "search-rebuild-1",
      },
      body: JSON.stringify({ workspaceId, batchSize: 100 }),
    });

    expect(result.status).toBe(202);
    expect(maintenance.startSearchRebuild).toHaveBeenCalledWith(
      actorId,
      { workspaceId, batchSize: 100 },
      "search-rebuild-1",
      expect.any(String),
    );
  });

  it("returns capabilities only after exact operator authorization", async () => {
    const { app, maintenance } = buildApp();
    const result = await v1(app, "/maintenance/capabilities");

    expect(result.status).toBe(200);
    expect(maintenance.capabilities).toHaveBeenCalledWith(actorId);
    expect(await result.json()).toEqual({
      operator: true,
      capabilities: ["search.rebuild", "jobs.dead_letters", "asset.cleanup", "backup.verify"],
    });
  });

  it.each([
    [{ workspaceId: randomUUID(), batchSize: 0 }, "key"],
    [{ workspaceId: randomUUID(), batchSize: 101 }, "key"],
    [{ workspaceId: randomUUID(), batchSize: 10, objectKey: "private" }, "key"],
    [{ workspaceId: randomUUID(), batchSize: 10 }, undefined],
  ])("rejects malformed search rebuild mutations", async (body, key) => {
    const { app, maintenance } = buildApp();
    const headers = new Headers({ "content-type": "application/json" });
    if (key) headers.set("idempotency-key", key);

    const result = await v1(app, "/maintenance/search-rebuild", {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });

    expect(result.status).toBe(400);
    expect(maintenance.startSearchRebuild).not.toHaveBeenCalled();
  });

  it("passes bounded asset cleanup and replay mutations through scrubbed seams", async () => {
    const { app, maintenance } = buildApp();
    const workspaceId = randomUUID();
    const cleanup = await v1(app, "/maintenance/asset-cleanup", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": "asset-cleanup-1",
      },
      body: JSON.stringify({ workspaceId, batchSize: 1 }),
    });
    const deadLetterId = randomUUID();
    const replay = await v1(app, `/maintenance/dead-letters/${deadLetterId}/replay`, {
      method: "POST",
      headers: { "idempotency-key": "dead-letter-replay-1" },
    });

    expect(cleanup.status).toBe(202);
    expect(maintenance.startAssetCleanup).toHaveBeenCalledWith(
      actorId,
      { workspaceId, batchSize: 1 },
      "asset-cleanup-1",
      expect.any(String),
    );
    expect(replay.status).toBe(202);
    expect(maintenance.replayDeadLetter).toHaveBeenCalledWith(
      actorId,
      deadLetterId,
      "dead-letter-replay-1",
      expect.any(String),
    );
  });

  it("strictly bounds diagnostics and rejects duplicate or unknown query keys", async () => {
    const { app, maintenance } = buildApp();
    const cursor = encodeCursor({ createdAt: "2026-08-26T00:00:00.000Z", id: randomUUID() });
    expect((await v1(app, "/maintenance/dead-letters?pageSize=101")).status).toBe(400);
    expect((await v1(app, "/maintenance/dead-letters?pageSize=10&pageSize=11")).status).toBe(400);
    expect((await v1(app, "/maintenance/backup-verification?payload=true")).status).toBe(400);
    expect(maintenance.listDeadLetters).not.toHaveBeenCalled();
    expect(maintenance.backupVerification).not.toHaveBeenCalled();

    const ok = await v1(
      app,
      `/maintenance/dead-letters?pageSize=10&cursor=${encodeURIComponent(cursor)}`,
    );
    expect(ok.status).toBe(200);
    expect(maintenance.listDeadLetters).toHaveBeenCalledWith(actorId, {
      pageSize: 10,
      cursor,
    } satisfies DeadLetterQuery);
    const backup = await v1(app, "/maintenance/backup-verification?pageSize=10");
    expect(backup.status).toBe(200);
    expect(maintenance.backupVerification).toHaveBeenCalledWith(actorId, {
      pageSize: 10,
    } satisfies BackupVerificationQuery);
  });

  it("rejects query/body smuggling on mutation endpoints", async () => {
    const { app, maintenance } = buildApp();
    const rebuild = await v1(app, "/maintenance/search-rebuild?scope=all", {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "search-key" },
      body: JSON.stringify({ workspaceId: randomUUID(), batchSize: 10 }),
    });
    const replay = await v1(app, `/maintenance/dead-letters/${randomUUID()}/replay`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "replay-key" },
      body: JSON.stringify({ payload: true }),
    });

    expect(rebuild.status).toBe(400);
    expect(replay.status).toBe(400);
    expect(maintenance.startSearchRebuild).not.toHaveBeenCalled();
    expect(maintenance.replayDeadLetter).not.toHaveBeenCalled();
  });

  it("validates service responses and never leaks job payloads or object keys", async () => {
    const sentinel = "s3://private-bucket/secret-object-key";
    const entries: unknown[] = [];
    const { app } = buildApp(
      [actorId],
      {
        listDeadLetters: vi.fn().mockResolvedValue({
          items: [
            {
              id: randomUUID(),
              workspaceId: null,
              type: "backup.verify",
              attempts: 1,
              maxAttempts: 5,
              createdAt: "2026-08-26T00:00:00.000Z",
              deadLetteredAt: "2026-08-26T00:01:00.000Z",
              errorCode: "JOB_FAILED",
              payload: { objectKey: sentinel },
            },
          ],
          nextCursor: null,
        }) as never,
      },
      { error: (entry) => entries.push(entry) },
    );

    const result = await v1(app, "/maintenance/dead-letters?pageSize=10");
    const serialized = JSON.stringify({ body: await result.json(), entries });

    expect(result.status).toBe(503);
    expect(serialized).not.toContain(sentinel);
    expect(serialized).not.toContain("objectKey");
  });
});

describe("MaintenanceService idempotency", () => {
  it("rejects reuse of a search rebuild key with a different bounded payload", async () => {
    const workspaceId = randomUUID();
    const jobId = randomUUID();
    const dispatcher = {
      enqueue: vi.fn().mockResolvedValue({ id: jobId, duplicate: true }),
    } as unknown as JobDispatcher;
    const database = databaseReturningJob({
      workspaceId,
      type: "search.rebuild",
      payload: { workspaceId, scope: "workspace", batchSize: 1 },
    });
    const service = new MaintenanceServiceImpl(
      database,
      dispatcher,
      createOperatorAuthorizer([actorId]),
    );

    await expect(
      service.startSearchRebuild(
        actorId,
        { workspaceId, batchSize: 2 },
        "reused-search-key",
        randomUUID(),
      ),
    ).rejects.toEqual(
      expect.objectContaining<Partial<PublicApiError>>({
        code: "OPERATION_REUSED",
        status: 409,
      }),
    );
  });
});

describeWithPostgres("MaintenanceService PostgreSQL integration", () => {
  let db: Database;
  const now = Date.parse("2036-08-26T00:00:00.000Z");

  beforeAll(() => {
    db = createDb(databaseUrl!);
  });

  afterAll(async () => {
    await db.$client.end();
  });

  async function fixture() {
    const owner = `maintenance-owner-${randomUUID()}`;
    await db.insert(user).values({
      id: owner,
      name: "Maintenance owner",
      email: `${owner}@example.test`,
    });
    const [workspace] = await db
      .insert(workspaces)
      .values({ personalOwnerId: owner })
      .returning({ id: workspaces.id });
    await db.insert(workspaceMembers).values({
      workspaceId: workspace!.id,
      userId: owner,
      role: "owner",
    });
    const dispatcher = new PostgresJobDispatcher(db, { clock: () => now });
    const service = new MaintenanceServiceImpl(db, dispatcher, createOperatorAuthorizer([actorId]));
    return { service, workspaceId: workspace!.id };
  }

  it("persists bounded workspace scans and binds duplicate keys to their exact payload", async () => {
    const { service, workspaceId } = await fixture();
    const first = await service.startSearchRebuild(
      actorId,
      { workspaceId, batchSize: 100 },
      `search-${randomUUID()}`,
      randomUUID(),
    );
    const [persisted] = await db.select().from(jobs).where(eq(jobs.id, first.jobId));

    expect(persisted).toMatchObject({
      workspaceId,
      type: "search.rebuild",
      payload: { workspaceId, scope: "workspace", batchSize: 100 },
    });
    await expect(
      service.startAssetCleanup(
        "normal-member",
        { workspaceId, batchSize: 1 },
        `asset-${randomUUID()}`,
        randomUUID(),
      ),
    ).rejects.toMatchObject({ code: "NOTE_NOT_FOUND", status: 404 });
  });

  it("scrubs dead-letter diagnostics and replays only the validated stored envelope", async () => {
    const { service, workspaceId } = await fixture();
    const sentinel = "s3://private-bucket/private-object-key";
    const deadLetterId = randomUUID();
    const backupJobId = randomUUID();
    const backupId = randomUUID();
    await db.insert(jobs).values([
      {
        id: deadLetterId,
        workspaceId,
        type: "search.rebuild",
        version: 1,
        payload: { workspaceId, scope: "workspace", batchSize: 10 },
        status: "dead_letter",
        attempts: 5,
        maxAttempts: 5,
        deadLetteredAt: new Date(now + 1_000),
        lastError: `JOB_FAILED ${sentinel}`,
        createdAt: new Date(now + 1_000),
        updatedAt: new Date(now + 1_000),
      },
      {
        id: backupJobId,
        workspaceId: null,
        type: "backup.verify",
        version: 1,
        payload: { workspaceId: null, backupId },
        status: "dead_letter",
        attempts: 5,
        maxAttempts: 5,
        deadLetteredAt: new Date(now + 2_000),
        lastError: `JOB_FAILED ${sentinel}`,
        createdAt: new Date(now + 2_000),
        updatedAt: new Date(now + 2_000),
      },
    ]);
    const cursor = encodeCursor({ createdAt: new Date(now).toISOString(), id: randomUUID() });

    const deadLetters = await service.listDeadLetters(actorId, { cursor, pageSize: 10 });
    const backup = await service.backupVerification(actorId, { cursor, pageSize: 10 });
    const replay = await service.replayDeadLetter(
      actorId,
      deadLetterId,
      `replay-${randomUUID()}`,
      randomUUID(),
    );

    expect(deadLetters.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: deadLetterId, errorCode: "JOB_FAILED" }),
      ]),
    );
    expect(backup.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ jobId: backupJobId, backupId, errorCode: "JOB_FAILED" }),
      ]),
    );
    expect(JSON.stringify({ deadLetters, backup })).not.toContain(sentinel);
    expect(await db.select().from(jobs).where(eq(jobs.id, replay.jobId))).toEqual([
      expect.objectContaining({
        workspaceId,
        type: "search.rebuild",
        payload: { workspaceId, scope: "workspace", batchSize: 10 },
      }),
    ]);
  });
});
