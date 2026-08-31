import {
  canonicalUuidSchema,
  decodeCursor,
  encodeCursor,
  timestampSchema,
  type SearchQuery as SearchQueryContract,
  type SearchResponse,
  type SearchResult as SearchResultContract,
} from "@glyphquire/api-contract";
import {
  DEFAULT_SEARCH_RANKING,
  rankSearchResults,
  type SearchDocument,
  type RankedSearchResult,
  type SearchQueryPort,
  type SearchRanking,
} from "@glyphquire/search";
import { z } from "zod";
import { PublicApiError } from "../../middleware/error-handler.js";

const MAX_RANKING_CANDIDATES = 10_000;
const weightedCursorSchema = z
  .object({
    createdAt: timestampSchema,
    id: canonicalUuidSchema,
    score: z.number().finite().nonnegative(),
  })
  .strict();

type WeightedCursor = { updatedAt: string; noteId: string; score?: number };

function encodeWeightedCursor(value: WeightedCursor & { score: number }): string {
  const payload = JSON.stringify({
    createdAt: value.updatedAt,
    id: value.noteId,
    score: value.score,
  });
  let binary = "";
  for (const byte of new TextEncoder().encode(payload)) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function decodeWeightedCursor(value: string): WeightedCursor {
  const base64 = value.replaceAll("-", "+").replaceAll("_", "/");
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const binary = atob(base64 + padding);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  const decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const parsed = weightedCursorSchema.parse(JSON.parse(decoded));
  if (
    encodeWeightedCursor({
      updatedAt: parsed.createdAt,
      noteId: parsed.id,
      score: parsed.score,
    }) !== value
  ) {
    throw new Error("non-canonical weighted cursor");
  }
  return { updatedAt: parsed.createdAt, noteId: parsed.id, score: parsed.score };
}

function invalidCursor(): never {
  throw new PublicApiError("NOTE_NOT_FOUND", 404);
}

function unavailable(): never {
  throw new PublicApiError("SEARCH_UNAVAILABLE", 503);
}

function hydrateResult(row: RankedSearchResult & SearchDocument): SearchResultContract {
  return {
    noteId: row.noteId,
    workspaceId: row.workspaceId,
    revision: row.revision,
    title: row.title,
    snippet: row.snippet,
    score: row.score,
    rankingVersion: row.rankingVersion,
    updatedAt: row.updatedAt,
  };
}

function comesAfterWeightedCursor(
  row: SearchDocument & { score: number },
  cursor: WeightedCursor,
): boolean {
  if (cursor.score === undefined) return false;
  if (row.score !== cursor.score) return row.score < cursor.score;
  const rowTime = Date.parse(row.updatedAt);
  const cursorTime = Date.parse(cursor.updatedAt);
  if (rowTime !== cursorTime) return rowTime < cursorTime;
  return row.noteId > cursor.noteId;
}

/**
 * Owns the search read lifecycle after authorization: cursor decoding,
 * retrieval, pure ranking, pagination, response hydration, and public error
 * translation. The query port never knows about HTTP envelopes.
 */
export class SearchReadModule {
  constructor(private readonly queryPort: SearchQueryPort) {}

  async search(actorId: string, query: SearchQueryContract): Promise<SearchResponse> {
    const ranking: SearchRanking = query.ranking ?? DEFAULT_SEARCH_RANKING;
    let cursor: WeightedCursor | undefined;
    if (query.cursor) {
      try {
        if (ranking === "weighted-v1") {
          cursor = decodeWeightedCursor(query.cursor);
        } else {
          const decoded = decodeCursor(query.cursor);
          cursor = { updatedAt: decoded.createdAt, noteId: decoded.id };
        }
      } catch {
        // Keep malformed cursors indistinguishable from inaccessible content.
        invalidCursor();
      }
    }

    const rankingCursor = ranking === "weighted-v1" ? undefined : cursor;
    const upstreamPageSize =
      ranking === "weighted-v1"
        ? Math.max(query.pageSize + 1, MAX_RANKING_CANDIDATES)
        : query.pageSize;
    let documents;
    try {
      documents = await this.queryPort.search({
        actorId,
        workspaceId: query.workspaceId,
        q: query.q,
        cursor: rankingCursor,
        pageSize: upstreamPageSize,
      });
    } catch {
      unavailable();
    }

    const ranked = rankSearchResults(documents, query.q, ranking);
    const anchorIndex =
      ranking === "weighted-v1" && cursor
        ? ranked.findIndex(
            (row) => row.noteId === cursor.noteId && row.updatedAt === cursor.updatedAt,
          )
        : -1;
    // A row can disappear between requests. If the weighted cursor anchor is
    // gone, resume by the persisted rank plus stable identity so a result
    // already delivered on the prior page cannot be repeated or hide a lower-
    // ranked row that was never delivered.
    const afterCursor =
      ranking === "weighted-v1" && cursor
        ? anchorIndex >= 0
          ? ranked.slice(anchorIndex + 1)
          : ranked.filter((row) => comesAfterWeightedCursor(row, cursor))
        : ranked;
    const pageWithOverflow = afterCursor.slice(0, query.pageSize + 1);
    const hasMore = pageWithOverflow.length > query.pageSize;
    const page = hasMore ? pageWithOverflow.slice(0, query.pageSize) : pageWithOverflow;
    const last = page[page.length - 1];

    return {
      items: page.map(hydrateResult),
      nextCursor:
        hasMore && last
          ? ranking === "weighted-v1"
            ? encodeWeightedCursor({
                updatedAt: last.updatedAt,
                noteId: last.noteId,
                score: last.score,
              })
            : encodeCursor({ createdAt: last.updatedAt, id: last.noteId })
          : null,
    };
  }
}
