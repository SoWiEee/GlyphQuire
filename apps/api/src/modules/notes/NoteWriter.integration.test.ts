import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createDb,
  documentJobs,
  noteOperations,
  notes,
  noteVersions,
  user,
  workspaceMembers,
  workspaces,
  type Database,
} from "@glyphquire/database";
import { MAX_MARKDOWN_BYTES } from "@glyphquire/api-contract";
import { eq } from "drizzle-orm";
import { PublicApiError } from "../../middleware/error-handler.js";
import { SNAPSHOT_ABSOLUTE_TRIGGER_BYTES, SNAPSHOT_TIME_TRIGGER_MS } from "./snapshot-policy.js";
import { NoteSaveConflictError, NoteWriter, type NoteWriterHooks } from "./NoteWriter.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const describeWithPostgres = databaseUrl ? describe : describe.skip;

const HOOK_POINTS: (keyof NoteWriterHooks)[] = [
  "afterAuthorization",
  "afterValidation",
  "beforeNoteChange",
  "afterNoteChange",
  "beforeSnapshotInsert",
  "afterSnapshotInsert",
  "beforeOperationInsert",
  "afterOperationInsert",
  "beforeDocumentJobInsert",
  "afterDocumentJobInsert",
];

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

interface Fixture {
  owner: string;
  outsider: string;
  workspaceId: string;
}

async function buildFixture(db: Database): Promise<Fixture> {
  const owner = await insertActor(db, "owner");
  const outsider = await insertActor(db, "outsider");
  const workspaceId = await insertWorkspace(db, owner);
  return { owner, outsider, workspaceId };
}

async function insertNote(
  db: Database,
  workspaceId: string,
  ownerId: string,
  contentMarkdown = "# Body",
) {
  const [note] = await db
    .insert(notes)
    .values({
      workspaceId,
      title: "Untitled",
      contentMarkdown,
      contentHash: "seed-hash",
      ownerId,
    })
    .returning();
  return note!;
}

async function snapshotRowsFor(db: Database, noteId: string) {
  return db.select().from(noteVersions).where(eq(noteVersions.noteId, noteId));
}

async function operationRowsFor(db: Database, noteId: string) {
  return db.select().from(noteOperations).where(eq(noteOperations.noteId, noteId));
}

async function jobRowsFor(db: Database, noteId: string) {
  return db.select().from(documentJobs).where(eq(documentJobs.noteId, noteId));
}

async function captureApiError(fn: () => Promise<unknown>) {
  try {
    await fn();
  } catch (error) {
    if (error instanceof PublicApiError) return { code: error.code, status: error.status };
    throw error;
  }
  throw new Error("expected the call to reject");
}

describeWithPostgres("NoteWriter", () => {
  let db: Database;
  let writer: NoteWriter;

  beforeAll(() => {
    db = createDb(databaseUrl!);
    writer = new NoteWriter(db);
  });

  afterAll(async () => {
    await db.$client.end();
  });

  describe("save", () => {
    it("updates content, bumps revision, and records no snapshot below every trigger", async () => {
      const fixture = await buildFixture(db);
      const note = await insertNote(db, fixture.workspaceId, fixture.owner);

      const result = await writer.save(fixture.owner, note.id, {
        operationId: randomUUID(),
        baseRevision: note.revision,
        contentMarkdown: "# Small edit",
      });

      expect(result.contentMarkdown).toBe("# Small edit");
      expect(result.revision).toBe(note.revision + 1);
      expect(await snapshotRowsFor(db, note.id)).toHaveLength(0);
      const jobs = await jobRowsFor(db, note.id);
      expect(jobs).toHaveLength(1);
      expect(jobs[0]).toMatchObject({ kind: "upsert", revision: result.revision });
    });

    it("snapshots once the absolute 10 KiB delta trigger is crossed with no prior snapshot", async () => {
      const fixture = await buildFixture(db);
      const note = await insertNote(db, fixture.workspaceId, fixture.owner, "");

      const belowThreshold = "a".repeat(SNAPSHOT_ABSOLUTE_TRIGGER_BYTES - 1);
      const below = await writer.save(fixture.owner, note.id, {
        operationId: randomUUID(),
        baseRevision: note.revision,
        contentMarkdown: belowThreshold,
      });
      expect(await snapshotRowsFor(db, note.id)).toHaveLength(0);

      const atThreshold = "a".repeat(SNAPSHOT_ABSOLUTE_TRIGGER_BYTES);
      const at = await writer.save(fixture.owner, note.id, {
        operationId: randomUUID(),
        baseRevision: below.revision,
        contentMarkdown: atThreshold,
      });
      const versions = await snapshotRowsFor(db, note.id);
      expect(versions).toHaveLength(1);
      expect(versions[0]).toMatchObject({
        reason: "autosave",
        revision: at.revision,
        contentMarkdown: atThreshold,
      });
    });

    it("snapshots via the five-minute time trigger even when the delta is tiny", async () => {
      const fixture = await buildFixture(db);
      const seedContent = "y".repeat(2000);
      const note = await insertNote(db, fixture.workspaceId, fixture.owner, seedContent);

      // `note_versions` rows are immutable (enforced by a DB trigger), so a
      // backdated "existing snapshot" baseline must be seeded at insert
      // time rather than aged via UPDATE after the fact.
      await db.insert(noteVersions).values({
        workspaceId: fixture.workspaceId,
        noteId: note.id,
        revision: note.revision,
        schemaVersion: note.schemaVersion,
        contentMarkdown: seedContent,
        contentHash: note.contentHash,
        reason: "autosave",
        createdById: fixture.owner,
        createdAt: new Date(Date.now() - SNAPSHOT_TIME_TRIGGER_MS),
      });

      // A one-byte delta is far under the 20% trigger (threshold is 400
      // bytes against a 2000-byte snapshot).
      const result = await writer.save(fixture.owner, note.id, {
        operationId: randomUUID(),
        baseRevision: note.revision,
        contentMarkdown: `${seedContent}z`,
      });

      const versions = await snapshotRowsFor(db, note.id);
      expect(versions).toHaveLength(2);
      expect(versions.some((v) => v.revision === result.revision)).toBe(true);
    });

    it("rejects markdown that fails Document Engine validation with an error diagnostic", async () => {
      const fixture = await buildFixture(db);
      const note = await insertNote(db, fixture.workspaceId, fixture.owner);

      const unsupportedVersion = "---\nglyphquire-spec: 999999\n---\n\n# Body\n";
      expect(
        await captureApiError(() =>
          writer.save(fixture.owner, note.id, {
            operationId: randomUUID(),
            baseRevision: note.revision,
            contentMarkdown: unsupportedVersion,
          }),
        ),
      ).toEqual({ code: "DOCUMENT_INVALID", status: 400 });

      const current = await db.query.notes.findFirst({ where: (t, { eq: e }) => e(t.id, note.id) });
      expect(current?.revision).toBe(note.revision);
    });

    it("rejects markdown over the exact UTF-8 byte limit", async () => {
      const fixture = await buildFixture(db);
      const note = await insertNote(db, fixture.workspaceId, fixture.owner);

      expect(
        await captureApiError(() =>
          writer.save(fixture.owner, note.id, {
            operationId: randomUUID(),
            baseRevision: note.revision,
            contentMarkdown: "a".repeat(MAX_MARKDOWN_BYTES + 1),
          }),
        ),
      ).toEqual({ code: "DOCUMENT_INVALID", status: 400 });
    });

    it("keeps every write atomic when a failure is injected at each step", async () => {
      const fixture = await buildFixture(db);
      const note = await insertNote(db, fixture.workspaceId, fixture.owner, "x".repeat(20_000));

      for (const point of HOOK_POINTS) {
        const operationId = randomUUID();
        const failingHooks: NoteWriterHooks = {
          [point]: () => {
            throw new Error(`injected ${point} failure`);
          },
        };
        const failingWriter = new NoteWriter(db, undefined, failingHooks);

        await expect(
          failingWriter.save(fixture.owner, note.id, {
            operationId,
            baseRevision: note.revision,
            contentMarkdown: "y".repeat(40_000), // crosses the size trigger, forcing the snapshot path too
          }),
        ).rejects.toThrow(`injected ${point} failure`);

        const current = await db.query.notes.findFirst({
          where: (t, { eq: e }) => e(t.id, note.id),
        });
        expect(current?.revision).toBe(note.revision);
        expect(current?.contentMarkdown).toBe(note.contentMarkdown);
        expect(await snapshotRowsFor(db, note.id)).toHaveLength(0);
        expect(await operationRowsFor(db, note.id)).toHaveLength(0);
        expect(await jobRowsFor(db, note.id)).toHaveLength(0);
      }
    });

    it("returns OPERATION_REUSED for the same operationId with a different canonical payload", async () => {
      const fixture = await buildFixture(db);
      const note = await insertNote(db, fixture.workspaceId, fixture.owner);
      const operationId = randomUUID();

      const first = await writer.save(fixture.owner, note.id, {
        operationId,
        baseRevision: note.revision,
        contentMarkdown: "# First",
      });
      expect(first.contentMarkdown).toBe("# First");

      expect(
        await captureApiError(() =>
          writer.save(fixture.owner, note.id, {
            operationId,
            baseRevision: note.revision,
            contentMarkdown: "# Different, same key",
          }),
        ),
      ).toEqual({ code: "OPERATION_REUSED", status: 409 });

      const current = await db.query.notes.findFirst({ where: (t, { eq: e }) => e(t.id, note.id) });
      expect(current?.contentMarkdown).toBe("# First");
    });

    it("resolves concurrent identical save requests to a single recorded response and a single write", async () => {
      const fixture = await buildFixture(db);
      const note = await insertNote(db, fixture.workspaceId, fixture.owner);
      const operationId = randomUUID();
      const input = { operationId, baseRevision: note.revision, contentMarkdown: "# Concurrent" };

      const [first, second] = await Promise.all([
        writer.save(fixture.owner, note.id, input),
        writer.save(fixture.owner, note.id, input),
      ]);

      expect(first).toEqual(second);
      expect(await operationRowsFor(db, note.id)).toHaveLength(1);
      expect(await jobRowsFor(db, note.id)).toHaveLength(1);
    });

    it("yields one success and one authorized rich conflict for concurrent distinct requests, and the loser writes nothing", async () => {
      const fixture = await buildFixture(db);
      const note = await insertNote(db, fixture.workspaceId, fixture.owner);
      const sentinelMarkdown = "# LOSER-SENTINEL-CONTENT-MUST-NOT-LEAK";

      const logs: string[] = [];
      const originalError = console.error;
      const originalLog = console.log;
      console.error = (...args: unknown[]) => logs.push(args.map(String).join(" "));
      console.log = (...args: unknown[]) => logs.push(args.map(String).join(" "));

      let outcomes: PromiseSettledResult<unknown>[];
      try {
        let releaseFirstUpdate!: () => void;
        const firstUpdate = new Promise<void>((resolve) => {
          releaseFirstUpdate = resolve;
        });
        let updateCount = 0;
        const orderedWriter = new NoteWriter(db, undefined, {
          afterNoteChange() {
            if (updateCount++ === 0) releaseFirstUpdate();
          },
        });

        // Let the winner acquire the row lock before starting the competing
        // transaction. The loser is still concurrent with the winner's
        // in-flight transaction, but the CAS outcome is deterministic.
        const winner = orderedWriter.save(fixture.owner, note.id, {
          operationId: randomUUID(),
          baseRevision: note.revision,
          contentMarkdown: "# Winner content",
        });
        await firstUpdate;
        const loser = orderedWriter.save(fixture.owner, note.id, {
          operationId: randomUUID(),
          baseRevision: note.revision,
          contentMarkdown: sentinelMarkdown,
        });
        outcomes = await Promise.allSettled([winner, loser]);
      } finally {
        console.error = originalError;
        console.log = originalLog;
      }

      const fulfilled = outcomes.filter((o) => o.status === "fulfilled");
      const rejected = outcomes.filter((o) => o.status === "rejected");
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);

      const winnerValue = (
        fulfilled[0] as PromiseFulfilledResult<{
          contentMarkdown: string;
          revision: number;
          updatedAt: string;
        }>
      ).value;
      const conflictError = (rejected[0] as PromiseRejectedResult).reason;
      expect(conflictError).toBeInstanceOf(NoteSaveConflictError);
      const conflict = (conflictError as NoteSaveConflictError).conflict;

      expect(conflict.noteId).toBe(note.id);
      expect(conflict.serverRevision).toBe(winnerValue.revision);
      expect(conflict.serverMarkdown).toBe(winnerValue.contentMarkdown);
      expect(conflict.serverUpdatedAt).toBe(winnerValue.updatedAt);
      expect(conflict.lastEditedBy).toEqual({ displayName: "owner" });
      // The loser's content must never surface anywhere, including logs.
      expect(conflict.serverMarkdown).not.toContain("LOSER-SENTINEL");
      expect(logs.join("\n")).not.toContain("LOSER-SENTINEL");

      expect(await operationRowsFor(db, note.id)).toHaveLength(1);
      expect(await jobRowsFor(db, note.id)).toHaveLength(1);
    });

    it("hides a save conflict behind NOTE_NOT_FOUND for a non-member outsider", async () => {
      const fixture = await buildFixture(db);
      const note = await insertNote(db, fixture.workspaceId, fixture.owner);

      expect(
        await captureApiError(() =>
          writer.save(fixture.outsider, note.id, {
            operationId: randomUUID(),
            baseRevision: note.revision,
            contentMarkdown: "# Outsider attempt",
          }),
        ),
      ).toEqual({ code: "NOTE_NOT_FOUND", status: 404 });
    });
  });

  describe("checkpoint", () => {
    it("always produces a version at the new revision and leaves content untouched", async () => {
      const fixture = await buildFixture(db);
      const note = await insertNote(db, fixture.workspaceId, fixture.owner, "# Stable content");

      const result = await writer.checkpoint(fixture.owner, note.id, {
        operationId: randomUUID(),
        baseRevision: note.revision,
      });

      expect(result.note.contentMarkdown).toBe("# Stable content");
      expect(result.note.revision).toBe(note.revision + 1);
      expect(result.version).toMatchObject({
        reason: "checkpoint",
        revision: result.note.revision,
        contentMarkdown: "# Stable content",
        createdBy: { displayName: "owner" },
      });

      const versions = await snapshotRowsFor(db, note.id);
      expect(versions).toHaveLength(1);
      const jobs = await jobRowsFor(db, note.id);
      expect(jobs).toHaveLength(1);
    });

    it("replays an identical concurrent checkpoint to one recorded response", async () => {
      const fixture = await buildFixture(db);
      const note = await insertNote(db, fixture.workspaceId, fixture.owner);
      const operationId = randomUUID();
      const input = { operationId, baseRevision: note.revision };

      const [first, second] = await Promise.all([
        writer.checkpoint(fixture.owner, note.id, input),
        writer.checkpoint(fixture.owner, note.id, input),
      ]);

      expect(first).toEqual(second);
      expect(await snapshotRowsFor(db, note.id)).toHaveLength(1);
      expect(await operationRowsFor(db, note.id)).toHaveLength(1);
    });

    it("rejects a stale baseRevision with REVISION_CONFLICT and writes nothing", async () => {
      const fixture = await buildFixture(db);
      const note = await insertNote(db, fixture.workspaceId, fixture.owner);
      await writer.checkpoint(fixture.owner, note.id, {
        operationId: randomUUID(),
        baseRevision: note.revision,
      });

      expect(
        await captureApiError(() =>
          writer.checkpoint(fixture.owner, note.id, {
            operationId: randomUUID(),
            baseRevision: note.revision, // now stale
          }),
        ),
      ).toEqual({ code: "REVISION_CONFLICT", status: 409 });

      expect(await snapshotRowsFor(db, note.id)).toHaveLength(1);
      expect(await operationRowsFor(db, note.id)).toHaveLength(1);
    });

    it("keeps every write atomic when a failure is injected at each step", async () => {
      const fixture = await buildFixture(db);
      const note = await insertNote(db, fixture.workspaceId, fixture.owner);

      for (const point of HOOK_POINTS) {
        const operationId = randomUUID();
        const failingHooks: NoteWriterHooks = {
          [point]: () => {
            throw new Error(`injected ${point} failure`);
          },
        };
        const failingWriter = new NoteWriter(db, undefined, failingHooks);

        await expect(
          failingWriter.checkpoint(fixture.owner, note.id, {
            operationId,
            baseRevision: note.revision,
          }),
        ).rejects.toThrow(`injected ${point} failure`);

        const current = await db.query.notes.findFirst({
          where: (t, { eq: e }) => e(t.id, note.id),
        });
        expect(current?.revision).toBe(note.revision);
        expect(await snapshotRowsFor(db, note.id)).toHaveLength(0);
        expect(await operationRowsFor(db, note.id)).toHaveLength(0);
        expect(await jobRowsFor(db, note.id)).toHaveLength(0);
      }
    });
  });

  describe("restoreVersion", () => {
    it("snapshots the current source first, applies historical markdown as a new revision, and never rewinds the counter", async () => {
      const fixture = await buildFixture(db);
      const note = await insertNote(db, fixture.workspaceId, fixture.owner, "# Original");

      const checkpointed = await writer.checkpoint(fixture.owner, note.id, {
        operationId: randomUUID(),
        baseRevision: note.revision,
      });
      const targetVersionId = checkpointed.version.id;
      const targetRevision = checkpointed.version.revision;

      const saved = await writer.save(fixture.owner, note.id, {
        operationId: randomUUID(),
        baseRevision: checkpointed.note.revision,
        contentMarkdown: "# Edited after checkpoint",
      });

      const restored = await writer.restoreVersion(fixture.owner, note.id, targetVersionId, {
        operationId: randomUUID(),
        baseRevision: saved.revision,
      });

      expect(restored.contentMarkdown).toBe("# Original");
      // The counter always advances; it never rewinds to targetRevision.
      expect(restored.revision).toBe(saved.revision + 1);
      expect(restored.revision).toBeGreaterThan(targetRevision);

      const versions = await snapshotRowsFor(db, note.id);
      // 1) the "checkpoint" version, 2) the pre-restore safety snapshot of
      // "# Edited after checkpoint" at `saved.revision`, 3) the "restore"
      // version at the new revision.
      expect(versions).toHaveLength(3);
      const preRestoreSnapshot = versions.find((v) => v.revision === saved.revision);
      expect(preRestoreSnapshot).toMatchObject({
        reason: "autosave",
        contentMarkdown: "# Edited after checkpoint",
      });
      const restoreSnapshot = versions.find((v) => v.revision === restored.revision);
      expect(restoreSnapshot).toMatchObject({ reason: "restore", contentMarkdown: "# Original" });
    });

    it("returns NOTE_NOT_FOUND for a version belonging to a different note", async () => {
      const fixture = await buildFixture(db);
      const noteA = await insertNote(db, fixture.workspaceId, fixture.owner);
      const noteB = await insertNote(db, fixture.workspaceId, fixture.owner);
      const checkpointed = await writer.checkpoint(fixture.owner, noteB.id, {
        operationId: randomUUID(),
        baseRevision: noteB.revision,
      });

      expect(
        await captureApiError(() =>
          writer.restoreVersion(fixture.owner, noteA.id, checkpointed.version.id, {
            operationId: randomUUID(),
            baseRevision: noteA.revision,
          }),
        ),
      ).toEqual({ code: "NOTE_NOT_FOUND", status: 404 });
    });

    it("keeps every write atomic when a failure is injected at each step, writing no partial version", async () => {
      const fixture = await buildFixture(db);
      const note = await insertNote(db, fixture.workspaceId, fixture.owner, "# Original");
      const checkpointed = await writer.checkpoint(fixture.owner, note.id, {
        operationId: randomUUID(),
        baseRevision: note.revision,
      });

      for (const point of HOOK_POINTS) {
        const operationId = randomUUID();
        const failingHooks: NoteWriterHooks = {
          [point]: () => {
            throw new Error(`injected ${point} failure`);
          },
        };
        const failingWriter = new NoteWriter(db, undefined, failingHooks);

        await expect(
          failingWriter.restoreVersion(fixture.owner, note.id, checkpointed.version.id, {
            operationId,
            baseRevision: checkpointed.note.revision,
          }),
        ).rejects.toThrow(`injected ${point} failure`);

        const current = await db.query.notes.findFirst({
          where: (t, { eq: e }) => e(t.id, note.id),
        });
        expect(current?.revision).toBe(checkpointed.note.revision);
        // Only the original checkpoint version must exist; no pre-restore
        // safety snapshot or restore version leaked from the rolled-back tx.
        expect(await snapshotRowsFor(db, note.id)).toHaveLength(1);
        const ops = await operationRowsFor(db, note.id);
        expect(ops.filter((o) => o.operationKind === "restore_version")).toHaveLength(0);
        const jobs = await jobRowsFor(db, note.id);
        expect(jobs.filter((j) => j.revision > checkpointed.note.revision)).toHaveLength(0);
      }
    });
  });

  describe("cross-workspace scoping", () => {
    it("does not leak a note across workspaces for any writer method", async () => {
      const fixtureA = await buildFixture(db);
      const fixtureB = await buildFixture(db);
      const note = await insertNote(db, fixtureA.workspaceId, fixtureA.owner);

      expect(
        await captureApiError(() =>
          writer.save(fixtureB.owner, note.id, {
            operationId: randomUUID(),
            baseRevision: note.revision,
            contentMarkdown: "# Cross workspace",
          }),
        ),
      ).toEqual({ code: "NOTE_NOT_FOUND", status: 404 });
      expect(
        await captureApiError(() =>
          writer.checkpoint(fixtureB.owner, note.id, {
            operationId: randomUUID(),
            baseRevision: note.revision,
          }),
        ),
      ).toEqual({ code: "NOTE_NOT_FOUND", status: 404 });
    });
  });
});
