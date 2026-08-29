import { randomBytes, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  IdempotencyStore,
  createDb,
  idempotencyRecords,
  notes,
  runDatabaseMigrations,
  shareLinks,
  user,
  verifyMigrationBaseline,
  workspaceMembers,
  workspaces,
  type Database,
} from "@glyphquire/database";
import type {
  EnqueueJobInput,
  JobDatabaseExecutor,
  JobDispatcher,
  JobRegistry,
} from "@glyphquire/queue";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PublicApiError } from "../../middleware/error-handler.js";
import {
  ShareLinkServiceImpl,
  constantTimeShareHashEquals,
  hashShareToken,
  type ShareLinkServiceHooks,
} from "./ShareLinkService.js";

const migrationDatabaseUrl = process.env.TEST_MIGRATION_DATABASE_URL;
const runtimeDatabaseUrl = process.env.TEST_DATABASE_URL;
const describeWithPostgres = migrationDatabaseUrl && runtimeDatabaseUrl ? describe : describe.skip;
const BASE_URL = "https://glyphquire.example";
const START = Date.parse("2026-08-29T00:00:00.000Z");
const migrationsDirectory = fileURLToPath(
  new URL("../../../../../packages/database/src/migrations/", import.meta.url),
);

class FakeJobDispatcher implements JobDispatcher {
  readonly enqueued: EnqueueJobInput<never>[] = [];

  withDatabaseExecutor(_executor: JobDatabaseExecutor): JobDispatcher {
    return this;
  }

  async enqueue<TType extends never>(
    input: EnqueueJobInput<TType>,
  ): Promise<{ id: string; duplicate: boolean }> {
    this.enqueued.push(input as EnqueueJobInput<never>);
    return { id: randomUUID(), duplicate: false };
  }

  async dispatchBatch(_registry: JobRegistry) {
    return { claimed: 0, succeeded: 0, retried: 0, deadLettered: 0 };
  }
}

async function captureApiError(operation: () => Promise<unknown>) {
  try {
    await operation();
  } catch (error) {
    if (error instanceof PublicApiError) {
      return { code: error.code, status: error.status, message: error.publicMessage };
    }
    throw error;
  }
  throw new Error("expected operation to fail");
}

describeWithPostgres("ShareLinkService", () => {
  let db: Database;
  let admin: Database;
  let databaseName: string;
  let now = START;
  let randomCalls = 0;
  const encryptionKey = randomBytes(32).toString("base64url");
  const hashKey = randomBytes(32);

  beforeAll(async () => {
    const migrationBase = new URL(migrationDatabaseUrl!);
    const runtimeBase = new URL(runtimeDatabaseUrl!);
    if (
      !["127.0.0.1", "localhost", "[::1]"].includes(migrationBase.hostname) ||
      migrationBase.hostname !== runtimeBase.hostname ||
      (migrationBase.port || "5432") !== (runtimeBase.port || "5432")
    ) {
      throw new Error("Share-link integration requires one loopback PostgreSQL server");
    }
    const runtimeRole = decodeURIComponent(runtimeBase.username);
    if (!/^[a-z_][a-z0-9_]{0,62}$/u.test(runtimeRole)) {
      throw new Error("Runtime database role must be a simple PostgreSQL identifier");
    }

    databaseName = `glyphquire_share_service_${randomUUID().replaceAll("-", "")}`;
    admin = createDb(migrationDatabaseUrl!);
    await admin.execute(sql.raw(`create database "${databaseName}"`));
    const migrationUrl = new URL(migrationBase);
    migrationUrl.pathname = `/${databaseName}`;
    await verifyMigrationBaseline(migrationUrl.toString(), migrationsDirectory);
    const migrationDb = createDb(migrationUrl.toString());
    try {
      await runDatabaseMigrations(migrationDb, { migrationsFolder: migrationsDirectory });
      await migrationDb.execute(sql.raw(`grant usage on schema public to "${runtimeRole}"`));
      await migrationDb.execute(
        sql.raw(
          `grant select, insert, update, delete on all tables in schema public to "${runtimeRole}"`,
        ),
      );
      await migrationDb.execute(
        sql.raw(`grant usage on all sequences in schema public to "${runtimeRole}"`),
      );
    } finally {
      await migrationDb.$client.end();
    }
    runtimeBase.pathname = `/${databaseName}`;
    db = createDb(runtimeBase.toString());
  });

  afterAll(async () => {
    await db?.$client.end();
    if (admin && databaseName) {
      await admin.execute(sql`
        select pg_catalog.pg_terminate_backend(activity.pid)
        from pg_catalog.pg_stat_activity activity
        where activity.datname = ${databaseName}
          and activity.pid <> pg_catalog.pg_backend_pid()
      `);
      await admin.execute(sql.raw(`drop database "${databaseName}"`));
      await admin.$client.end();
    }
  });

  async function insertActor(label: string): Promise<string> {
    const id = `${label}-${randomUUID()}`;
    await db.insert(user).values({ id, name: label, email: `${id}@example.test` });
    return id;
  }

  async function fixture() {
    const owner = await insertActor("share-owner");
    const editor = await insertActor("share-editor");
    const outsider = await insertActor("share-outsider");
    const otherOwner = await insertActor("share-other-owner");
    const [workspace] = await db
      .insert(workspaces)
      .values({ personalOwnerId: owner })
      .returning({ id: workspaces.id });
    const [otherWorkspace] = await db
      .insert(workspaces)
      .values({ personalOwnerId: otherOwner })
      .returning({ id: workspaces.id });
    await db.insert(workspaceMembers).values([
      { workspaceId: workspace!.id, userId: owner, role: "owner" },
      { workspaceId: workspace!.id, userId: editor, role: "editor" },
      { workspaceId: otherWorkspace!.id, userId: otherOwner, role: "owner" },
    ]);
    const [note] = await db
      .insert(notes)
      .values({
        workspaceId: workspace!.id,
        ownerId: owner,
        title: "Shared title",
        contentMarkdown: "---\nglyphquire-spec: 1\n---\n\n# Shared body\n",
        contentHash: "share-source",
      })
      .returning({ id: notes.id });
    const [otherNote] = await db
      .insert(notes)
      .values({
        workspaceId: otherWorkspace!.id,
        ownerId: otherOwner,
        title: "Other title",
        contentMarkdown: "Other body",
        contentHash: "share-other-source",
      })
      .returning({ id: notes.id });
    return {
      owner,
      editor,
      outsider,
      otherOwner,
      workspaceId: workspace!.id,
      otherWorkspaceId: otherWorkspace!.id,
      noteId: note!.id,
      otherNoteId: otherNote!.id,
    };
  }

  function service(
    dispatcher = new FakeJobDispatcher(),
    hooks?: ShareLinkServiceHooks,
  ): ShareLinkServiceImpl {
    const idempotency = new IdempotencyStore(db, {
      encryptionKey,
      clock: () => now,
    });
    return new ShareLinkServiceImpl(db, idempotency, dispatcher, {
      tokenHashKey: hashKey,
      publicBaseUrl: BASE_URL,
      deleteGraceSeconds: 3_600,
      clock: () => now,
      randomBytes(size) {
        randomCalls += 1;
        expect(size).toBe(32);
        return randomBytes(size);
      },
      hooks,
    });
  }

  it("mints a canonical 32-byte CSPRNG token and persists only its domain-separated hash", async () => {
    const scope = await fixture();
    now = START;
    randomCalls = 0;
    const api = service();

    const result = await api.create(scope.owner, scope.noteId, {}, randomUUID());

    expect(result.token).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(Buffer.from(result.token, "base64url")).toHaveLength(32);
    expect(result.url).toBe(`${BASE_URL}/api/v1/shared/${result.token}`);
    expect(randomCalls).toBe(1);
    const [row] = await db.select().from(shareLinks).where(eq(shareLinks.id, result.id));
    expect(row).toMatchObject({
      workspaceId: scope.workspaceId,
      noteId: scope.noteId,
      creatorId: scope.owner,
      scopeType: "note",
      tokenHash: hashShareToken(result.token, hashKey),
      expiresAt: null,
      revokedAt: null,
    });
    expect(row!.tokenHash).toMatch(/^[0-9a-f]{64}$/u);
    expect(JSON.stringify(row)).not.toContain(result.token);

    const [record] = await db
      .select({ responseCiphertext: idempotencyRecords.responseCiphertext })
      .from(idempotencyRecords)
      .where(eq(idempotencyRecords.workspaceId, scope.workspaceId));
    expect(record!.responseCiphertext).toBeTruthy();
    expect(record!.responseCiphertext).not.toContain(result.token);
  });

  it("replays the original encrypted response and rejects same-key request reuse without minting", async () => {
    const scope = await fixture();
    now = START;
    randomCalls = 0;
    const api = service();
    const key = randomUUID();
    const expiresAt = new Date(now + 60_000).toISOString();

    const first = await api.create(scope.owner, scope.noteId, { expiresAt }, key);
    const replay = await api.create(scope.owner, scope.noteId, { expiresAt }, key);
    expect(replay).toEqual(first);
    expect(randomCalls).toBe(1);
    expect(
      await db.select().from(shareLinks).where(eq(shareLinks.workspaceId, scope.workspaceId)),
    ).toHaveLength(1);

    const reused = await captureApiError(() =>
      api.create(
        scope.owner,
        scope.noteId,
        { expiresAt: new Date(now + 120_000).toISOString() },
        key,
      ),
    );
    expect(reused).toMatchObject({ code: "OPERATION_REUSED", status: 409 });
    expect(randomCalls).toBe(1);
    expect(
      await db.select().from(shareLinks).where(eq(shareLinks.workspaceId, scope.workspaceId)),
    ).toHaveLength(1);
  });

  it("recovers the same token after a crash between encrypted completion and row insertion", async () => {
    const scope = await fixture();
    now = START;
    randomCalls = 0;
    let crash = true;
    const api = service(new FakeJobDispatcher(), {
      afterIdempotencyComplete() {
        if (crash) {
          crash = false;
          throw new Error("simulated crash after encrypted completion");
        }
      },
    });
    const key = randomUUID();

    await expect(api.create(scope.owner, scope.noteId, {}, key)).rejects.toThrow(
      "simulated crash after encrypted completion",
    );
    expect(
      await db.select().from(shareLinks).where(eq(shareLinks.workspaceId, scope.workspaceId)),
    ).toHaveLength(0);

    const recovered = await api.create(scope.owner, scope.noteId, {}, key);
    expect(recovered.token).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(randomCalls).toBe(1);
    expect(
      await db.select().from(shareLinks).where(eq(shareLinks.workspaceId, scope.workspaceId)),
    ).toHaveLength(1);
  });

  it("requires the current note owner and workspace membership for management", async () => {
    const scope = await fixture();
    const api = service();

    for (const actorId of [scope.editor, scope.outsider, scope.otherOwner]) {
      const error = await captureApiError(() =>
        api.create(actorId, scope.noteId, {}, randomUUID()),
      );
      expect(error).toMatchObject({ code: "SHARE_NOT_FOUND", status: 404 });
    }

    const created = await api.create(scope.owner, scope.noteId, {}, randomUUID());
    const crossWorkspace = await captureApiError(() => api.revoke(scope.otherOwner, created.id));
    expect(crossWorkspace).toMatchObject({ code: "SHARE_NOT_FOUND", status: 404 });
    const editor = await captureApiError(() => api.revoke(scope.editor, created.id));
    expect(editor).toMatchObject({ code: "SHARE_NOT_FOUND", status: 404 });
  });

  it("returns only the read-only note projection and rechecks expiry at every request", async () => {
    const scope = await fixture();
    now = START;
    const api = service();
    const expiresAt = new Date(START + 1_000).toISOString();
    const created = await api.create(scope.owner, scope.noteId, { expiresAt }, randomUUID());

    now = START + 999;
    expect(await api.resolve(created.token)).toEqual({
      noteId: scope.noteId,
      title: "Shared title",
      contentMarkdown: "---\nglyphquire-spec: 1\n---\n\n# Shared body\n",
      schemaVersion: 1,
      updatedAt: expect.any(String),
    });

    now = START + 1_000;
    const atExpiry = await captureApiError(() => api.resolve(created.token));
    expect(atExpiry).toMatchObject({ code: "SHARE_NOT_FOUND", status: 404 });
    now = START + 1_001;
    const afterExpiry = await captureApiError(() => api.resolve(created.token));
    expect(afterExpiry).toEqual(atExpiry);
  });

  it("uniformly rejects sequential ids, malformed tokens, deleted notes, and stale creator membership", async () => {
    const scope = await fixture();
    now = START;
    const api = service();
    const malformedResults = await Promise.all(
      [scope.noteId, randomUUID(), "a".repeat(42), "a".repeat(44), "!".repeat(43)].map(
        async (token) => captureApiError(() => api.resolve(token)),
      ),
    );
    expect(malformedResults).toEqual(
      malformedResults.map(() => ({
        code: "SHARE_NOT_FOUND",
        status: 404,
        message: "Share link not found",
      })),
    );

    const deleted = await api.create(scope.owner, scope.noteId, {}, randomUUID());
    await db
      .update(notes)
      .set({ deletedAt: new Date(now), revision: sql`${notes.revision} + 1` })
      .where(eq(notes.id, scope.noteId));
    expect(await captureApiError(() => api.resolve(deleted.token))).toMatchObject({
      code: "SHARE_NOT_FOUND",
      status: 404,
    });

    await db
      .update(notes)
      .set({ deletedAt: null, revision: sql`${notes.revision} + 1` })
      .where(eq(notes.id, scope.noteId));
    const membership = await api.create(scope.owner, scope.noteId, {}, randomUUID());
    await db
      .delete(workspaceMembers)
      .where(
        and(
          eq(workspaceMembers.workspaceId, scope.workspaceId),
          eq(workspaceMembers.userId, scope.owner),
        ),
      );
    expect(await captureApiError(() => api.resolve(membership.token))).toMatchObject({
      code: "SHARE_NOT_FOUND",
      status: 404,
    });
  });

  it("revokes immediately, emits one delayed targeted cleanup job, and remains idempotent", async () => {
    const scope = await fixture();
    now = START;
    const dispatcher = new FakeJobDispatcher();
    const api = service(dispatcher);
    const created = await api.create(scope.owner, scope.noteId, {}, randomUUID());

    await api.revoke(scope.owner, created.id);
    await api.revoke(scope.owner, created.id);
    expect(await captureApiError(() => api.resolve(created.token))).toMatchObject({
      code: "SHARE_NOT_FOUND",
      status: 404,
    });
    const [row] = await db.select().from(shareLinks).where(eq(shareLinks.id, created.id));
    expect(row!.revokedAt?.toISOString()).toBe(new Date(now).toISOString());
    expect(dispatcher.enqueued).toEqual([
      expect.objectContaining({
        workspaceId: scope.workspaceId,
        type: "share.cleanup",
        payload: {
          workspaceId: scope.workspaceId,
          scope: "one",
          shareLinkId: created.id,
        },
        idempotencyKey: `share-cleanup-${created.id}`,
        runAt: new Date(now + 3_600_000),
      }),
    ]);
  });

  it("uses fixed-length constant-time comparison for canonical token hashes", () => {
    const token = randomBytes(32).toString("base64url");
    const same = hashShareToken(token, hashKey);
    const different = hashShareToken(randomBytes(32).toString("base64url"), hashKey);
    expect(constantTimeShareHashEquals(same, same)).toBe(true);
    expect(constantTimeShareHashEquals(same, different)).toBe(false);
    expect(constantTimeShareHashEquals(same, "not-a-hash")).toBe(false);
  });
});
