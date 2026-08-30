import { randomUUID } from "node:crypto";
import { searchQuerySchema, searchResponseSchema } from "@glyphquire/api-contract";
import {
  createDb,
  notes,
  searchDocuments,
  user,
  workspaceMembers,
  workspaces,
  type Database,
} from "@glyphquire/database";
import type { EnqueueJobInput, JobDispatcher, JobRegistry } from "@glyphquire/queue";
import { PostgresSearchAdapter, normalizeSearchText } from "@glyphquire/search";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createOperatorAuthorizer } from "./OperatorAuthorizer.js";
import { SearchServiceImpl } from "./SearchService.js";

describe("advanced search ranking contracts", () => {
  const workspaceId = randomUUID();
  const noteId = randomUUID();
  const timestamp = "2026-08-30T00:00:00.000Z";

  it("defaults to relevance and accepts only the bounded ranking union", () => {
    expect(searchQuerySchema.parse({ workspaceId, q: "needle", pageSize: 10 })).toMatchObject({
      ranking: "relevance",
    });
    expect(
      searchQuerySchema.safeParse({
        workspaceId,
        q: "needle",
        pageSize: 10,
        ranking: "weighted-v1",
      }).success,
    ).toBe(true);
    expect(
      searchQuerySchema.safeParse({
        workspaceId,
        q: "needle",
        pageSize: 10,
        ranking: "other",
      }).success,
    ).toBe(false);
    expect(
      searchQuerySchema.safeParse({
        workspaceId,
        q: "needle",
        pageSize: 10,
        ranking: "weighted-v1",
        unknown: true,
      }).success,
    ).toBe(false);
  });

  it("requires a ranking version in every strict result", () => {
    const item = {
      noteId,
      workspaceId,
      revision: 1,
      title: "Needle",
      snippet: "Needle",
      score: 8,
      updatedAt: timestamp,
    };
    expect(
      searchResponseSchema.safeParse({
        items: [{ ...item, rankingVersion: "weighted-v1" }],
        nextCursor: null,
      }).success,
    ).toBe(true);
    expect(searchResponseSchema.safeParse({ items: [item], nextCursor: null }).success).toBe(false);
    expect(
      searchResponseSchema.safeParse({
        items: [{ ...item, rankingVersion: "weighted-v1", unknown: true }],
        nextCursor: null,
      }).success,
    ).toBe(false);
  });
});

const databaseUrl = process.env.TEST_DATABASE_URL;
const describeWithPostgres = databaseUrl ? describe : describe.skip;

class FakeJobDispatcher implements JobDispatcher {
  async enqueue<TType extends never>(
    _input: EnqueueJobInput<TType>,
  ): Promise<{ id: string; duplicate: boolean }> {
    return { id: randomUUID(), duplicate: false };
  }

  async dispatchBatch(_registry: JobRegistry) {
    return { claimed: 0, succeeded: 0, retried: 0, deadLettered: 0 };
  }
}

describeWithPostgres("SearchService weighted ranking", () => {
  let db: Database;

  beforeAll(() => {
    db = createDb(databaseUrl!);
  });

  afterAll(async () => {
    await db.$client.end();
  });

  async function fixture() {
    const owner = `ranking-owner-${randomUUID()}`;
    await db.insert(user).values({ id: owner, name: owner, email: `${owner}@example.test` });
    const [workspace] = await db
      .insert(workspaces)
      .values({ personalOwnerId: owner })
      .returning({ id: workspaces.id });
    await db
      .insert(workspaceMembers)
      .values({ workspaceId: workspace!.id, userId: owner, role: "owner" });
    return { owner, workspaceId: workspace!.id };
  }

  async function indexedNote(
    workspaceId: string,
    ownerId: string,
    fields: {
      title: string;
      headings?: string[];
      tags?: string[];
      body?: string;
    },
  ) {
    const [note] = await db
      .insert(notes)
      .values({
        workspaceId,
        title: fields.title,
        contentMarkdown: fields.title,
        contentHash: randomUUID(),
        ownerId,
      })
      .returning({ id: notes.id });
    const headings = fields.headings ?? [];
    const tags = fields.tags ?? [];
    const body = fields.body ?? "";
    const adapter = new PostgresSearchAdapter(db);
    await adapter.indexNote({
      noteId: note!.id,
      workspaceId,
      revision: 1,
      title: fields.title,
      headings,
      tags,
      body,
      normalizedText: normalizeSearchText(
        [fields.title, ...headings, ...tags, body].filter(Boolean).join(" "),
      ),
    });
    return note!.id;
  }

  function service() {
    const adapter = new PostgresSearchAdapter(db);
    return new SearchServiceImpl(
      db,
      adapter,
      new FakeJobDispatcher(),
      createOperatorAuthorizer([]),
    );
  }

  it("ranks weighted fields, keeps CJK/trigram candidates, and reports the version", async () => {
    const { owner, workspaceId } = await fixture();
    const marker = `ranking-${randomUUID().replaceAll("-", "")}`;
    const titleId = await indexedNote(workspaceId, owner, { title: `${marker} title` });
    const tagId = await indexedNote(workspaceId, owner, {
      title: "tag note",
      tags: [marker],
    });
    const headingId = await indexedNote(workspaceId, owner, {
      title: "heading note",
      headings: [marker],
    });
    const bodyId = await indexedNote(workspaceId, owner, {
      title: "body note",
      body: marker,
    });
    const cjkId = await indexedNote(workspaceId, owner, {
      title: "東京旅行",
      body: "明日は京都に行きます。",
    });
    const fuzzyId = await indexedNote(workspaceId, owner, {
      title: "Glacier observations",
    });

    const result = await service().search(owner, {
      workspaceId,
      q: marker,
      pageSize: 100,
      ranking: "weighted-v1",
    });
    expect(result.items.slice(0, 4).map((item) => item.noteId)).toEqual([
      titleId,
      tagId,
      headingId,
      bodyId,
    ]);
    expect(result.items.slice(0, 4).map((item) => item.score)).toEqual([8, 6, 4, 1]);
    expect(result.items.slice(0, 4).every((item) => item.rankingVersion === "weighted-v1")).toBe(
      true,
    );

    const cjk = await service().search(owner, {
      workspaceId,
      q: "京都",
      pageSize: 100,
      ranking: "weighted-v1",
    });
    expect(cjk.items.map((item) => item.noteId)).toContain(cjkId);

    const fuzzy = await service().search(owner, {
      workspaceId,
      q: "glacir",
      pageSize: 100,
      ranking: "weighted-v1",
    });
    expect(fuzzy.items.map((item) => item.noteId)).toContain(fuzzyId);
  });

  it("keeps tenant and deleted-note filters while applying the stable tie-break", async () => {
    const { owner, workspaceId } = await fixture();
    const otherOwner = `ranking-other-${randomUUID()}`;
    await db
      .insert(user)
      .values({ id: otherOwner, name: otherOwner, email: `${otherOwner}@example.test` });
    const [otherWorkspace] = await db
      .insert(workspaces)
      .values({ personalOwnerId: otherOwner })
      .returning({ id: workspaces.id });
    await db
      .insert(workspaceMembers)
      .values({ workspaceId: otherWorkspace!.id, userId: otherOwner, role: "owner" });

    const marker = `tie-${randomUUID().replaceAll("-", "")}`;
    const firstId = await indexedNote(workspaceId, owner, { title: "first", body: marker });
    const secondId = await indexedNote(workspaceId, owner, { title: "second", body: marker });
    const deletedId = await indexedNote(workspaceId, owner, { title: "deleted", body: marker });
    const foreignId = await indexedNote(otherWorkspace!.id, otherOwner, {
      title: "foreign",
      body: marker,
    });
    const tieTimestamp = new Date("2026-08-30T00:00:00.000Z");
    await db
      .update(searchDocuments)
      .set({ updatedAt: tieTimestamp })
      .where(
        and(eq(searchDocuments.workspaceId, workspaceId), eq(searchDocuments.noteId, firstId)),
      );
    await db
      .update(searchDocuments)
      .set({ updatedAt: tieTimestamp })
      .where(
        and(eq(searchDocuments.workspaceId, workspaceId), eq(searchDocuments.noteId, secondId)),
      );
    await db
      .update(notes)
      .set({ deletedAt: new Date(), revision: 2 })
      .where(eq(notes.id, deletedId));

    const result = await service().search(owner, {
      workspaceId,
      q: marker,
      pageSize: 100,
      ranking: "weighted-v1",
    });
    const tieIds = [firstId, secondId].sort();
    expect(result.items.slice(0, 2).map((item) => item.noteId)).toEqual(tieIds);
    expect(result.items.map((item) => item.noteId)).not.toContain(deletedId);
    expect(result.items.map((item) => item.noteId)).not.toContain(foreignId);
  });
});
