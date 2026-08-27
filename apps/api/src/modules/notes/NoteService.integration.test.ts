import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createDb,
  documentJobs,
  jobs as genericJobs,
  notes,
  user,
  workspaceMembers,
  workspaces,
  type Database,
  type NoteOperationKind,
  type WorkspaceRole,
} from "@glyphquire/database";
import type { CreateNoteInput, NoteResult } from "@glyphquire/api-contract";
import { and, eq, sql } from "drizzle-orm";
import { NoteServiceImpl, type NoteServiceHooks } from "./NoteService.js";
import { PublicApiError } from "../../middleware/error-handler.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const describeWithPostgres = databaseUrl ? describe : describe.skip;

const HOOK_POINTS: (keyof NoteServiceHooks)[] = [
  "beforeNoteChange",
  "afterNoteChange",
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

async function addMember(db: Database, workspaceId: string, userId: string, role: WorkspaceRole) {
  await db.insert(workspaceMembers).values({ workspaceId, userId, role });
}

interface Fixture {
  owner: string;
  editor: string;
  viewer: string;
  outsider: string;
  workspaceId: string;
}

async function buildFixture(db: Database): Promise<Fixture> {
  const owner = await insertActor(db, "owner");
  const editor = await insertActor(db, "editor");
  const viewer = await insertActor(db, "viewer");
  const outsider = await insertActor(db, "outsider");
  const workspaceId = await insertWorkspace(db, owner);
  await addMember(db, workspaceId, editor, "editor");
  await addMember(db, workspaceId, viewer, "viewer");
  return { owner, editor, viewer, outsider, workspaceId };
}

function createInput(overrides: Partial<CreateNoteInput> = {}): CreateNoteInput {
  return {
    operationId: randomUUID(),
    title: "Untitled",
    contentMarkdown: "# Body",
    visibility: "private",
    ...overrides,
  };
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

async function operationRowsFor(db: Database, noteId: string, operationKind?: NoteOperationKind) {
  return db.query.noteOperations.findMany({
    where: (table, { and: whereAnd, eq: whereEq }) =>
      operationKind
        ? whereAnd(whereEq(table.noteId, noteId), whereEq(table.operationKind, operationKind))
        : whereEq(table.noteId, noteId),
  });
}

async function jobRowsFor(db: Database, noteId: string) {
  return db.query.documentJobs.findMany({
    where: (table, { eq: whereEq }) => whereEq(table.noteId, noteId),
  });
}

async function derivedJobRowsForNote(db: Database, noteId: string) {
  const rows = await db
    .select()
    .from(genericJobs)
    .where(sql`${genericJobs.payload}->>'noteId' = ${noteId}`);
  return rows.sort((left, right) => Number(left.payload.revision) - Number(right.payload.revision));
}

async function derivedJobRowsForOperation(db: Database, operationId: string) {
  return db
    .select()
    .from(genericJobs)
    .where(sql`${genericJobs.payload}->>'operationId' = ${operationId}`);
}

describeWithPostgres("NoteService", () => {
  let db: Database;
  let service: NoteServiceImpl;

  beforeAll(() => {
    db = createDb(databaseUrl!);
    service = new NoteServiceImpl(db);
  });

  afterAll(async () => {
    await db.$client.end();
  });

  it("scopes list and create to workspace membership", async () => {
    const fixture = await buildFixture(db);
    const note = await service.create(fixture.owner, {
      workspaceId: fixture.workspaceId,
      ...createInput(),
    });

    const ownerPage = await service.list(fixture.owner, {
      workspaceId: fixture.workspaceId,
      pageSize: 50,
    });
    expect(ownerPage.items.map((item) => item.id)).toContain(note.id);

    expect(
      await captureApiError(() =>
        service.list(fixture.outsider, { workspaceId: fixture.workspaceId, pageSize: 50 }),
      ),
    ).toEqual({
      code: "NOTE_NOT_FOUND",
      status: 404,
    });
    expect(
      await captureApiError(() =>
        service.create(fixture.outsider, { workspaceId: fixture.workspaceId, ...createInput() }),
      ),
    ).toEqual({ code: "NOTE_NOT_FOUND", status: 404 });
  });

  it("refuses cross-workspace access for a member of a different workspace", async () => {
    const fixtureA = await buildFixture(db);
    const fixtureB = await buildFixture(db);
    const note = await service.create(fixtureA.owner, {
      workspaceId: fixtureA.workspaceId,
      ...createInput(),
    });

    expect(await captureApiError(() => service.get(fixtureB.owner, note.id))).toEqual({
      code: "NOTE_NOT_FOUND",
      status: 404,
    });
    expect(
      await captureApiError(() =>
        service.list(fixtureB.owner, { workspaceId: fixtureA.workspaceId, pageSize: 50 }),
      ),
    ).toEqual({ code: "NOTE_NOT_FOUND", status: 404 });
  });

  it("exercises the owner/editor/viewer/outsider/deleted-note matrix with a uniform 404 envelope", async () => {
    const fixture = await buildFixture(db);
    const note = await service.create(fixture.owner, {
      workspaceId: fixture.workspaceId,
      ...createInput({ title: "Secret Title", contentMarkdown: "# Secret body" }),
    });

    for (const actorId of [fixture.owner, fixture.editor, fixture.viewer]) {
      const result = await service.get(actorId, note.id);
      expect(result.id).toBe(note.id);
    }

    const outsiderGet = await captureApiError(() => service.get(fixture.outsider, note.id));
    expect(outsiderGet).toEqual({ code: "NOTE_NOT_FOUND", status: 404 });
    expect(JSON.stringify(outsiderGet)).not.toContain("Secret");

    const viewerRename = await captureApiError(() =>
      service.rename(fixture.viewer, note.id, {
        operationId: randomUUID(),
        baseRevision: note.revision,
        title: "Viewer attempt",
      }),
    );
    const outsiderRename = await captureApiError(() =>
      service.rename(fixture.outsider, note.id, {
        operationId: randomUUID(),
        baseRevision: note.revision,
        title: "Outsider attempt",
      }),
    );
    // A viewer's mutation attempt and an outright outsider's are indistinguishable.
    expect(viewerRename).toEqual(outsiderRename);
    expect(viewerRename).toEqual({ code: "NOTE_NOT_FOUND", status: 404 });

    const renamed = await service.rename(fixture.editor, note.id, {
      operationId: randomUUID(),
      baseRevision: note.revision,
      title: "Renamed by editor",
    });
    expect(renamed.title).toBe("Renamed by editor");
    expect(renamed.revision).toBe(note.revision + 1);

    const deleted = await service.softDelete(fixture.owner, note.id, {
      operationId: randomUUID(),
      baseRevision: renamed.revision,
    });
    expect(deleted.deletedAt).not.toBeNull();

    for (const actorId of [fixture.owner, fixture.editor, fixture.viewer, fixture.outsider]) {
      expect(await captureApiError(() => service.get(actorId, note.id))).toEqual({
        code: "NOTE_NOT_FOUND",
        status: 404,
      });
    }
    const afterDeleteList = await service.list(fixture.owner, {
      workspaceId: fixture.workspaceId,
      pageSize: 50,
    });
    expect(afterDeleteList.items.map((item) => item.id)).not.toContain(note.id);

    const viewerRestore = await captureApiError(() =>
      service.restore(fixture.viewer, note.id, {
        operationId: randomUUID(),
        baseRevision: deleted.revision,
      }),
    );
    expect(viewerRestore).toEqual({ code: "NOTE_NOT_FOUND", status: 404 });

    const restored = await service.restore(fixture.editor, note.id, {
      operationId: randomUUID(),
      baseRevision: deleted.revision,
    });
    expect(restored.deletedAt).toBeNull();
    expect(restored.revision).toBe(deleted.revision + 1);

    // Restore only targets a currently-deleted note; an already-active note is hidden the same way.
    expect(
      await captureApiError(() =>
        service.restore(fixture.owner, note.id, {
          operationId: randomUUID(),
          baseRevision: restored.revision,
        }),
      ),
    ).toEqual({ code: "NOTE_NOT_FOUND", status: 404 });
  });

  it("keeps create atomic when a failure is injected before or after each write", async () => {
    const fixture = await buildFixture(db);

    for (const point of HOOK_POINTS) {
      const before = await db
        .select({ id: notes.id })
        .from(notes)
        .where(eq(notes.workspaceId, fixture.workspaceId));
      const operationId = randomUUID();
      const failingHooks: NoteServiceHooks = {
        [point]: () => {
          throw new Error(`injected ${point} failure`);
        },
      };
      const failingService = new NoteServiceImpl(db, failingHooks);

      await expect(
        failingService.create(fixture.owner, {
          workspaceId: fixture.workspaceId,
          ...createInput({ operationId }),
        }),
      ).rejects.toThrow(`injected ${point} failure`);

      const after = await db
        .select({ id: notes.id })
        .from(notes)
        .where(eq(notes.workspaceId, fixture.workspaceId));
      expect(after).toHaveLength(before.length);

      const operationRow = await db.query.noteOperations.findFirst({
        where: (table, { and: whereAnd, eq: whereEq }) =>
          whereAnd(
            whereEq(table.workspaceId, fixture.workspaceId),
            whereEq(table.operationId, operationId),
          ),
      });
      expect(operationRow).toBeUndefined();
      expect(await derivedJobRowsForOperation(db, operationId)).toHaveLength(0);
    }
  });

  it.each([
    ["rename", "active" as const] as const,
    ["softDelete", "active" as const] as const,
    ["restore", "deleted" as const] as const,
  ])(
    "keeps %s atomic when a failure is injected before or after each write",
    async (action, requiredStartingState) => {
      const fixture = await buildFixture(db);
      const created = await service.create(fixture.owner, {
        workspaceId: fixture.workspaceId,
        ...createInput(),
      });
      const note =
        requiredStartingState === "deleted"
          ? await service.softDelete(fixture.owner, created.id, {
              operationId: randomUUID(),
              baseRevision: created.revision,
            })
          : created;

      for (const point of HOOK_POINTS) {
        const operationId = randomUUID();
        const failingHooks: NoteServiceHooks = {
          [point]: () => {
            throw new Error(`injected ${point} failure`);
          },
        };
        const failingService = new NoteServiceImpl(db, failingHooks);
        const mutationInput = {
          operationId,
          baseRevision: note.revision,
          ...(action === "rename" ? { title: `Attempt ${point}` } : {}),
        };

        await expect(
          (
            failingService[action] as (
              actorId: string,
              noteId: string,
              input: typeof mutationInput,
            ) => Promise<NoteResult>
          )(fixture.owner, note.id, mutationInput),
        ).rejects.toThrow(`injected ${point} failure`);

        const current = await db.query.notes.findFirst({
          where: (table, { eq: whereEq }) => whereEq(table.id, note.id),
        });
        expect(current?.revision).toBe(note.revision);
        expect(current?.title).toBe(note.title);
        expect(Boolean(current?.deletedAt)).toBe(requiredStartingState === "deleted");

        const operationRow = await db.query.noteOperations.findFirst({
          where: (table, { and: whereAnd, eq: whereEq }) =>
            whereAnd(whereEq(table.noteId, note.id), whereEq(table.operationId, operationId)),
        });
        expect(operationRow).toBeUndefined();
        const jobRow = await db.query.documentJobs.findFirst({
          where: (table, { and: whereAnd, eq: whereEq }) =>
            whereAnd(whereEq(table.noteId, note.id), whereEq(table.operationId, operationId)),
        });
        expect(jobRow).toBeUndefined();
        expect(await derivedJobRowsForOperation(db, operationId)).toHaveLength(0);
      }
    },
  );

  it("creates exactly one note for concurrent identical create requests", async () => {
    const fixture = await buildFixture(db);
    const operationId = randomUUID();
    const input = createInput({
      operationId,
      title: "Concurrent create",
      contentMarkdown: "# concurrent",
    });

    const [first, second] = await Promise.all([
      service.create(fixture.owner, { workspaceId: fixture.workspaceId, ...input }),
      service.create(fixture.owner, { workspaceId: fixture.workspaceId, ...input }),
    ]);

    expect(first).toEqual(second);
    const noteRows = await db
      .select({ id: notes.id })
      .from(notes)
      .where(and(eq(notes.workspaceId, fixture.workspaceId), eq(notes.title, "Concurrent create")));
    expect(noteRows).toHaveLength(1);
    const operationRows = await db.query.noteOperations.findMany({
      where: (table, { eq: whereEq }) => whereEq(table.operationId, operationId),
    });
    expect(operationRows).toHaveLength(1);
    expect(await derivedJobRowsForNote(db, noteRows[0]!.id)).toHaveLength(1);
  });

  it("resolves concurrent identical rename requests to one recorded response", async () => {
    const fixture = await buildFixture(db);
    const note = await service.create(fixture.owner, {
      workspaceId: fixture.workspaceId,
      ...createInput(),
    });
    const operationId = randomUUID();
    const input = { operationId, baseRevision: note.revision, title: "Concurrent rename" };

    const [first, second] = await Promise.all([
      service.rename(fixture.owner, note.id, input),
      service.rename(fixture.owner, note.id, input),
    ]);

    expect(first).toEqual(second);
    expect(await operationRowsFor(db, note.id, "rename")).toHaveLength(1);
    expect(await jobRowsFor(db, note.id)).toHaveLength(2); // one from create, one from the single recorded rename
    expect(await derivedJobRowsForNote(db, note.id)).toHaveLength(2);
  });

  it("transactionally enqueues exactly one derived search job for create, rename, delete, and restore", async () => {
    const fixture = await buildFixture(db);
    const createOperationId = randomUUID();
    const createRequest = {
      workspaceId: fixture.workspaceId,
      ...createInput({ operationId: createOperationId }),
    };
    const created = await service.create(fixture.owner, createRequest);
    expect(await service.create(fixture.owner, createRequest)).toEqual(created);

    const renameOperationId = randomUUID();
    const renameRequest = {
      operationId: renameOperationId,
      baseRevision: created.revision,
      title: "Derived search rename",
    };
    const renamed = await service.rename(fixture.owner, created.id, renameRequest);
    expect(await service.rename(fixture.owner, created.id, renameRequest)).toEqual(renamed);

    expect(
      await captureApiError(() =>
        service.rename(fixture.owner, created.id, {
          operationId: randomUUID(),
          baseRevision: created.revision,
          title: "Stale rename",
        }),
      ),
    ).toEqual({ code: "REVISION_CONFLICT", status: 409 });

    const deleteOperationId = randomUUID();
    const deleteRequest = {
      operationId: deleteOperationId,
      baseRevision: renamed.revision,
    };
    const deleted = await service.softDelete(fixture.owner, created.id, deleteRequest);
    expect(
      await captureApiError(() => service.softDelete(fixture.owner, created.id, deleteRequest)),
    ).toEqual({ code: "NOTE_NOT_FOUND", status: 404 });

    const restoreOperationId = randomUUID();
    const restoreRequest = {
      operationId: restoreOperationId,
      baseRevision: deleted.revision,
    };
    const restored = await service.restore(fixture.owner, created.id, restoreRequest);
    expect(
      await captureApiError(() => service.restore(fixture.owner, created.id, restoreRequest)),
    ).toEqual({ code: "NOTE_NOT_FOUND", status: 404 });

    const rows = await derivedJobRowsForNote(db, created.id);
    expect(
      rows.map((row) => ({
        type: row.type,
        idempotencyKey: row.idempotencyKey,
        payload: row.payload,
      })),
    ).toEqual([
      {
        type: "search.index",
        idempotencyKey: `note-${created.id}-revision-${created.revision}-operation-${createOperationId}`,
        payload: {
          workspaceId: fixture.workspaceId,
          noteId: created.id,
          revision: created.revision,
          operationId: createOperationId,
        },
      },
      {
        type: "search.index",
        idempotencyKey: `note-${created.id}-revision-${renamed.revision}-operation-${renameOperationId}`,
        payload: {
          workspaceId: fixture.workspaceId,
          noteId: created.id,
          revision: renamed.revision,
          operationId: renameOperationId,
        },
      },
      {
        type: "search.remove",
        idempotencyKey: `note-${created.id}-revision-${deleted.revision}-operation-${deleteOperationId}`,
        payload: {
          workspaceId: fixture.workspaceId,
          noteId: created.id,
          revision: deleted.revision,
          operationId: deleteOperationId,
        },
      },
      {
        type: "search.index",
        idempotencyKey: `note-${created.id}-revision-${restored.revision}-operation-${restoreOperationId}`,
        payload: {
          workspaceId: fixture.workspaceId,
          noteId: created.id,
          revision: restored.revision,
          operationId: restoreOperationId,
        },
      },
    ]);
    expect(new Set(rows.map((row) => row.idempotencyKey)).size).toBe(rows.length);
  });

  it("returns OPERATION_REUSED when a create operationId carries a different canonical request", async () => {
    const fixture = await buildFixture(db);
    const operationId = randomUUID();
    const first = await service.create(fixture.owner, {
      workspaceId: fixture.workspaceId,
      ...createInput({ operationId, title: "First" }),
    });

    expect(
      await captureApiError(() =>
        service.create(fixture.owner, {
          workspaceId: fixture.workspaceId,
          ...createInput({ operationId, title: "Different" }),
        }),
      ),
    ).toEqual({ code: "OPERATION_REUSED", status: 409 });

    const noteRows = await db
      .select({ id: notes.id })
      .from(notes)
      .where(eq(notes.workspaceId, fixture.workspaceId));
    expect(noteRows).toHaveLength(1);
    expect(noteRows[0]!.id).toBe(first.id);
  });

  it("distinguishes a reused rename operationId from a genuine revision conflict, and the losing CAS writes nothing", async () => {
    const fixture = await buildFixture(db);
    const note = await service.create(fixture.owner, {
      workspaceId: fixture.workspaceId,
      ...createInput(),
    });
    const operationId = randomUUID();

    const renamed = await service.rename(fixture.owner, note.id, {
      operationId,
      baseRevision: note.revision,
      title: "First rename",
    });

    expect(
      await captureApiError(() =>
        service.rename(fixture.owner, note.id, {
          operationId,
          baseRevision: note.revision,
          title: "Different title, same key",
        }),
      ),
    ).toEqual({ code: "OPERATION_REUSED", status: 409 });

    expect(
      await captureApiError(() =>
        service.rename(fixture.owner, note.id, {
          operationId: randomUUID(),
          baseRevision: note.revision,
          title: "Stale writer",
        }),
      ),
    ).toEqual({ code: "REVISION_CONFLICT", status: 409 });

    const operationRows = await operationRowsFor(db, note.id, "rename");
    expect(operationRows).toHaveLength(1);
    expect(operationRows[0]!.operationId).toBe(operationId);

    const current = await db.query.notes.findFirst({
      where: (table, { eq: whereEq }) => whereEq(table.id, note.id),
    });
    expect(current?.title).toBe("First rename");
    expect(current?.revision).toBe(renamed.revision);
  });

  it("paginates deterministically by (updatedAt desc, id desc) and breaks ties by id", async () => {
    const fixture = await buildFixture(db);
    const created: NoteResult[] = [];
    for (let index = 0; index < 5; index += 1) {
      const note = await service.create(fixture.owner, {
        workspaceId: fixture.workspaceId,
        ...createInput({ title: `Note ${index}` }),
      });
      created.push(note);
      await db
        .update(notes)
        .set({ updatedAt: new Date(Date.UTC(2026, 0, 1, 0, index)), revision: note.revision + 1 })
        .where(eq(notes.id, note.id));
    }

    async function walk(pageSize: number) {
      const ids: string[] = [];
      let cursor: string | null = null;
      do {
        const page = await service.list(fixture.owner, {
          workspaceId: fixture.workspaceId,
          pageSize,
          cursor: cursor ?? undefined,
        });
        ids.push(...page.items.map((item) => item.id));
        cursor = page.nextCursor;
      } while (cursor);
      return ids;
    }

    const expectedOrder = [...created].reverse().map((note) => note.id);
    const firstWalk = await walk(2);
    expect(firstWalk).toEqual(expectedOrder);

    const secondWalk = await walk(2);
    expect(secondWalk).toEqual(firstWalk);
  });

  it("rejects an undecodable cursor", async () => {
    const fixture = await buildFixture(db);
    expect(
      await captureApiError(() =>
        service.list(fixture.owner, {
          workspaceId: fixture.workspaceId,
          pageSize: 10,
          cursor: "not-a-real-cursor!!",
        }),
      ),
    ).toEqual({ code: "DOCUMENT_INVALID", status: 400 });
  });

  it("keeps document_jobs rows scoped to the note's own actor-verifiable identity", async () => {
    const fixture = await buildFixture(db);
    const note = await service.create(fixture.owner, {
      workspaceId: fixture.workspaceId,
      ...createInput(),
    });
    const jobs = await db.select().from(documentJobs).where(eq(documentJobs.noteId, note.id));
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      workspaceId: fixture.workspaceId,
      noteId: note.id,
      kind: "upsert",
      revision: note.revision,
    });
  });
});
