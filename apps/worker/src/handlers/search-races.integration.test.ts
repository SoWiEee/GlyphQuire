import { randomUUID } from "node:crypto";
import type { JobEnvelope } from "@glyphquire/api-contract/jobs";
import {
  createDb,
  notes,
  searchDocuments,
  user,
  workspaceMembers,
  workspaces,
  type Database,
} from "@glyphquire/database";
import {
  PostgresSearchAdapter,
  type DerivedSearchMissingTarget,
  type DerivedSearchMutationPort,
  type DerivedSearchMutationTarget,
  type SearchPort,
  type SearchQuery,
  type SearchResult,
  type SearchableNote,
} from "@glyphquire/search";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSearchIndexHandler, PostgresSearchIndexRepository } from "./search-index.js";
import {
  createSearchRebuildNoteHandler,
  PostgresSearchRebuildNoteRepository,
} from "./search-rebuild-note.js";
import { createSearchRemoveHandler, PostgresSearchRemoveRepository } from "./search-remove.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const describeWithPostgres = databaseUrl ? describe : describe.skip;
const MARKDOWN = "---\nglyphquire-spec: 1\n---\n\n# Indexed heading\n\nSearchable body.";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

class PausingSearchPort implements SearchPort, DerivedSearchMutationPort {
  private readonly mutationEntered = deferred();
  private readonly releaseMutation = deferred();
  private paused = false;

  constructor(
    private readonly adapter: PostgresSearchAdapter,
    private readonly pauseOperation: "index" | "remove",
  ) {}

  waitUntilMutationEntered(): Promise<void> {
    return this.mutationEntered.promise;
  }

  release(): void {
    this.releaseMutation.resolve();
  }

  private async pause(operation: "index" | "remove"): Promise<void> {
    if (this.paused || operation !== this.pauseOperation) return;
    this.paused = true;
    this.mutationEntered.resolve();
    await this.releaseMutation.promise;
  }

  async indexNote(note: SearchableNote): Promise<void> {
    await this.pause("index");
    await this.adapter.indexNote(note);
  }

  async indexNoteIfCurrent(note: SearchableNote): Promise<void> {
    await this.pause("index");
    await this.adapter.indexNoteIfCurrent(note);
  }

  async removeNote(noteId: string): Promise<void> {
    await this.pause("remove");
    await this.adapter.removeNote(noteId);
  }

  async removeNoteIfCurrent(target: DerivedSearchMutationTarget): Promise<void> {
    await this.pause("remove");
    await this.adapter.removeNoteIfCurrent(target);
  }

  async removeNoteIfMissing(target: DerivedSearchMissingTarget): Promise<void> {
    await this.pause("remove");
    await this.adapter.removeNoteIfMissing(target);
  }

  async search(query: SearchQuery): Promise<SearchResult[]> {
    return this.adapter.search(query);
  }
}

function searchIndexJob(
  workspaceId: string,
  noteId: string,
  revision: number,
): JobEnvelope<"search.index"> {
  return {
    id: randomUUID(),
    workspaceId,
    type: "search.index",
    version: 1,
    attempts: 1,
    createdAt: new Date().toISOString(),
    payload: { workspaceId, noteId, revision, operationId: randomUUID() },
  };
}

function searchRemoveJob(
  workspaceId: string,
  noteId: string,
  revision: number,
): JobEnvelope<"search.remove"> {
  return {
    id: randomUUID(),
    workspaceId,
    type: "search.remove",
    version: 1,
    attempts: 1,
    createdAt: new Date().toISOString(),
    payload: { workspaceId, noteId, revision, operationId: randomUUID() },
  };
}

function searchRebuildJob(workspaceId: string, noteId: string): JobEnvelope<"search.rebuild"> {
  return {
    id: randomUUID(),
    workspaceId,
    type: "search.rebuild",
    version: 1,
    attempts: 1,
    createdAt: new Date().toISOString(),
    payload: { workspaceId, scope: "note", noteId, batchSize: 1 },
  };
}

describeWithPostgres("derived search mutation races", () => {
  let db: Database;
  let adapter: PostgresSearchAdapter;
  let ownerId: string;
  let workspaceId: string;

  beforeAll(async () => {
    db = createDb(databaseUrl!);
    adapter = new PostgresSearchAdapter(db);
    ownerId = `worker-search-race-${randomUUID()}`;
    await db.insert(user).values({
      id: ownerId,
      name: "Worker search race",
      email: `${ownerId}@example.test`,
    });
    const [workspace] = await db
      .insert(workspaces)
      .values({ personalOwnerId: ownerId })
      .returning({ id: workspaces.id });
    workspaceId = workspace!.id;
    await db.insert(workspaceMembers).values({ workspaceId, userId: ownerId, role: "owner" });
  });

  afterAll(async () => {
    if (!db) return;
    await db.delete(workspaces).where(eq(workspaces.id, workspaceId));
    await db.delete(user).where(eq(user.id, ownerId));
    await db.$client.end();
  });

  async function insertNote(input: {
    revision: number;
    title: string;
    deletedAt: Date | null;
  }): Promise<string> {
    const [note] = await db
      .insert(notes)
      .values({
        workspaceId,
        ownerId,
        revision: input.revision,
        title: input.title,
        contentMarkdown: MARKDOWN,
        contentHash: `hash-${input.revision}`,
        deletedAt: input.deletedAt,
      })
      .returning({ id: notes.id });
    return note!.id;
  }

  async function indexedRows(noteId: string): Promise<Array<{ revision: number; title: string }>> {
    return db
      .select({ revision: searchDocuments.revision, title: searchDocuments.title })
      .from(searchDocuments)
      .where(eq(searchDocuments.noteId, noteId));
  }

  it("prevents an old index read from recreating a note after a newer delete", async () => {
    const noteId = await insertNote({ revision: 4, title: "Active revision", deletedAt: null });
    const pausingPort = new PausingSearchPort(adapter, "index");
    const staleHandler = createSearchIndexHandler({
      repository: new PostgresSearchIndexRepository(db),
      searchPort: pausingPort,
    });
    const removeHandler = createSearchRemoveHandler({
      repository: new PostgresSearchRemoveRepository(db),
      searchPort: adapter,
    });

    const staleIndex = staleHandler(
      searchIndexJob(workspaceId, noteId, 4),
      new AbortController().signal,
    );
    await pausingPort.waitUntilMutationEntered();
    try {
      await db
        .update(notes)
        .set({ revision: 5, title: "Deleted revision", deletedAt: new Date() })
        .where(eq(notes.id, noteId));
      await removeHandler(searchRemoveJob(workspaceId, noteId, 5), new AbortController().signal);
    } finally {
      pausingPort.release();
    }
    await staleIndex;

    expect(await indexedRows(noteId)).toEqual([]);
  });

  it("prevents an old remove read from deleting a newer restored index", async () => {
    const noteId = await insertNote({
      revision: 4,
      title: "Deleted revision",
      deletedAt: new Date(),
    });
    await adapter.indexNote({
      noteId,
      workspaceId,
      revision: 3,
      title: "Before deletion",
      headings: [],
      body: "old",
      tags: [],
      normalizedText: "before deletion old",
    });
    const pausingPort = new PausingSearchPort(adapter, "remove");
    const staleHandler = createSearchRemoveHandler({
      repository: new PostgresSearchRemoveRepository(db),
      searchPort: pausingPort,
    });
    const indexHandler = createSearchIndexHandler({
      repository: new PostgresSearchIndexRepository(db),
      searchPort: adapter,
    });

    const staleRemove = staleHandler(
      searchRemoveJob(workspaceId, noteId, 4),
      new AbortController().signal,
    );
    await pausingPort.waitUntilMutationEntered();
    try {
      await db
        .update(notes)
        .set({ revision: 5, title: "Restored revision", deletedAt: null })
        .where(eq(notes.id, noteId));
      await indexHandler(searchIndexJob(workspaceId, noteId, 5), new AbortController().signal);
    } finally {
      pausingPort.release();
    }
    await staleRemove;

    expect(await indexedRows(noteId)).toEqual([{ revision: 5, title: "Restored revision" }]);
  });

  it("prevents a stale rebuild index from recreating a note after a newer delete", async () => {
    const noteId = await insertNote({ revision: 4, title: "Rebuild active", deletedAt: null });
    const pausingPort = new PausingSearchPort(adapter, "index");
    const staleRebuild = createSearchRebuildNoteHandler({
      repository: new PostgresSearchRebuildNoteRepository(db),
      searchPort: pausingPort,
    });
    const removeHandler = createSearchRemoveHandler({
      repository: new PostgresSearchRemoveRepository(db),
      searchPort: adapter,
    });

    const rebuild = staleRebuild(
      searchRebuildJob(workspaceId, noteId),
      new AbortController().signal,
    );
    await pausingPort.waitUntilMutationEntered();
    try {
      await db
        .update(notes)
        .set({ revision: 5, title: "Deleted after rebuild read", deletedAt: new Date() })
        .where(eq(notes.id, noteId));
      await removeHandler(searchRemoveJob(workspaceId, noteId, 5), new AbortController().signal);
    } finally {
      pausingPort.release();
    }
    await rebuild;

    expect(await indexedRows(noteId)).toEqual([]);
  });

  it("prevents a stale rebuild remove from deleting a newer restored index", async () => {
    const noteId = await insertNote({
      revision: 4,
      title: "Rebuild deleted",
      deletedAt: new Date(),
    });
    await adapter.indexNote({
      noteId,
      workspaceId,
      revision: 3,
      title: "Before rebuild deletion",
      headings: [],
      body: "old",
      tags: [],
      normalizedText: "before rebuild deletion old",
    });
    const pausingPort = new PausingSearchPort(adapter, "remove");
    const staleRebuild = createSearchRebuildNoteHandler({
      repository: new PostgresSearchRebuildNoteRepository(db),
      searchPort: pausingPort,
    });
    const indexHandler = createSearchIndexHandler({
      repository: new PostgresSearchIndexRepository(db),
      searchPort: adapter,
    });

    const rebuild = staleRebuild(
      searchRebuildJob(workspaceId, noteId),
      new AbortController().signal,
    );
    await pausingPort.waitUntilMutationEntered();
    try {
      await db
        .update(notes)
        .set({ revision: 5, title: "Restored after rebuild read", deletedAt: null })
        .where(eq(notes.id, noteId));
      await indexHandler(searchIndexJob(workspaceId, noteId, 5), new AbortController().signal);
    } finally {
      pausingPort.release();
    }
    await rebuild;

    expect(await indexedRows(noteId)).toEqual([
      { revision: 5, title: "Restored after rebuild read" },
    ]);
  });

  it("keeps duplicate index deliveries idempotent", async () => {
    const noteId = await insertNote({ revision: 1, title: "Duplicate index", deletedAt: null });
    const handler = createSearchIndexHandler({
      repository: new PostgresSearchIndexRepository(db),
      searchPort: adapter,
    });
    const job = searchIndexJob(workspaceId, noteId, 1);

    await handler(job, new AbortController().signal);
    await handler(job, new AbortController().signal);

    expect(await indexedRows(noteId)).toEqual([{ revision: 1, title: "Duplicate index" }]);
  });

  it("keeps duplicate remove deliveries idempotent", async () => {
    const noteId = await insertNote({
      revision: 2,
      title: "Duplicate remove",
      deletedAt: new Date(),
    });
    await adapter.indexNote({
      noteId,
      workspaceId,
      revision: 1,
      title: "Before deletion",
      headings: [],
      body: "old",
      tags: [],
      normalizedText: "before deletion old",
    });
    const handler = createSearchRemoveHandler({
      repository: new PostgresSearchRemoveRepository(db),
      searchPort: adapter,
    });
    const job = searchRemoveJob(workspaceId, noteId, 2);

    await handler(job, new AbortController().signal);
    await handler(job, new AbortController().signal);

    expect(await indexedRows(noteId)).toEqual([]);
  });
});
