import { randomUUID } from "node:crypto";
import {
  MAX_SEARCH_TEXT_BYTES,
  createDb,
  notes,
  user,
  workspaceMembers,
  workspaces,
  type Database,
} from "@glyphquire/database";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  extractSearchableText,
  normalizeSearchText,
  SearchTextTooLargeError,
} from "../src/extract.js";
import { PostgresSearchAdapter } from "../src/postgres.js";
import type { SearchableNote } from "../src/types.js";

describe("extractSearchableText", () => {
  it("collects headings and body while excluding fenced code", () => {
    const markdown = [
      "---",
      "glyphquire-spec: 1",
      "---",
      "",
      "# Project Nebula",
      "",
      "## Overview",
      "",
      "Shared GPU memory budget notes.",
      "",
      "```js",
      "const secretApiKey = 'sk-should-not-be-indexed';",
      "```",
    ].join("\n");

    const extracted = extractSearchableText("Project Nebula", markdown);

    expect(extracted.headings).toEqual(["Project Nebula", "Overview"]);
    expect(extracted.body).toContain("Shared GPU memory budget notes.");
    expect(extracted.body).not.toContain("secretApiKey");
    expect(extracted.normalizedText).not.toContain("secretapikey");
  });

  it("preserves CJK text through extraction and normalization", () => {
    const markdown = "---\nglyphquire-spec: 1\n---\n\n# 東京旅行\n\n明日は京都に行きます。";
    const extracted = extractSearchableText("東京旅行", markdown);

    expect(extracted.headings).toEqual(["東京旅行"]);
    expect(extracted.body).toContain("明日は京都に行きます。");
    expect(extracted.normalizedText).toContain("東京旅行");
    expect(extracted.normalizedText).toContain("明日は京都に行きます。");
  });

  it("normalizes case and whitespace deterministically", () => {
    const first = normalizeSearchText("  Hello   WORLD  \n\tagain  ");
    const second = normalizeSearchText("hello world again");
    expect(first).toBe(second);
    expect(first).toBe("hello world again");
  });

  it("rejects a title over the configured text bound", () => {
    const oversizedTitle = "x".repeat(2 * 1024 * 1024 + 1);
    expect(() => extractSearchableText(oversizedTitle, "body")).toThrow(SearchTextTooLargeError);
  });

  it("rejects oversized source Markdown before excluded code can evade the text bound", () => {
    const oversizedMarkdown = `\`\`\`text\n${"x".repeat(MAX_SEARCH_TEXT_BYTES + 1)}\n\`\`\``;

    expect(() => extractSearchableText("Bounded source", oversizedMarkdown)).toThrow(
      /SEARCH_TEXT_TOO_LARGE: markdown/,
    );
  });

  it("degrades to title-only extraction for a document that fails to parse into headings/body", () => {
    // An empty document still yields a stable, non-throwing shape.
    const extracted = extractSearchableText("Untitled", "");
    expect(extracted).toEqual({
      title: "Untitled",
      headings: [],
      body: "",
      tags: [],
      normalizedText: "untitled",
    });
  });
});

const databaseUrl = process.env.TEST_DATABASE_URL;
const describeWithPostgres = databaseUrl ? describe : describe.skip;

async function insertActor(db: Database, prefix: string): Promise<string> {
  const id = `${prefix}-${randomUUID()}`;
  await db.insert(user).values({ id, name: prefix, email: `${id}@example.test` });
  return id;
}

async function insertWorkspace(db: Database, ownerId: string): Promise<string> {
  const [workspace] = await db
    .insert(workspaces)
    .values({ personalOwnerId: ownerId })
    .returning({ id: workspaces.id });
  await db
    .insert(workspaceMembers)
    .values({ workspaceId: workspace!.id, userId: ownerId, role: "owner" });
  return workspace!.id;
}

async function insertNote(
  db: Database,
  workspaceId: string,
  ownerId: string,
  title: string,
): Promise<string> {
  const [note] = await db
    .insert(notes)
    .values({
      workspaceId,
      title,
      contentMarkdown: title,
      contentHash: "hash",
      ownerId,
    })
    .returning({ id: notes.id });
  return note!.id;
}

function searchableNote(
  overrides: Partial<SearchableNote> & { noteId: string; workspaceId: string },
): SearchableNote {
  return {
    revision: 1,
    title: "Untitled",
    headings: [],
    body: "",
    tags: [],
    normalizedText: "untitled",
    ...overrides,
  };
}

describeWithPostgres("PostgresSearchAdapter", () => {
  let db: Database;
  let adapter: PostgresSearchAdapter;
  let ownerId: string;
  let workspaceId: string;

  beforeAll(async () => {
    db = createDb(databaseUrl!);
    adapter = new PostgresSearchAdapter(db);
    ownerId = await insertActor(db, "search-adapter");
    workspaceId = await insertWorkspace(db, ownerId);
  });

  afterAll(async () => {
    await db.$client.end();
  });

  it("indexes a note and finds it by tokenized English text", async () => {
    const noteId = await insertNote(db, workspaceId, ownerId, "Glacier Survey");
    await adapter.indexNote(
      searchableNote({
        noteId,
        workspaceId,
        revision: 1,
        title: "Glacier Survey",
        headings: ["Glacier Survey"],
        body: "Field notes about glacier retreat measurements.",
        normalizedText: normalizeSearchText(
          "Glacier Survey Field notes about glacier retreat measurements.",
        ),
      }),
    );

    const results = await adapter.search({
      actorId: ownerId,
      workspaceId,
      q: "glacier retreat",
      pageSize: 10,
    });
    expect(results.map((row) => row.noteId)).toContain(noteId);
  });

  it("finds CJK notes via trigram fallback", async () => {
    const noteId = await insertNote(db, workspaceId, ownerId, "東京旅行");
    await adapter.indexNote(
      searchableNote({
        noteId,
        workspaceId,
        revision: 1,
        title: "東京旅行",
        headings: ["東京旅行"],
        body: "明日は京都に行きます。",
        normalizedText: normalizeSearchText("東京旅行 明日は京都に行きます。"),
      }),
    );

    const results = await adapter.search({
      actorId: ownerId,
      workspaceId,
      q: "京都",
      pageSize: 10,
    });
    expect(results.map((row) => row.noteId)).toContain(noteId);
  });

  it("finds a fuzzy word through trigram fallback rather than substring matching alone", async () => {
    const marker = randomUUID().replaceAll("-", "");
    const noteId = await insertNote(db, workspaceId, ownerId, `Glacier ${marker}`);
    await adapter.indexNote(
      searchableNote({
        noteId,
        workspaceId,
        title: `Glacier ${marker}`,
        body: "Glacier observations",
        normalizedText: normalizeSearchText(`Glacier ${marker} Glacier observations`),
      }),
    );

    const fuzzyQuery = { actorId: ownerId, workspaceId, q: "glacir", pageSize: 10 };
    const results = await adapter.search(fuzzyQuery);
    expect(results.map((row) => row.noteId)).toContain(noteId);
  });

  it("returns no results for a query that normalizes to empty text", async () => {
    const marker = randomUUID().replaceAll("-", "");
    const noteId = await insertNote(db, workspaceId, ownerId, `Whitespace ${marker}`);
    await adapter.indexNote(
      searchableNote({
        noteId,
        workspaceId,
        title: `Whitespace ${marker}`,
        normalizedText: normalizeSearchText(`Whitespace ${marker}`),
      }),
    );

    const emptyQuery = { actorId: ownerId, workspaceId, q: " \n\t ", pageSize: 10 };
    const results = await adapter.search(emptyQuery);
    expect(results).toEqual([]);
  });

  it("treats a stale-revision index write as a no-op", async () => {
    const noteId = await insertNote(db, workspaceId, ownerId, "Stale Revision Note");
    await adapter.indexNote(
      searchableNote({
        noteId,
        workspaceId,
        revision: 5,
        title: "Latest Title",
        normalizedText: normalizeSearchText("Latest Title"),
      }),
    );
    await adapter.indexNote(
      searchableNote({
        noteId,
        workspaceId,
        revision: 2,
        title: "Stale Title",
        normalizedText: normalizeSearchText("Stale Title"),
      }),
    );

    const results = await adapter.search({
      actorId: ownerId,
      workspaceId,
      q: "Title",
      pageSize: 10,
    });
    const match = results.find((row) => row.noteId === noteId);
    expect(match?.title).toBe("Latest Title");
    expect(match?.revision).toBe(5);
  });

  it("treats note removal as idempotent", async () => {
    const noteId = await insertNote(db, workspaceId, ownerId, "Removable Note");
    await adapter.indexNote(
      searchableNote({
        noteId,
        workspaceId,
        title: "Removable Note",
        normalizedText: normalizeSearchText("Removable Note"),
      }),
    );
    await adapter.removeNote(noteId);
    await expect(adapter.removeNote(noteId)).resolves.toBeUndefined();

    const results = await adapter.search({
      actorId: ownerId,
      workspaceId,
      q: "Removable",
      pageSize: 10,
    });
    expect(results.some((row) => row.noteId === noteId)).toBe(false);
  });

  it("filters out soft-deleted notes even if their index row lingers", async () => {
    const noteId = await insertNote(db, workspaceId, ownerId, "Deleted Note Text");
    await adapter.indexNote(
      searchableNote({
        noteId,
        workspaceId,
        title: "Deleted Note Text",
        normalizedText: normalizeSearchText("Deleted Note Text"),
      }),
    );
    await db
      .update(notes)
      .set({ deletedAt: new Date(), revision: sql`${notes.revision} + 1` })
      .where(eq(notes.id, noteId));

    const results = await adapter.search({
      actorId: ownerId,
      workspaceId,
      q: "Deleted Note",
      pageSize: 10,
    });
    expect(results.some((row) => row.noteId === noteId)).toBe(false);
  });

  it("never returns results from a different workspace", async () => {
    const otherOwnerId = await insertActor(db, "search-adapter-other");
    const otherWorkspaceId = await insertWorkspace(db, otherOwnerId);
    const noteId = await insertNote(db, otherWorkspaceId, otherOwnerId, "Cross Tenant Secret");
    await adapter.indexNote(
      searchableNote({
        noteId,
        workspaceId: otherWorkspaceId,
        title: "Cross Tenant Secret",
        normalizedText: normalizeSearchText("Cross Tenant Secret"),
      }),
    );

    const results = await adapter.search({
      actorId: ownerId,
      workspaceId,
      q: "Cross Tenant Secret",
      pageSize: 10,
    });
    expect(results.some((row) => row.noteId === noteId)).toBe(false);
  });

  it("filters current workspace membership in the same SQL query as search results", async () => {
    const outsiderId = await insertActor(db, "search-adapter-non-member");
    const marker = randomUUID().replaceAll("-", "");
    const noteId = await insertNote(db, workspaceId, ownerId, `Atomic membership ${marker}`);
    await adapter.indexNote(
      searchableNote({
        noteId,
        workspaceId,
        title: `Atomic membership ${marker}`,
        normalizedText: normalizeSearchText(`Atomic membership ${marker}`),
      }),
    );

    const unauthorizedQuery = {
      actorId: outsiderId,
      workspaceId,
      q: marker,
      pageSize: 10,
    };
    const results = await adapter.search(unauthorizedQuery);
    expect(results).toEqual([]);
  });

  it("paginates with a stable cursor that never repeats or skips a match", async () => {
    const marker = randomUUID().replaceAll("-", "");
    const term = `paginationmarker${marker}`;
    const noteIds: string[] = [];
    for (let index = 0; index < 5; index += 1) {
      const noteId = await insertNote(db, workspaceId, ownerId, `Cursor note ${index}`);
      await adapter.indexNote(
        searchableNote({
          noteId,
          workspaceId,
          title: `Cursor note ${index} ${term}`,
          normalizedText: normalizeSearchText(`Cursor note ${index} ${term}`),
        }),
      );
      noteIds.push(noteId);
      // Ensure a strictly increasing updated_at ordering between rows.
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    const seen: string[] = [];
    let cursor: { updatedAt: string; noteId: string } | undefined;
    for (let guard = 0; guard < 10; guard += 1) {
      const page = await adapter.search({
        actorId: ownerId,
        workspaceId,
        q: term,
        pageSize: 2,
        cursor,
      });
      const kept = page.slice(0, 2);
      if (kept.length === 0) break;
      seen.push(...kept.map((row) => row.noteId));
      const last = kept[kept.length - 1]!;
      if (page.length <= 2) break;
      cursor = { updatedAt: last.updatedAt, noteId: last.noteId };
    }

    expect(new Set(seen).size).toBe(seen.length);
    expect(new Set(seen)).toEqual(new Set(noteIds));
  });
});
