import { randomUUID } from "node:crypto";
import {
  createDb,
  notes,
  user,
  workspaceMembers,
  workspaces,
  type Database,
  type WorkspaceRole,
} from "@glyphquire/database";
import type { EnqueueJobInput, JobDispatcher, JobRegistry } from "@glyphquire/queue";
import { PostgresSearchAdapter, normalizeSearchText } from "@glyphquire/search";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PublicApiError } from "../../middleware/error-handler.js";
import { createOperatorAuthorizer } from "./OperatorAuthorizer.js";
import { SearchServiceImpl } from "./SearchService.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const describeWithPostgres = databaseUrl ? describe : describe.skip;

class FakeJobDispatcher implements JobDispatcher {
  readonly enqueued: EnqueueJobInput<never>[] = [];

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

async function captureApiError(fn: () => Promise<unknown>) {
  try {
    await fn();
  } catch (error) {
    if (error instanceof PublicApiError) return { code: error.code, status: error.status };
    throw error;
  }
  throw new Error("expected the call to reject");
}

describeWithPostgres("SearchService", () => {
  let db: Database;

  beforeAll(() => {
    db = createDb(databaseUrl!);
  });

  afterAll(async () => {
    await db.$client.end();
  });

  async function insertActor(prefix: string) {
    const id = `${prefix}-${randomUUID()}`;
    await db.insert(user).values({ id, name: prefix, email: `${id}@example.test` });
    return id;
  }

  async function insertWorkspace(ownerId: string) {
    const [workspace] = await db
      .insert(workspaces)
      .values({ personalOwnerId: ownerId })
      .returning({ id: workspaces.id });
    await db
      .insert(workspaceMembers)
      .values({ workspaceId: workspace!.id, userId: ownerId, role: "owner" });
    return workspace!.id;
  }

  async function addMember(workspaceId: string, userId: string, role: WorkspaceRole) {
    await db.insert(workspaceMembers).values({ workspaceId, userId, role });
  }

  async function insertNote(workspaceId: string, ownerId: string, title: string) {
    const [note] = await db
      .insert(notes)
      .values({ workspaceId, title, contentMarkdown: title, contentHash: "hash", ownerId })
      .returning({ id: notes.id });
    return note!.id;
  }

  it("returns only results from the caller's own workspace to a member", async () => {
    const owner = await insertActor("search-owner");
    const outsider = await insertActor("search-outsider");
    const workspaceId = await insertWorkspace(owner);
    const otherWorkspaceId = await insertWorkspace(outsider);

    const dispatcher = new FakeJobDispatcher();
    const adapter = new PostgresSearchAdapter(db);
    const operatorAuthorizer = createOperatorAuthorizer([]);
    const service = new SearchServiceImpl(db, adapter, dispatcher, operatorAuthorizer);

    const marker = randomUUID().replaceAll("-", "");
    const noteId = await insertNote(workspaceId, owner, `Findable ${marker}`);
    await adapter.indexNote({
      noteId,
      workspaceId,
      revision: 1,
      title: `Findable ${marker}`,
      headings: [],
      body: `Findable ${marker}`,
      tags: [],
      normalizedText: normalizeSearchText(`Findable ${marker}`),
    });

    const otherNoteId = await insertNote(otherWorkspaceId, outsider, `Findable ${marker}`);
    await adapter.indexNote({
      noteId: otherNoteId,
      workspaceId: otherWorkspaceId,
      revision: 1,
      title: `Findable ${marker}`,
      headings: [],
      body: `Findable ${marker}`,
      tags: [],
      normalizedText: normalizeSearchText(`Findable ${marker}`),
    });

    const result = await service.search(owner, {
      workspaceId,
      q: marker,
      pageSize: 10,
    });
    expect(result.items.map((item) => item.noteId)).toEqual([noteId]);
  });

  it("denies search for a non-member with the same envelope as a missing workspace", async () => {
    const owner = await insertActor("search-owner-2");
    const stranger = await insertActor("search-stranger");
    const workspaceId = await insertWorkspace(owner);

    const dispatcher = new FakeJobDispatcher();
    const adapter = new PostgresSearchAdapter(db);
    const operatorAuthorizer = createOperatorAuthorizer([]);
    const service = new SearchServiceImpl(db, adapter, dispatcher, operatorAuthorizer);

    const error = await captureApiError(() =>
      service.search(stranger, { workspaceId, q: "anything", pageSize: 10 }),
    );
    expect(error).toEqual({ code: "NOTE_NOT_FOUND", status: 404 });
  });

  it("lets a viewer search but not rebuild", async () => {
    const owner = await insertActor("search-owner-3");
    const viewer = await insertActor("search-viewer");
    const workspaceId = await insertWorkspace(owner);
    await addMember(workspaceId, viewer, "viewer");

    const dispatcher = new FakeJobDispatcher();
    const adapter = new PostgresSearchAdapter(db);
    const operatorAuthorizer = createOperatorAuthorizer([]); // no operator configured
    const service = new SearchServiceImpl(db, adapter, dispatcher, operatorAuthorizer);

    await expect(
      service.search(viewer, { workspaceId, q: "anything", pageSize: 10 }),
    ).resolves.toMatchObject({ items: [] });

    const noteId = await insertNote(workspaceId, owner, "Rebuild target");
    const error = await captureApiError(() =>
      service.rebuildNote(viewer, { workspaceId, noteId }),
    );
    expect(error).toEqual({ code: "NOTE_NOT_FOUND", status: 404 });
    expect(dispatcher.enqueued).toEqual([]);
  });

  it("enqueues a bounded scope:note search.rebuild job for a configured operator", async () => {
    const owner = await insertActor("search-owner-4");
    const operatorId = await insertActor("search-operator");
    const workspaceId = await insertWorkspace(owner);
    const noteId = await insertNote(workspaceId, owner, "Operator rebuild target");

    const dispatcher = new FakeJobDispatcher();
    const adapter = new PostgresSearchAdapter(db);
    const operatorAuthorizer = createOperatorAuthorizer([operatorId]);
    const service = new SearchServiceImpl(db, adapter, dispatcher, operatorAuthorizer);

    const result = await service.rebuildNote(operatorId, { workspaceId, noteId });
    expect(result).toEqual({ enqueued: true });
    expect(dispatcher.enqueued).toHaveLength(1);
    expect(dispatcher.enqueued[0]).toMatchObject({
      workspaceId,
      type: "search.rebuild",
      payload: { workspaceId, scope: "note", noteId, batchSize: 1 },
    });
  });

  it("denies a rebuild for a note outside the operator's target workspace", async () => {
    const owner = await insertActor("search-owner-5");
    const otherOwner = await insertActor("search-owner-5-other");
    const operatorId = await insertActor("search-operator-2");
    const workspaceId = await insertWorkspace(owner);
    const otherWorkspaceId = await insertWorkspace(otherOwner);
    const noteId = await insertNote(otherWorkspaceId, otherOwner, "Wrong workspace note");

    const dispatcher = new FakeJobDispatcher();
    const adapter = new PostgresSearchAdapter(db);
    const operatorAuthorizer = createOperatorAuthorizer([operatorId]);
    const service = new SearchServiceImpl(db, adapter, dispatcher, operatorAuthorizer);

    const error = await captureApiError(() =>
      service.rebuildNote(operatorId, { workspaceId, noteId }),
    );
    expect(error).toEqual({ code: "NOTE_NOT_FOUND", status: 404 });
    expect(dispatcher.enqueued).toEqual([]);
  });

  it("paginates search results with a next cursor that advances", async () => {
    const owner = await insertActor("search-owner-6");
    const workspaceId = await insertWorkspace(owner);
    const marker = randomUUID().replaceAll("-", "");
    const dispatcher = new FakeJobDispatcher();
    const adapter = new PostgresSearchAdapter(db);
    const service = new SearchServiceImpl(db, adapter, dispatcher, createOperatorAuthorizer([]));

    const noteIds: string[] = [];
    for (let index = 0; index < 3; index += 1) {
      const noteId = await insertNote(workspaceId, owner, `Page note ${index} ${marker}`);
      await adapter.indexNote({
        noteId,
        workspaceId,
        revision: 1,
        title: `Page note ${index} ${marker}`,
        headings: [],
        body: `Page note ${index} ${marker}`,
        tags: [],
        normalizedText: normalizeSearchText(`Page note ${index} ${marker}`),
      });
      noteIds.push(noteId);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    const firstPage = await service.search(owner, { workspaceId, q: marker, pageSize: 2 });
    expect(firstPage.items).toHaveLength(2);
    expect(firstPage.nextCursor).not.toBeNull();

    const secondPage = await service.search(owner, {
      workspaceId,
      q: marker,
      pageSize: 2,
      cursor: firstPage.nextCursor!,
    });
    expect(secondPage.items).toHaveLength(1);
    expect(secondPage.nextCursor).toBeNull();

    const seenIds = [...firstPage.items, ...secondPage.items].map((item) => item.noteId);
    expect(new Set(seenIds)).toEqual(new Set(noteIds));
  });
});
