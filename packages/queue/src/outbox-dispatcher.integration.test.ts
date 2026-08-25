import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createDb,
  documentJobs,
  noteOperations,
  notes,
  user,
  workspaceMembers,
  workspaces,
  type Database,
  type DocumentJob,
  type DocumentJobStatus,
} from "@glyphquire/database";
import { eq } from "drizzle-orm";
import { isCurrentRevision } from "./document-jobs.js";
import { PostgresDocumentJobDispatcher } from "./outbox-dispatcher.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const describeWithPostgres = databaseUrl ? describe : describe.skip;

function idFor(prefix: string) {
  return `${prefix}-${randomUUID()}`;
}

async function insertActor(db: Database, prefix: string) {
  const id = idFor(prefix);
  await db.insert(user).values({ id, name: prefix, email: `${id}@example.test` });
  return id;
}

async function insertWorkspace(db: Database, ownerId: string) {
  const [workspace] = await db
    .insert(workspaces)
    .values({ personalOwnerId: ownerId })
    .returning({ id: workspaces.id });
  await db
    .insert(workspaceMembers)
    .values({ workspaceId: workspace!.id, userId: ownerId, role: "owner" });
  return workspace!.id;
}

async function insertNote(db: Database, workspaceId: string, ownerId: string) {
  const [note] = await db
    .insert(notes)
    .values({
      workspaceId,
      title: "Untitled",
      contentMarkdown: "# Body",
      contentHash: "h",
      ownerId,
    })
    .returning();
  return note!;
}

async function insertOperation(
  db: Database,
  workspaceId: string,
  noteId: string,
  actorId: string,
  baseRevision: number,
) {
  const [operation] = await db
    .insert(noteOperations)
    .values({
      workspaceId,
      noteId,
      actorId,
      operationId: randomUUID(),
      operationKind: "save",
      baseRevision,
      requestHash: idFor("hash"),
      recordedResponse: {},
    })
    .returning();
  return operation!;
}

interface JobFixture {
  db: Database;
  workspaceId: string;
  noteId: string;
  ownerId: string;
}

async function buildJobFixture(db: Database): Promise<JobFixture> {
  const owner = await insertActor(db, "owner");
  const workspaceId = await insertWorkspace(db, owner);
  const note = await insertNote(db, workspaceId, owner);
  return { db, workspaceId, noteId: note.id, ownerId: owner };
}

/**
 * Inserts a document_jobs row via its own freshly-created note_operations
 * row, since document_jobs' composite FK requires (noteOperationId,
 * workspaceId, noteId, operationId) to reference a real operation.
 */
async function insertJob(
  fixture: JobFixture,
  overrides: Partial<{
    revision: number;
    status: DocumentJobStatus;
    attempts: number;
    availableAt: Date;
    lockedAt: Date | null;
    lockedBy: string | null;
    completedAt: Date | null;
    deadLetteredAt: Date | null;
  }> = {},
) {
  const revision = overrides.revision ?? 1;
  const operation = await insertOperation(
    fixture.db,
    fixture.workspaceId,
    fixture.noteId,
    fixture.ownerId,
    revision,
  );
  const [job] = await fixture.db
    .insert(documentJobs)
    .values({
      workspaceId: fixture.workspaceId,
      noteId: fixture.noteId,
      noteOperationId: operation.id,
      operationId: operation.operationId,
      revision,
      kind: "upsert",
      status: overrides.status ?? "pending",
      attempts: overrides.attempts ?? 0,
      availableAt: overrides.availableAt ?? new Date(),
      lockedAt: overrides.lockedAt ?? null,
      lockedBy: overrides.lockedBy ?? null,
      completedAt: overrides.completedAt ?? null,
      deadLetteredAt: overrides.deadLetteredAt ?? null,
    })
    .returning();
  return job!;
}

async function reloadJob(db: Database, jobId: string) {
  const row = await db.query.documentJobs.findFirst({
    where: (table, { eq: whereEq }) => whereEq(table.id, jobId),
  });
  if (!row) throw new Error("job row disappeared");
  return row;
}

describeWithPostgres("PostgresDocumentJobDispatcher", () => {
  let db: Database;

  beforeAll(() => {
    db = createDb(databaseUrl!);
  });

  afterAll(async () => {
    await db.$client.end();
  });

  // `document_jobs` rows can never be deleted (a DB trigger rejects DELETE
  // unconditionally), and this suite runs against a shared dev database
  // that earlier suites (NoteWriter's) also populate. Every test below
  // therefore uses a large batchSize so its own fixture rows are always
  // swept regardless of unrelated backlog, and asserts outcomes only for
  // the specific job ids it created — never a bare global `summary` count,
  // which an already-populated table (or a concurrently running sibling
  // test run) would make flaky.
  const SWEEP_BATCH_SIZE = 10_000;

  it("claims a due pending job and marks it completed on success", async () => {
    const fixture = await buildJobFixture(db);
    const job = await insertJob(fixture);
    const dispatcher = new PostgresDocumentJobDispatcher(db, { batchSize: SWEEP_BATCH_SIZE });

    const handled: DocumentJob[] = [];
    await dispatcher.dispatchBatch(async (claimedJob) => {
      handled.push(claimedJob);
    });

    expect(handled.some((claimedJob) => claimedJob.id === job.id)).toBe(true);
    const reloaded = await reloadJob(db, job.id);
    expect(reloaded.status).toBe("completed");
    expect(reloaded.attempts).toBe(1);
    expect(reloaded.lockedAt).toBeNull();
    expect(reloaded.lockedBy).toBeNull();
    expect(reloaded.completedAt).not.toBeNull();
  });

  it("does not claim a job whose availableAt is in the future", async () => {
    const fixture = await buildJobFixture(db);
    const job = await insertJob(fixture, { availableAt: new Date(Date.now() + 60 * 60 * 1000) });
    const dispatcher = new PostgresDocumentJobDispatcher(db, { batchSize: SWEEP_BATCH_SIZE });

    const handled: string[] = [];
    await dispatcher.dispatchBatch(async (claimedJob) => {
      handled.push(claimedJob.id);
    });

    expect(handled).not.toContain(job.id);
    const reloaded = await reloadJob(db, job.id);
    expect(reloaded.status).toBe("pending");
    expect(reloaded.lockedAt).toBeNull();
  });

  it("never dispatches an already-completed job again (idempotent dispatch)", async () => {
    const fixture = await buildJobFixture(db);
    const job = await insertJob(fixture);
    const dispatcher = new PostgresDocumentJobDispatcher(db, { batchSize: SWEEP_BATCH_SIZE });

    let ownInvocations = 0;
    const handler = async (claimedJob: DocumentJob) => {
      if (claimedJob.id === job.id) ownInvocations += 1;
    };
    await dispatcher.dispatchBatch(handler);
    await dispatcher.dispatchBatch(handler);

    expect(ownInvocations).toBe(1);
    expect((await reloadJob(db, job.id)).status).toBe("completed");
  });

  it("reschedules a failing job as pending with exponential backoff and records the error", async () => {
    const fixture = await buildJobFixture(db);
    const job = await insertJob(fixture);
    const fixedNow = Date.parse("2026-01-01T00:00:00.000Z");
    const dispatcher = new PostgresDocumentJobDispatcher(db, {
      batchSize: SWEEP_BATCH_SIZE,
      maxAttempts: 5,
      backoffMs: () => 30_000,
      clock: () => fixedNow,
    });

    // Only fail the job under test; unrelated swept rows succeed as no-ops
    // so this dispatch pass never leaves other backlog rows stuck.
    await dispatcher.dispatchBatch(async (claimedJob) => {
      if (claimedJob.id === job.id) throw new Error("derived-state write failed");
    });

    const reloaded = await reloadJob(db, job.id);
    expect(reloaded.status).toBe("pending");
    expect(reloaded.attempts).toBe(1);
    expect(reloaded.lastError).toBe("derived-state write failed");
    expect(reloaded.lockedAt).toBeNull();
    expect(reloaded.lockedBy).toBeNull();
    expect(reloaded.availableAt.getTime()).toBe(fixedNow + 30_000);
  });

  it("dead-letters a job once attempts reach the configured maximum", async () => {
    const fixture = await buildJobFixture(db);
    const job = await insertJob(fixture, { attempts: 2 });
    const dispatcher = new PostgresDocumentJobDispatcher(db, {
      batchSize: SWEEP_BATCH_SIZE,
      maxAttempts: 3,
      backoffMs: () => 1,
    });

    // First failing attempt for this row: attempts becomes 3, which meets
    // maxAttempts -> dead letter. Unrelated swept rows succeed as no-ops.
    await dispatcher.dispatchBatch(async (claimedJob) => {
      if (claimedJob.id === job.id) throw new Error("permanently broken");
    });

    const reloaded = await reloadJob(db, job.id);
    expect(reloaded.status).toBe("dead_letter");
    expect(reloaded.attempts).toBe(3);
    expect(reloaded.deadLetteredAt).not.toBeNull();
    expect(reloaded.lastError).toBe("permanently broken");

    // A dead-lettered job is terminal: it is never claimed again.
    const handledAgain: string[] = [];
    await dispatcher.dispatchBatch(async (claimedJob) => {
      handledAgain.push(claimedJob.id);
    });
    expect(handledAgain).not.toContain(job.id);
    expect((await reloadJob(db, job.id)).attempts).toBe(3);
  });

  it("reclaims a job whose processing lock is older than the lock timeout (crash recovery)", async () => {
    const fixture = await buildJobFixture(db);
    const job = await insertJob(fixture, {
      status: "processing",
      attempts: 1,
      lockedAt: new Date(Date.now() - 10 * 60 * 1000),
      lockedBy: "crashed-dispatcher",
    });
    const dispatcher = new PostgresDocumentJobDispatcher(db, {
      batchSize: SWEEP_BATCH_SIZE,
      lockTimeoutMs: 60_000,
    });

    const handled: string[] = [];
    await dispatcher.dispatchBatch(async (claimedJob) => {
      handled.push(claimedJob.id);
    });

    expect(handled).toContain(job.id);
    const reloaded = await reloadJob(db, job.id);
    expect(reloaded.status).toBe("completed");
    expect(reloaded.attempts).toBe(2);
    expect(reloaded.lockedBy).toBeNull();
  });

  it("does not reclaim a job whose processing lock is still fresh", async () => {
    const fixture = await buildJobFixture(db);
    const job = await insertJob(fixture, {
      status: "processing",
      attempts: 1,
      lockedAt: new Date(),
      lockedBy: "live-dispatcher",
    });
    const dispatcher = new PostgresDocumentJobDispatcher(db, {
      batchSize: SWEEP_BATCH_SIZE,
      lockTimeoutMs: 60_000,
    });

    const handled: string[] = [];
    await dispatcher.dispatchBatch(async (claimedJob) => {
      handled.push(claimedJob.id);
    });

    expect(handled).not.toContain(job.id);
    const reloaded = await reloadJob(db, job.id);
    expect(reloaded.status).toBe("processing");
    expect(reloaded.lockedBy).toBe("live-dispatcher");
  });

  it("claims each of several due rows exactly once across two concurrent dispatchers", async () => {
    const fixture = await buildJobFixture(db);
    const jobs = await Promise.all(Array.from({ length: 8 }, () => insertJob(fixture)));
    const dispatcherA = new PostgresDocumentJobDispatcher(db, {
      dispatcherId: "dispatcher-a",
      batchSize: SWEEP_BATCH_SIZE,
    });
    const dispatcherB = new PostgresDocumentJobDispatcher(db, {
      dispatcherId: "dispatcher-b",
      batchSize: SWEEP_BATCH_SIZE,
    });

    const invocationCounts = new Map<string, number>();
    const handler = async (job: DocumentJob) => {
      invocationCounts.set(job.id, (invocationCounts.get(job.id) ?? 0) + 1);
    };

    await Promise.all([dispatcherA.dispatchBatch(handler), dispatcherB.dispatchBatch(handler)]);

    for (const job of jobs) {
      expect(invocationCounts.get(job.id)).toBe(1);
      expect((await reloadJob(db, job.id)).status).toBe("completed");
    }
  });

  it("does not deadlock or double-claim when two dispatches overlap concurrently", async () => {
    const fixture = await buildJobFixture(db);
    const jobA = await insertJob(fixture);
    const jobB = await insertJob(fixture);
    const dispatcher = new PostgresDocumentJobDispatcher(db, { batchSize: SWEEP_BATCH_SIZE });

    const invocationCounts = new Map<string, number>();
    const handler = async (job: DocumentJob) => {
      invocationCounts.set(job.id, (invocationCounts.get(job.id) ?? 0) + 1);
    };

    await Promise.all([dispatcher.dispatchBatch(handler), dispatcher.dispatchBatch(handler)]);

    expect(invocationCounts.get(jobA.id)).toBe(1);
    expect(invocationCounts.get(jobB.id)).toBe(1);
  });
});

describeWithPostgres("isCurrentRevision", () => {
  let db: Database;

  beforeAll(() => {
    db = createDb(databaseUrl!);
  });

  afterAll(async () => {
    await db.$client.end();
  });

  it("proves whether a captured revision still matches the note's current revision", async () => {
    const owner = await insertActor(db, "owner");
    const workspaceId = await insertWorkspace(db, owner);
    const note = await insertNote(db, workspaceId, owner);

    expect(await isCurrentRevision(db, note.id, note.revision)).toBe(true);
    expect(await isCurrentRevision(db, note.id, note.revision + 1)).toBe(false);

    await db
      .update(notes)
      .set({ revision: note.revision + 1 })
      .where(eq(notes.id, note.id));
    expect(await isCurrentRevision(db, note.id, note.revision)).toBe(false);
    expect(await isCurrentRevision(db, note.id, note.revision + 1)).toBe(true);
  });

  it("returns false for a note that does not exist", async () => {
    expect(await isCurrentRevision(db, randomUUID(), 1)).toBe(false);
  });
});
