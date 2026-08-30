import { describe, expect, it } from "vitest";
import { rankSearchResults, scoreWeightedV1, type SearchRankingDocument } from "../src/ranking.js";

function document(
  overrides: Partial<SearchRankingDocument> & Pick<SearchRankingDocument, "noteId">,
): SearchRankingDocument {
  return {
    noteId: overrides.noteId,
    updatedAt: "2026-08-30T00:00:00.000Z",
    title: "",
    tags: [],
    headings: [],
    body: "",
    score: 0,
    ...overrides,
  };
}

describe("weighted search ranking", () => {
  it("assigns the documented field weights and returns its ranking version", () => {
    expect(scoreWeightedV1({ title: "needle", tags: [], headings: [], body: "" }, "needle")).toBe(
      8,
    );
    expect(scoreWeightedV1({ title: "", tags: ["needle"], headings: [], body: "" }, "needle")).toBe(
      6,
    );
    expect(scoreWeightedV1({ title: "", tags: [], headings: ["needle"], body: "" }, "needle")).toBe(
      4,
    );
    expect(scoreWeightedV1({ title: "", tags: [], headings: [], body: "needle" }, "needle")).toBe(
      1,
    );

    const [result] = rankSearchResults(
      [document({ noteId: "weighted-note", title: "needle" })],
      "needle",
      "weighted-v1",
    );
    expect(result).toMatchObject({
      noteId: "weighted-note",
      score: 8,
      rankingVersion: "weighted-v1",
    });
  });

  it("keeps CJK and fuzzy trigram matches rankable", () => {
    const ranked = rankSearchResults(
      [
        document({ noteId: "cjk-note", body: "明日は京都に行きます。" }),
        document({ noteId: "fuzzy-note", title: "Glacier observations" }),
      ],
      "京都 glacir",
      "weighted-v1",
    );

    expect(ranked.find((item) => item.noteId === "cjk-note")?.score).toBe(1);
    expect(ranked.find((item) => item.noteId === "fuzzy-note")?.score).toBe(8);
  });

  it("ties by updatedAt descending and noteId ascending", () => {
    const ranked = rankSearchResults(
      [
        document({ noteId: "b-note", body: "needle", updatedAt: "2026-08-30T00:00:00.000Z" }),
        document({ noteId: "a-note", body: "needle", updatedAt: "2026-08-30T00:00:00.000Z" }),
        document({ noteId: "newer-note", body: "needle", updatedAt: "2026-08-31T00:00:00.000Z" }),
      ],
      "needle",
      "weighted-v1",
    );

    expect(ranked.map((item) => item.noteId)).toEqual(["newer-note", "a-note", "b-note"]);
  });

  it("uses relevance scores when relevance ranking is selected", () => {
    const ranked = rankSearchResults(
      [document({ noteId: "low", score: 0.1 }), document({ noteId: "high", score: 0.9 })],
      "needle",
      "relevance",
    );

    expect(ranked.map((item) => item.noteId)).toEqual(["high", "low"]);
    expect(ranked.every((item) => item.rankingVersion === "relevance")).toBe(true);
  });
});
