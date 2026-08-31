import { describe, expect, it, vi } from "vitest";
import { SearchReadModule } from "./SearchReadModule.js";
import type { SearchDocument, SearchQueryPort } from "@glyphquire/search";

const WORKSPACE_ID = "22222222-2222-4222-8222-222222222222";

function document(
  overrides: Partial<SearchDocument> & Pick<SearchDocument, "noteId">,
): SearchDocument {
  const { noteId, ...rest } = overrides;
  return {
    noteId,
    workspaceId: WORKSPACE_ID,
    revision: 4,
    title: "Untitled",
    snippet: "body",
    score: 0.2,
    updatedAt: "2026-08-30T00:00:00.000Z",
    headings: "",
    tags: "",
    body: "body",
    ...rest,
  };
}

describe("SearchReadModule", () => {
  it("retrieves, ranks, paginates, and hydrates a public response", async () => {
    const search = vi.fn<SearchQueryPort["search"]>().mockResolvedValue([
      document({ noteId: "33333333-3333-4333-8333-333333333333", title: "other" }),
      document({
        noteId: "44444444-4444-4444-8444-444444444444",
        title: "needle",
        headings: "needle",
        snippet: "needle excerpt",
        body: "needle body",
      }),
    ]);
    const module = new SearchReadModule({ search });

    const result = await module.search("actor", {
      workspaceId: WORKSPACE_ID,
      q: "needle",
      pageSize: 1,
      ranking: "weighted-v1",
    });

    expect(search).toHaveBeenCalledWith({
      actorId: "actor",
      workspaceId: WORKSPACE_ID,
      q: "needle",
      pageSize: 10_000,
      cursor: undefined,
    });
    expect(result.items).toEqual([
      {
        noteId: "44444444-4444-4444-8444-444444444444",
        workspaceId: WORKSPACE_ID,
        revision: 4,
        title: "needle",
        snippet: "needle excerpt",
        score: 13,
        rankingVersion: "weighted-v1",
        updatedAt: "2026-08-30T00:00:00.000Z",
      },
    ]);
    expect(result.nextCursor).not.toBeNull();
  });

  it("translates malformed cursors and retrieval failures at the read seam", async () => {
    const search = vi.fn<SearchQueryPort["search"]>().mockRejectedValue(new Error("database"));
    const module = new SearchReadModule({ search });

    await expect(
      module.search("actor", {
        workspaceId: WORKSPACE_ID,
        q: "needle",
        pageSize: 10,
        cursor: "bad",
      }),
    ).rejects.toMatchObject({ code: "NOTE_NOT_FOUND", status: 404 });
    expect(search).not.toHaveBeenCalled();

    await expect(
      module.search("actor", {
        workspaceId: WORKSPACE_ID,
        q: "needle",
        pageSize: 10,
      }),
    ).rejects.toMatchObject({
      code: "SEARCH_UNAVAILABLE",
      status: 503,
    });
  });

  it("does not repeat newer rows when a weighted cursor anchor was removed", async () => {
    const search = vi
      .fn<SearchQueryPort["search"]>()
      .mockResolvedValueOnce([
        document({
          noteId: "33333333-3333-4333-8333-333333333333",
          updatedAt: "2026-08-30T01:00:00.000Z",
          title: "needle",
          headings: "needle",
          body: "",
        }),
        document({
          noteId: "44444444-4444-4444-8444-444444444444",
          updatedAt: "2026-08-30T03:00:00.000Z",
          title: "other",
          headings: "",
          body: "needle",
        }),
      ])
      .mockResolvedValueOnce([
        document({
          noteId: "44444444-4444-4444-8444-444444444444",
          updatedAt: "2026-08-30T03:00:00.000Z",
          title: "other",
          headings: "",
          body: "needle",
        }),
      ]);
    const module = new SearchReadModule({ search });

    const firstPage = await module.search("actor", {
      workspaceId: WORKSPACE_ID,
      q: "needle",
      pageSize: 1,
      ranking: "weighted-v1",
    });
    expect(firstPage.nextCursor).not.toBeNull();

    const result = await module.search("actor", {
      workspaceId: WORKSPACE_ID,
      q: "needle",
      pageSize: 10,
      ranking: "weighted-v1",
      cursor: firstPage.nextCursor!,
    });

    expect(result.items.map((item) => item.noteId)).toEqual([
      "44444444-4444-4444-8444-444444444444",
    ]);
  });

  it("does not repeat a tied row when the weighted cursor anchor disappears", async () => {
    const search = vi
      .fn<SearchQueryPort["search"]>()
      .mockResolvedValueOnce([
        document({
          noteId: "33333333-3333-4333-8333-333333333333",
          updatedAt: "2026-08-30T00:00:00.000Z",
          body: "needle",
        }),
        document({
          noteId: "44444444-4444-4444-8444-444444444444",
          updatedAt: "2026-08-30T00:00:00.000Z",
          body: "needle",
        }),
        document({
          noteId: "55555555-5555-4555-8555-555555555555",
          updatedAt: "2026-08-30T00:00:00.000Z",
          body: "needle",
        }),
      ])
      .mockResolvedValueOnce([
        document({
          noteId: "33333333-3333-4333-8333-333333333333",
          updatedAt: "2026-08-30T00:00:00.000Z",
          body: "needle",
        }),
        document({
          noteId: "55555555-5555-4555-8555-555555555555",
          updatedAt: "2026-08-30T00:00:00.000Z",
          body: "needle",
        }),
      ]);
    const module = new SearchReadModule({ search });

    const firstPage = await module.search("actor", {
      workspaceId: WORKSPACE_ID,
      q: "needle",
      pageSize: 2,
      ranking: "weighted-v1",
    });
    expect(firstPage.items.map((item) => item.noteId)).toEqual([
      "33333333-3333-4333-8333-333333333333",
      "44444444-4444-4444-8444-444444444444",
    ]);
    expect(firstPage.nextCursor).not.toBeNull();

    const result = await module.search("actor", {
      workspaceId: WORKSPACE_ID,
      q: "needle",
      pageSize: 2,
      ranking: "weighted-v1",
      cursor: firstPage.nextCursor!,
    });

    expect(result.items.map((item) => item.noteId)).toEqual([
      "55555555-5555-4555-8555-555555555555",
    ]);
  });
});
