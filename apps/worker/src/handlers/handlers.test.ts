import { createHash, randomUUID } from "node:crypto";
import type {
  DerivedSearchMissingTarget,
  DerivedSearchMutationPort,
  DerivedSearchMutationTarget,
  SearchPort,
  SearchQuery,
  SearchResult,
  SearchableNote,
} from "@glyphquire/search";
import { assertRegistryComplete } from "@glyphquire/queue";
import { JOB_TYPES } from "@glyphquire/api-contract/jobs";
import { InMemoryObjectStorage } from "@glyphquire/storage";
import { describe, expect, it } from "vitest";
import {
  createAssetCleanupHandler,
  type AssetCleanupRepository,
  type AssetCleanupRow,
} from "./asset-cleanup.js";
import {
  createSearchIndexHandler,
  type SearchIndexNoteRow,
  type SearchIndexRepository,
} from "./search-index.js";
import {
  createSearchRemoveHandler,
  type SearchRemoveNoteRow,
  type SearchRemoveRepository,
} from "./search-remove.js";
import { jobRegistry } from "../registry.js";

const MARKDOWN = "---\nglyphquire-spec: 1\n---\n\n# Indexed heading\n\nSearchable body.";

class FakeSearchIndexRepository implements SearchIndexRepository {
  row: SearchIndexNoteRow | undefined;
  failure: Error | undefined;
  readonly loaded: string[] = [];

  async loadNote(noteId: string): Promise<SearchIndexNoteRow | undefined> {
    this.loaded.push(noteId);
    if (this.failure) throw this.failure;
    return this.row;
  }
}

class FakeSearchRemoveRepository implements SearchRemoveRepository {
  row: SearchRemoveNoteRow | undefined;
  failure: Error | undefined;
  readonly loaded: string[] = [];

  async loadNote(noteId: string): Promise<SearchRemoveNoteRow | undefined> {
    this.loaded.push(noteId);
    if (this.failure) throw this.failure;
    return this.row;
  }
}

class FakeAssetCleanupRepository implements AssetCleanupRepository {
  row: AssetCleanupRow | undefined;
  failure: Error | undefined;
  readonly loaded: string[] = [];

  async loadAsset(assetId: string): Promise<AssetCleanupRow | undefined> {
    this.loaded.push(assetId);
    if (this.failure) throw this.failure;
    return this.row;
  }
}

interface CurrentSearchSource {
  noteId: string;
  workspaceId: string;
  revision: number;
  deletedAt: Date | null;
}

class MemorySearchPort implements SearchPort, DerivedSearchMutationPort {
  readonly documents = new Map<string, SearchableNote>();
  readonly indexed: SearchableNote[] = [];
  readonly removed: string[] = [];
  indexFailure: Error | undefined;
  removeFailure: Error | undefined;
  beforeIndex: (() => Promise<void>) | undefined;
  beforeRemove: (() => Promise<void>) | undefined;

  constructor(
    private readonly currentSource?: (noteId: string) => CurrentSearchSource | undefined,
  ) {}

  private applyIndex(note: SearchableNote): void {
    this.indexed.push(note);
    const existing = this.documents.get(note.noteId);
    if (!existing || existing.revision < note.revision) this.documents.set(note.noteId, note);
  }

  private applyRemove(noteId: string): void {
    this.removed.push(noteId);
    this.documents.delete(noteId);
  }

  async indexNote(note: SearchableNote): Promise<void> {
    await this.beforeIndex?.();
    if (this.indexFailure) throw this.indexFailure;
    this.applyIndex(note);
  }

  async indexNoteIfCurrent(note: SearchableNote): Promise<void> {
    await this.beforeIndex?.();
    if (this.indexFailure) throw this.indexFailure;
    if (this.currentSource) {
      const source = this.currentSource(note.noteId);
      if (
        !source ||
        source.noteId !== note.noteId ||
        source.workspaceId !== note.workspaceId ||
        source.revision !== note.revision ||
        source.deletedAt !== null
      ) {
        return;
      }
    }
    this.applyIndex(note);
  }

  async removeNote(noteId: string): Promise<void> {
    await this.beforeRemove?.();
    if (this.removeFailure) throw this.removeFailure;
    this.applyRemove(noteId);
  }

  async removeNoteIfCurrent(target: DerivedSearchMutationTarget): Promise<void> {
    await this.beforeRemove?.();
    if (this.removeFailure) throw this.removeFailure;
    if (this.currentSource) {
      const source = this.currentSource(target.noteId);
      if (
        source &&
        (source.noteId !== target.noteId ||
          source.workspaceId !== target.workspaceId ||
          source.revision !== target.revision ||
          source.deletedAt === null)
      ) {
        return;
      }
    }
    this.applyRemove(target.noteId);
  }

  async removeNoteIfMissing(target: DerivedSearchMissingTarget): Promise<void> {
    await this.beforeRemove?.();
    if (this.removeFailure) throw this.removeFailure;
    if (this.currentSource?.(target.noteId)) return;
    this.applyRemove(target.noteId);
  }

  async search(_query: SearchQuery): Promise<SearchResult[]> {
    return [];
  }
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function searchIndexJob(workspaceId: string, noteId: string, revision: number) {
  return {
    id: randomUUID(),
    workspaceId,
    type: "search.index" as const,
    version: 1,
    attempts: 1,
    createdAt: new Date().toISOString(),
    payload: { workspaceId, noteId, revision, operationId: randomUUID() },
  };
}

function searchRemoveJob(workspaceId: string, noteId: string, revision: number) {
  return {
    id: randomUUID(),
    workspaceId,
    type: "search.remove" as const,
    version: 1,
    attempts: 1,
    createdAt: new Date().toISOString(),
    payload: { workspaceId, noteId, revision, operationId: randomUUID() },
  };
}

function assetCleanupJob(workspaceId: string, assetId: string) {
  return {
    id: randomUUID(),
    workspaceId,
    type: "asset.cleanup" as const,
    version: 1,
    attempts: 1,
    createdAt: new Date().toISOString(),
    payload: { workspaceId, assetId },
  };
}

async function putObject(storage: InMemoryObjectStorage, key: string): Promise<void> {
  const body = Buffer.from("asset bytes");
  await storage.put({
    key,
    body,
    contentType: "application/octet-stream",
    contentLength: body.byteLength,
    sha256: createHash("sha256").update(body).digest("hex"),
  });
}

describe("Phase 5 worker consumer modules", () => {
  it("registers the complete reviewed Phase 5 handler set statically", () => {
    expect(Object.keys(jobRegistry)).toEqual([...JOB_TYPES]);
    expect(Object.values(jobRegistry).every((handler) => typeof handler === "function")).toBe(true);
    expect(Object.isFrozen(jobRegistry)).toBe(true);
  });

  it("opens production activation only after the final Task 7 P0 handoff", () => {
    expect(() => assertRegistryComplete(jobRegistry)).not.toThrow();
  });

  it("exposes the search.index handler factory", async () => {
    await expect(import("./search-index.js")).resolves.toHaveProperty(
      "createSearchIndexHandler",
      expect.any(Function),
    );
  });

  it("exposes the search.remove handler factory", async () => {
    await expect(import("./search-remove.js")).resolves.toHaveProperty(
      "createSearchRemoveHandler",
      expect.any(Function),
    );
  });

  it("exposes the asset.cleanup handler factory", async () => {
    await expect(import("./asset-cleanup.js")).resolves.toHaveProperty(
      "createAssetCleanupHandler",
      expect.any(Function),
    );
  });
});

describe("search.index handler", () => {
  it("indexes text extracted from the authoritative current note", async () => {
    const workspaceId = randomUUID();
    const noteId = randomUUID();
    const repository = new FakeSearchIndexRepository();
    repository.row = {
      noteId,
      workspaceId,
      revision: 4,
      title: "Authoritative title",
      contentMarkdown: MARKDOWN,
      deletedAt: null,
    };
    const searchPort = new MemorySearchPort();
    const handler = createSearchIndexHandler({ repository, searchPort });
    await handler(searchIndexJob(workspaceId, noteId, 4), new AbortController().signal);

    expect(searchPort.documents).toHaveLength(1);
    expect(searchPort.documents.get(noteId)).toMatchObject({
      noteId,
      workspaceId,
      revision: 4,
      title: "Authoritative title",
      headings: ["Indexed heading"],
    });
    expect(searchPort.documents.get(noteId)?.body).toContain("Searchable body.");
  });

  it("is safe when the same search.index job is delivered twice", async () => {
    const workspaceId = randomUUID();
    const noteId = randomUUID();
    const repository = new FakeSearchIndexRepository();
    repository.row = {
      noteId,
      workspaceId,
      revision: 4,
      title: "Authoritative title",
      contentMarkdown: MARKDOWN,
      deletedAt: null,
    };
    const searchPort = new MemorySearchPort();
    const handler = createSearchIndexHandler({ repository, searchPort });
    const job = searchIndexJob(workspaceId, noteId, 4);

    await handler(job, new AbortController().signal);
    await handler(job, new AbortController().signal);

    expect(repository.loaded).toEqual([noteId, noteId]);
    expect(searchPort.documents).toHaveLength(1);
    expect(searchPort.documents.get(noteId)?.revision).toBe(4);
  });

  it("does not let an out-of-order revision overwrite the current index", async () => {
    const workspaceId = randomUUID();
    const noteId = randomUUID();
    const repository = new FakeSearchIndexRepository();
    repository.row = {
      noteId,
      workspaceId,
      revision: 5,
      title: "Newest",
      contentMarkdown: MARKDOWN,
      deletedAt: null,
    };
    const searchPort = new MemorySearchPort();
    const handler = createSearchIndexHandler({ repository, searchPort });

    await handler(searchIndexJob(workspaceId, noteId, 4), new AbortController().signal);

    expect(repository.loaded).toEqual([noteId]);
    expect(searchPort.indexed).toEqual([]);
    expect(searchPort.removed).toEqual([]);
  });

  it("does not re-index an older revision after deletion wins the source race", async () => {
    const workspaceId = randomUUID();
    const noteId = randomUUID();
    const repository = new FakeSearchIndexRepository();
    repository.row = {
      noteId,
      workspaceId,
      revision: 5,
      title: "Deleted newest revision",
      contentMarkdown: MARKDOWN,
      deletedAt: new Date(),
    };
    const searchPort = new MemorySearchPort();
    const handler = createSearchIndexHandler({ repository, searchPort });

    await handler(searchIndexJob(workspaceId, noteId, 4), new AbortController().signal);

    expect(repository.loaded).toEqual([noteId]);
    expect(searchPort.indexed).toEqual([]);
    expect(searchPort.removed).toEqual([]);
  });

  it("does not re-index a stale revision when deletion commits after the source read", async () => {
    const workspaceId = randomUUID();
    const noteId = randomUUID();
    const repository = new FakeSearchIndexRepository();
    let currentSource: SearchIndexNoteRow = {
      noteId,
      workspaceId,
      revision: 4,
      title: "Active revision",
      contentMarkdown: MARKDOWN,
      deletedAt: null,
    };
    repository.row = currentSource;
    const searchPort = new MemorySearchPort(() => currentSource);
    const mutationEntered = deferred();
    const releaseMutation = deferred();
    searchPort.beforeIndex = async () => {
      mutationEntered.resolve();
      await releaseMutation.promise;
    };
    const handler = createSearchIndexHandler({ repository, searchPort });

    const staleIndex = handler(
      searchIndexJob(workspaceId, noteId, 4),
      new AbortController().signal,
    );
    await mutationEntered.promise;

    currentSource = {
      ...currentSource,
      revision: 5,
      title: "Deleted revision",
      deletedAt: new Date(),
    };
    repository.row = currentSource;
    await handler(searchIndexJob(workspaceId, noteId, 5), new AbortController().signal);

    releaseMutation.resolve();
    await staleIndex;

    expect(searchPort.documents.has(noteId)).toBe(false);
  });

  it("removes an index entry when the authoritative note is gone", async () => {
    const workspaceId = randomUUID();
    const noteId = randomUUID();
    const repository = new FakeSearchIndexRepository();
    const searchPort = new MemorySearchPort();
    searchPort.documents.set(noteId, {
      noteId,
      workspaceId,
      revision: 3,
      title: "Old",
      headings: [],
      body: "old",
      tags: [],
      normalizedText: "old",
    });
    const handler = createSearchIndexHandler({ repository, searchPort });

    await handler(searchIndexJob(workspaceId, noteId, 4), new AbortController().signal);

    expect(searchPort.documents.has(noteId)).toBe(false);
    expect(searchPort.removed).toEqual([noteId]);
  });

  it("removes an index entry when deletion is observed at the queued revision", async () => {
    const workspaceId = randomUUID();
    const noteId = randomUUID();
    const repository = new FakeSearchIndexRepository();
    const searchPort = new MemorySearchPort();
    searchPort.documents.set(noteId, {
      noteId,
      workspaceId,
      revision: 3,
      title: "Old",
      headings: [],
      body: "old",
      tags: [],
      normalizedText: "old",
    });
    const handler = createSearchIndexHandler({ repository, searchPort });

    repository.row = {
      noteId,
      workspaceId,
      revision: 4,
      title: "Deleted",
      contentMarkdown: MARKDOWN,
      deletedAt: new Date(),
    };
    await handler(searchIndexJob(workspaceId, noteId, 4), new AbortController().signal);
    expect(searchPort.indexed).toEqual([]);
    expect(searchPort.removed).toEqual([noteId]);
    expect(searchPort.documents.has(noteId)).toBe(false);
  });

  it("rejects cross-workspace source rows without changing another tenant's index", async () => {
    const claimedWorkspaceId = randomUUID();
    const noteId = randomUUID();
    const repository = new FakeSearchIndexRepository();
    repository.row = {
      noteId,
      workspaceId: randomUUID(),
      revision: 1,
      title: "Other tenant",
      contentMarkdown: MARKDOWN,
      deletedAt: null,
    };
    const searchPort = new MemorySearchPort();
    const handler = createSearchIndexHandler({ repository, searchPort });

    await expect(
      handler(searchIndexJob(claimedWorkspaceId, noteId, 1), new AbortController().signal),
    ).rejects.toThrow("JOB_INVALID");
    expect(searchPort.indexed).toEqual([]);
    expect(searchPort.removed).toEqual([]);
  });

  it("rejects a source row whose note identity does not match the job", async () => {
    const workspaceId = randomUUID();
    const noteId = randomUUID();
    const repository = new FakeSearchIndexRepository();
    repository.row = {
      noteId: randomUUID(),
      workspaceId,
      revision: 1,
      title: "Wrong note",
      contentMarkdown: MARKDOWN,
      deletedAt: null,
    };
    const searchPort = new MemorySearchPort();
    const handler = createSearchIndexHandler({ repository, searchPort });

    await expect(
      handler(searchIndexJob(workspaceId, noteId, 1), new AbortController().signal),
    ).rejects.toThrow("JOB_INVALID");
    expect(searchPort.indexed).toEqual([]);
    expect(searchPort.removed).toEqual([]);
  });

  it("maps repository and search-provider details to a scrubbed JOB_FAILED", async () => {
    const workspaceId = randomUUID();
    const noteId = randomUUID();
    const repository = new FakeSearchIndexRepository();
    repository.failure = new Error("postgresql://worker:secret@db/private-note");
    const searchPort = new MemorySearchPort();
    const handler = createSearchIndexHandler({ repository, searchPort });
    const job = searchIndexJob(workspaceId, noteId, 1);

    await expect(handler(job, new AbortController().signal)).rejects.toThrow(/^JOB_FAILED$/u);

    repository.failure = undefined;
    repository.row = {
      noteId,
      workspaceId,
      revision: 1,
      title: "Note",
      contentMarkdown: MARKDOWN,
      deletedAt: null,
    };
    searchPort.indexFailure = new Error("provider token=top-secret");
    await expect(handler(job, new AbortController().signal)).rejects.toThrow(/^JOB_FAILED$/u);
  });
});

describe("search.remove handler", () => {
  it("removes a soft-deleted note at the queued revision", async () => {
    const workspaceId = randomUUID();
    const noteId = randomUUID();
    const repository = new FakeSearchRemoveRepository();
    repository.row = {
      noteId,
      workspaceId,
      revision: 4,
      deletedAt: new Date(),
    };
    const searchPort = new MemorySearchPort();
    searchPort.documents.set(noteId, {
      noteId,
      workspaceId,
      revision: 3,
      title: "Old",
      headings: [],
      body: "old",
      tags: [],
      normalizedText: "old",
    });
    const handler = createSearchRemoveHandler({ repository, searchPort });

    await handler(searchRemoveJob(workspaceId, noteId, 4), new AbortController().signal);

    expect(searchPort.removed).toEqual([noteId]);
    expect(searchPort.documents.has(noteId)).toBe(false);
  });

  it("does not apply an out-of-order remove to a newer deletion revision", async () => {
    const workspaceId = randomUUID();
    const noteId = randomUUID();
    const repository = new FakeSearchRemoveRepository();
    repository.row = {
      noteId,
      workspaceId,
      revision: 5,
      deletedAt: new Date(),
    };
    const searchPort = new MemorySearchPort();
    const handler = createSearchRemoveHandler({ repository, searchPort });

    await handler(searchRemoveJob(workspaceId, noteId, 4), new AbortController().signal);

    expect(repository.loaded).toEqual([noteId]);
    expect(searchPort.removed).toEqual([]);
  });

  it("does not remove a note that has been restored before processing", async () => {
    const workspaceId = randomUUID();
    const noteId = randomUUID();
    const repository = new FakeSearchRemoveRepository();
    repository.row = {
      noteId,
      workspaceId,
      revision: 5,
      deletedAt: null,
    };
    const searchPort = new MemorySearchPort();
    const handler = createSearchRemoveHandler({ repository, searchPort });

    await handler(searchRemoveJob(workspaceId, noteId, 4), new AbortController().signal);

    expect(repository.loaded).toEqual([noteId]);
    expect(searchPort.removed).toEqual([]);
  });

  it("does not remove a newer restored index when restoration commits after the source read", async () => {
    const workspaceId = randomUUID();
    const noteId = randomUUID();
    let currentSource: CurrentSearchSource = {
      noteId,
      workspaceId,
      revision: 4,
      deletedAt: new Date(),
    };
    const removeRepository = new FakeSearchRemoveRepository();
    removeRepository.row = currentSource;
    const indexRepository = new FakeSearchIndexRepository();
    const searchPort = new MemorySearchPort(() => currentSource);
    searchPort.documents.set(noteId, {
      noteId,
      workspaceId,
      revision: 3,
      title: "Before deletion",
      headings: [],
      body: "old",
      tags: [],
      normalizedText: "old",
    });
    const mutationEntered = deferred();
    const releaseMutation = deferred();
    searchPort.beforeRemove = async () => {
      mutationEntered.resolve();
      await releaseMutation.promise;
    };
    const removeHandler = createSearchRemoveHandler({
      repository: removeRepository,
      searchPort,
    });
    const indexHandler = createSearchIndexHandler({ repository: indexRepository, searchPort });

    const staleRemove = removeHandler(
      searchRemoveJob(workspaceId, noteId, 4),
      new AbortController().signal,
    );
    await mutationEntered.promise;

    currentSource = { noteId, workspaceId, revision: 5, deletedAt: null };
    removeRepository.row = currentSource;
    indexRepository.row = {
      ...currentSource,
      title: "Restored revision",
      contentMarkdown: MARKDOWN,
    };
    await indexHandler(searchIndexJob(workspaceId, noteId, 5), new AbortController().signal);

    releaseMutation.resolve();
    await staleRemove;

    expect(searchPort.documents.get(noteId)?.revision).toBe(5);
  });

  it("is idempotent when the note and index entry are already absent", async () => {
    const workspaceId = randomUUID();
    const noteId = randomUUID();
    const repository = new FakeSearchRemoveRepository();
    const searchPort = new MemorySearchPort();
    const handler = createSearchRemoveHandler({ repository, searchPort });
    const job = searchRemoveJob(workspaceId, noteId, 4);

    await handler(job, new AbortController().signal);
    await handler(job, new AbortController().signal);

    expect(repository.loaded).toEqual([noteId, noteId]);
    expect(searchPort.documents.has(noteId)).toBe(false);
    expect(searchPort.removed).toEqual([noteId, noteId]);
  });

  it("rejects cross-workspace source rows without removing another tenant's index", async () => {
    const claimedWorkspaceId = randomUUID();
    const noteId = randomUUID();
    const repository = new FakeSearchRemoveRepository();
    repository.row = {
      noteId,
      workspaceId: randomUUID(),
      revision: 4,
      deletedAt: new Date(),
    };
    const searchPort = new MemorySearchPort();
    const handler = createSearchRemoveHandler({ repository, searchPort });

    await expect(
      handler(searchRemoveJob(claimedWorkspaceId, noteId, 4), new AbortController().signal),
    ).rejects.toThrow("JOB_INVALID");
    expect(searchPort.removed).toEqual([]);
  });

  it("rejects a source row whose note identity does not match the remove job", async () => {
    const workspaceId = randomUUID();
    const noteId = randomUUID();
    const repository = new FakeSearchRemoveRepository();
    repository.row = {
      noteId: randomUUID(),
      workspaceId,
      revision: 4,
      deletedAt: new Date(),
    };
    const searchPort = new MemorySearchPort();
    const handler = createSearchRemoveHandler({ repository, searchPort });

    await expect(
      handler(searchRemoveJob(workspaceId, noteId, 4), new AbortController().signal),
    ).rejects.toThrow("JOB_INVALID");
    expect(searchPort.removed).toEqual([]);
  });

  it("maps repository and search-provider details to a scrubbed JOB_FAILED", async () => {
    const workspaceId = randomUUID();
    const noteId = randomUUID();
    const repository = new FakeSearchRemoveRepository();
    repository.failure = new Error("SELECT private_note FROM notes");
    const searchPort = new MemorySearchPort();
    const handler = createSearchRemoveHandler({ repository, searchPort });
    const job = searchRemoveJob(workspaceId, noteId, 4);

    await expect(handler(job, new AbortController().signal)).rejects.toThrow(/^JOB_FAILED$/u);

    repository.failure = undefined;
    repository.row = {
      noteId,
      workspaceId,
      revision: 4,
      deletedAt: new Date(),
    };
    searchPort.removeFailure = new Error("provider secret=top-secret");
    await expect(handler(job, new AbortController().signal)).rejects.toThrow(/^JOB_FAILED$/u);
  });
});

describe("asset.cleanup handler", () => {
  const now = Date.parse("2026-08-27T00:00:00.000Z");
  const graceDays = 30;
  const graceMilliseconds = graceDays * 24 * 60 * 60 * 1_000;

  it("deletes only the server-derived original key at the exact grace boundary", async () => {
    const workspaceId = randomUUID();
    const assetId = randomUUID();
    const repository = new FakeAssetCleanupRepository();
    repository.row = {
      assetId,
      workspaceId,
      deletedAt: new Date(now - graceMilliseconds),
    };
    const storage = new InMemoryObjectStorage();
    const expectedKey = `workspace/${workspaceId}/assets/${assetId}/original`;
    const unrelatedKey = `workspace/${workspaceId}/assets/${randomUUID()}/original`;
    await putObject(storage, expectedKey);
    await putObject(storage, unrelatedKey);
    const handler = createAssetCleanupHandler({
      repository,
      storage,
      graceDays,
      clock: () => now,
    });

    await handler(assetCleanupJob(workspaceId, assetId), new AbortController().signal);

    expect(storage.has(expectedKey)).toBe(false);
    expect(storage.has(unrelatedKey)).toBe(true);
  });

  it("does not delete an object before the grace boundary", async () => {
    const workspaceId = randomUUID();
    const assetId = randomUUID();
    const repository = new FakeAssetCleanupRepository();
    repository.row = {
      assetId,
      workspaceId,
      deletedAt: new Date(now - graceMilliseconds + 1),
    };
    const storage = new InMemoryObjectStorage();
    const expectedKey = `workspace/${workspaceId}/assets/${assetId}/original`;
    await putObject(storage, expectedKey);
    const handler = createAssetCleanupHandler({
      repository,
      storage,
      graceDays,
      clock: () => now,
    });

    await handler(assetCleanupJob(workspaceId, assetId), new AbortController().signal);

    expect(repository.loaded).toEqual([assetId]);
    expect(storage.has(expectedKey)).toBe(true);
  });

  it("does not delete an active asset", async () => {
    const workspaceId = randomUUID();
    const assetId = randomUUID();
    const repository = new FakeAssetCleanupRepository();
    repository.row = { assetId, workspaceId, deletedAt: null };
    const storage = new InMemoryObjectStorage();
    const expectedKey = `workspace/${workspaceId}/assets/${assetId}/original`;
    await putObject(storage, expectedKey);
    const handler = createAssetCleanupHandler({
      repository,
      storage,
      graceDays,
      clock: () => now,
    });

    await handler(assetCleanupJob(workspaceId, assetId), new AbortController().signal);

    expect(repository.loaded).toEqual([assetId]);
    expect(storage.has(expectedKey)).toBe(true);
  });

  it("is a no-op after the metadata row has already been removed", async () => {
    const workspaceId = randomUUID();
    const assetId = randomUUID();
    const repository = new FakeAssetCleanupRepository();
    const storage = new InMemoryObjectStorage();
    const handler = createAssetCleanupHandler({
      repository,
      storage,
      graceDays,
      clock: () => now,
    });

    await handler(assetCleanupJob(workspaceId, assetId), new AbortController().signal);

    expect(repository.loaded).toEqual([assetId]);
    expect(storage.size()).toBe(0);
  });

  it("is safe when duplicate deliveries find the object already absent", async () => {
    const workspaceId = randomUUID();
    const assetId = randomUUID();
    const repository = new FakeAssetCleanupRepository();
    repository.row = {
      assetId,
      workspaceId,
      deletedAt: new Date(now - graceMilliseconds),
    };
    const deletedKeys: string[] = [];
    const storage = new InMemoryObjectStorage({
      beforeDelete(key) {
        deletedKeys.push(key);
      },
    });
    const handler = createAssetCleanupHandler({
      repository,
      storage,
      graceDays,
      clock: () => now,
    });
    const job = assetCleanupJob(workspaceId, assetId);

    await handler(job, new AbortController().signal);
    await handler(job, new AbortController().signal);

    const expectedKey = `workspace/${workspaceId}/assets/${assetId}/original`;
    expect(deletedKeys).toEqual([expectedKey, expectedKey]);
    expect(storage.has(expectedKey)).toBe(false);
  });

  it("rejects a cross-workspace row without deleting any object", async () => {
    const claimedWorkspaceId = randomUUID();
    const actualWorkspaceId = randomUUID();
    const assetId = randomUUID();
    const repository = new FakeAssetCleanupRepository();
    repository.row = {
      assetId,
      workspaceId: actualWorkspaceId,
      deletedAt: new Date(now - graceMilliseconds),
    };
    const storage = new InMemoryObjectStorage();
    const actualKey = `workspace/${actualWorkspaceId}/assets/${assetId}/original`;
    await putObject(storage, actualKey);
    const handler = createAssetCleanupHandler({
      repository,
      storage,
      graceDays,
      clock: () => now,
    });

    await expect(
      handler(assetCleanupJob(claimedWorkspaceId, assetId), new AbortController().signal),
    ).rejects.toThrow("JOB_INVALID");
    expect(storage.has(actualKey)).toBe(true);
  });

  it("maps repository and storage-provider details to a scrubbed JOB_FAILED", async () => {
    const workspaceId = randomUUID();
    const assetId = randomUUID();
    const repository = new FakeAssetCleanupRepository();
    repository.failure = new Error("postgres password=top-secret");
    const storage = new InMemoryObjectStorage({
      beforeDelete() {
        throw new Error("S3 token=top-secret");
      },
    });
    const handler = createAssetCleanupHandler({
      repository,
      storage,
      graceDays,
      clock: () => now,
    });
    const job = assetCleanupJob(workspaceId, assetId);

    await expect(handler(job, new AbortController().signal)).rejects.toThrow(/^JOB_FAILED$/u);

    repository.failure = undefined;
    repository.row = {
      assetId,
      workspaceId,
      deletedAt: new Date(now - graceMilliseconds),
    };
    await expect(handler(job, new AbortController().signal)).rejects.toThrow(/^JOB_FAILED$/u);
  });

  it("fails closed on an invalid authoritative deletion timestamp", async () => {
    const workspaceId = randomUUID();
    const assetId = randomUUID();
    const repository = new FakeAssetCleanupRepository();
    repository.row = {
      assetId,
      workspaceId,
      deletedAt: new Date(Number.NaN),
    };
    const deletedKeys: string[] = [];
    const storage = new InMemoryObjectStorage({
      beforeDelete(key) {
        deletedKeys.push(key);
      },
    });
    const handler = createAssetCleanupHandler({
      repository,
      storage,
      graceDays,
      clock: () => now,
    });

    await expect(
      handler(assetCleanupJob(workspaceId, assetId), new AbortController().signal),
    ).rejects.toThrow(/^JOB_FAILED$/u);
    expect(deletedKeys).toEqual([]);
  });

  it("rejects an unsafe cleanup grace configuration", () => {
    const repository = new FakeAssetCleanupRepository();
    const storage = new InMemoryObjectStorage();

    expect(() => createAssetCleanupHandler({ repository, storage, graceDays: 0 })).toThrow(
      /grace days/i,
    );
    expect(() => createAssetCleanupHandler({ repository, storage, graceDays: 3_651 })).toThrow(
      /grace days/i,
    );
  });
});
