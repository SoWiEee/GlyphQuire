import { randomUUID } from "node:crypto";
import type { SearchPort, SearchQuery, SearchResult, SearchableNote } from "@glyphquire/search";
import { describe, expect, it } from "vitest";
import {
  createSearchRebuildNoteHandler,
  type SearchRebuildNoteRepository,
  type SearchRebuildNoteRow,
} from "./search-rebuild-note.js";
import { jobRegistry } from "../registry.js";

class FakeRepository implements SearchRebuildNoteRepository {
  readonly rows = new Map<string, SearchRebuildNoteRow>();

  seed(row: SearchRebuildNoteRow): void {
    this.rows.set(row.noteId, row);
  }

  async loadNote(noteId: string): Promise<SearchRebuildNoteRow | undefined> {
    return this.rows.get(noteId);
  }
}

class FakeSearchPort implements SearchPort {
  readonly indexed: SearchableNote[] = [];
  readonly removed: string[] = [];

  async indexNote(note: SearchableNote): Promise<void> {
    this.indexed.push(note);
  }

  async removeNote(noteId: string): Promise<void> {
    this.removed.push(noteId);
  }

  async search(_query: SearchQuery): Promise<SearchResult[]> {
    return [];
  }
}

function jobFor(payload: Record<string, unknown>) {
  return {
    id: randomUUID(),
    workspaceId: (payload.workspaceId as string) ?? null,
    type: "search.rebuild" as const,
    version: 1,
    attempts: 1,
    createdAt: new Date().toISOString(),
    payload,
  } as never;
}

const MARKDOWN = "---\nglyphquire-spec: 1\n---\n\n# Rebuild Target\n\nSome searchable body text.";

describe("createSearchRebuildNoteHandler", () => {
  it("preserves the one-note search.rebuild handoff in the Task 4 static registry", () => {
    expect(Object.keys(jobRegistry)).toEqual([
      "search.index",
      "search.remove",
      "search.rebuild",
      "asset.cleanup",
      "asset.thumbnail",
    ]);
    expect(Object.isFrozen(jobRegistry)).toBe(true);
  });

  it("re-extracts and indexes an active note", async () => {
    const workspaceId = randomUUID();
    const noteId = randomUUID();
    const repository = new FakeRepository();
    repository.seed({
      noteId,
      workspaceId,
      revision: 3,
      title: "Rebuild Target",
      contentMarkdown: MARKDOWN,
      deletedAt: null,
    });
    const searchPort = new FakeSearchPort();
    const handler = createSearchRebuildNoteHandler({ repository, searchPort });

    await handler(
      jobFor({ workspaceId, scope: "note", noteId, batchSize: 1 }),
      new AbortController().signal,
    );

    expect(searchPort.removed).toEqual([]);
    expect(searchPort.indexed).toHaveLength(1);
    expect(searchPort.indexed[0]).toMatchObject({
      noteId,
      workspaceId,
      revision: 3,
      title: "Rebuild Target",
      headings: ["Rebuild Target"],
    });
    expect(searchPort.indexed[0]!.body).toContain("Some searchable body text.");
  });

  it("removes the index entry when the note is missing", async () => {
    const workspaceId = randomUUID();
    const noteId = randomUUID();
    const repository = new FakeRepository(); // never seeded: not found / deleted
    const searchPort = new FakeSearchPort();
    const handler = createSearchRebuildNoteHandler({ repository, searchPort });

    await handler(
      jobFor({ workspaceId, scope: "note", noteId, batchSize: 1 }),
      new AbortController().signal,
    );

    expect(searchPort.indexed).toEqual([]);
    expect(searchPort.removed).toEqual([noteId]);
  });

  it("removes the index entry for a soft-deleted note in the claimed workspace", async () => {
    const workspaceId = randomUUID();
    const noteId = randomUUID();
    const repository = new FakeRepository();
    repository.seed({
      noteId,
      workspaceId,
      revision: 2,
      title: "Deleted note",
      contentMarkdown: MARKDOWN,
      deletedAt: new Date(),
    });
    const searchPort = new FakeSearchPort();
    const handler = createSearchRebuildNoteHandler({ repository, searchPort });

    await handler(
      jobFor({ workspaceId, scope: "note", noteId, batchSize: 1 }),
      new AbortController().signal,
    );

    expect(searchPort.indexed).toEqual([]);
    expect(searchPort.removed).toEqual([noteId]);
  });

  it("rejects a mismatched workspace without removing another tenant's index row", async () => {
    const actualWorkspaceId = randomUUID();
    const claimedWorkspaceId = randomUUID();
    const noteId = randomUUID();
    const repository = new FakeRepository();
    repository.seed({
      noteId,
      workspaceId: actualWorkspaceId,
      revision: 1,
      title: "Other tenant note",
      contentMarkdown: MARKDOWN,
      deletedAt: null,
    });
    const searchPort = new FakeSearchPort();
    const handler = createSearchRebuildNoteHandler({ repository, searchPort });

    await expect(
      handler(
        jobFor({ workspaceId: claimedWorkspaceId, scope: "note", noteId, batchSize: 1 }),
        new AbortController().signal,
      ),
    ).rejects.toThrow(/JOB_INVALID/);
    expect(searchPort.indexed).toEqual([]);
    expect(searchPort.removed).toEqual([]);
  });

  it("is idempotent across at-least-once redelivery", async () => {
    const workspaceId = randomUUID();
    const noteId = randomUUID();
    const repository = new FakeRepository();
    repository.seed({
      noteId,
      workspaceId,
      revision: 1,
      title: "Rebuild Target",
      contentMarkdown: MARKDOWN,
      deletedAt: null,
    });
    const searchPort = new FakeSearchPort();
    const handler = createSearchRebuildNoteHandler({ repository, searchPort });
    const job = jobFor({ workspaceId, scope: "note", noteId, batchSize: 1 });

    await handler(job, new AbortController().signal);
    await handler(job, new AbortController().signal);

    expect(searchPort.indexed).toHaveLength(2);
    expect(searchPort.indexed.every((note) => note.noteId === noteId)).toBe(true);
  });

  it("rejects the workspace-scan branch, which is not registered until Task 7", async () => {
    const workspaceId = randomUUID();
    const repository = new FakeRepository();
    const searchPort = new FakeSearchPort();
    const handler = createSearchRebuildNoteHandler({ repository, searchPort });

    await expect(
      handler(
        jobFor({ workspaceId, scope: "workspace", batchSize: 10 }),
        new AbortController().signal,
      ),
    ).rejects.toThrow(/JOB_INVALID/);
    expect(searchPort.indexed).toEqual([]);
    expect(searchPort.removed).toEqual([]);
  });
});
