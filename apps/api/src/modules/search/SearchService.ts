import { notes, searchDocuments, workspaceMembers, type Database } from "@glyphquire/database";
import type { JobDispatcher } from "@glyphquire/queue";
import type { SearchRebuildPayload } from "@glyphquire/api-contract/jobs";
import {
  decodeCursor,
  encodeCursor,
  type SearchRanking,
  type SearchQuery as SearchQueryContract,
  type SearchResponse,
} from "@glyphquire/api-contract";
import { normalizeSearchText, type SearchPort, type SearchResult } from "@glyphquire/search";
import { and, eq, inArray } from "drizzle-orm";
import { PublicApiError } from "../../middleware/error-handler.js";
import type { OperatorAuthorizer } from "./OperatorAuthorizer.js";

function notFound(): never {
  throw new PublicApiError("NOTE_NOT_FOUND", 404);
}

function unavailable(): never {
  throw new PublicApiError("SEARCH_UNAVAILABLE", 503);
}

export type SearchRebuildNoteInput = Extract<SearchRebuildPayload, { scope: "note" }>;

export interface SearchService {
  search(actorId: string, query: SearchQueryContract): Promise<SearchResponse>;
  rebuildNote(actorId: string, input: SearchRebuildNoteInput): Promise<{ enqueued: boolean }>;
}

type SearchFields = Pick<SearchResult, "title" | "snippet"> & {
  tags: string;
  headings: string;
  body: string;
};

type SearchRankingRow = SearchResult & SearchFields;

const SEARCH_RANKING_WEIGHTS = [
  ["title", 8],
  ["tags", 6],
  ["headings", 4],
  ["body", 1],
] as const satisfies readonly (readonly [keyof SearchFields, number])[];

function trigramSet(value: string): Set<string> {
  const padded = `  ${value} `;
  const result = new Set<string>();
  for (let index = 0; index + 3 <= padded.length; index += 1) {
    result.add(padded.slice(index, index + 3));
  }
  return result;
}

function trigramSimilarity(left: string, right: string): number {
  if (left === right) return 1;
  if (left.length < 3 || right.length < 3) return 0;

  const leftTrigrams = trigramSet(left);
  const rightTrigrams = trigramSet(right);
  let shared = 0;
  for (const trigram of leftTrigrams) {
    if (rightTrigrams.has(trigram)) shared += 1;
  }
  return (2 * shared) / (leftTrigrams.size + rightTrigrams.size);
}

function matchesSearchTerm(value: string, term: string): boolean {
  const normalizedValue = normalizeSearchText(value);
  if (normalizedValue.includes(term)) return true;
  return normalizedValue
    .split(" ")
    .filter(Boolean)
    .some((word) => trigramSimilarity(term, word) >= 0.5);
}

function weightedScore(row: SearchFields, query: string): number {
  const terms = [...new Set(normalizeSearchText(query).split(" ").filter(Boolean))];
  if (terms.length === 0) return 0;

  return SEARCH_RANKING_WEIGHTS.reduce(
    (score, [field, weight]) =>
      score + (terms.some((term) => matchesSearchTerm(row[field], term)) ? weight : 0),
    0,
  );
}

function compareWeightedRows(left: SearchRankingRow, right: SearchRankingRow): number {
  if (left.score !== right.score) return right.score - left.score;
  const leftTime = Date.parse(left.updatedAt);
  const rightTime = Date.parse(right.updatedAt);
  if (Number.isFinite(leftTime) && Number.isFinite(rightTime) && leftTime !== rightTime) {
    return rightTime - leftTime;
  }
  if (left.updatedAt !== right.updatedAt) return right.updatedAt < left.updatedAt ? -1 : 1;
  if (left.noteId === right.noteId) return 0;
  return left.noteId < right.noteId ? -1 : 1;
}

function applyRanking(
  rows: readonly SearchRankingRow[],
  query: string,
  ranking: SearchRanking,
): Array<SearchResult & { rankingVersion: SearchRanking }> {
  const ranked = rows.map((row) => ({
    ...row,
    score: ranking === "weighted-v1" ? weightedScore(row, query) : row.score,
    rankingVersion: ranking,
  }));
  if (ranking === "weighted-v1") ranked.sort(compareWeightedRows);
  return ranked;
}

export class SearchServiceImpl implements SearchService {
  constructor(
    private readonly db: Database,
    private readonly searchPort: SearchPort,
    private readonly dispatcher: JobDispatcher,
    private readonly operatorAuthorizer: OperatorAuthorizer,
  ) {}

  private async requireMembership(actorId: string, workspaceId: string): Promise<void> {
    const [member] = await this.db
      .select({ role: workspaceMembers.role })
      .from(workspaceMembers)
      .where(
        and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, actorId)),
      )
      .limit(1);
    if (!member) notFound();
  }

  async search(actorId: string, query: SearchQueryContract): Promise<SearchResponse> {
    await this.requireMembership(actorId, query.workspaceId);

    const ranking = query.ranking ?? "relevance";

    let cursor: { updatedAt: string; noteId: string } | undefined;
    if (query.cursor) {
      try {
        const decoded = decodeCursor(query.cursor);
        cursor = { updatedAt: decoded.createdAt, noteId: decoded.id };
      } catch {
        notFound(); // Treat a malformed cursor as a request for content this actor cannot see.
      }
    }

    let rows: SearchRankingRow[];
    try {
      const portQuery = {
        actorId,
        workspaceId: query.workspaceId,
        q: query.q,
        cursor,
        pageSize: query.pageSize,
        ranking,
      } as Parameters<SearchPort["search"]>[0] & { ranking: SearchRanking };
      const searchRows = await this.searchPort.search(portQuery);

      if (ranking === "weighted-v1" && searchRows.length > 0) {
        const details = await this.db
          .select({
            noteId: searchDocuments.noteId,
            title: searchDocuments.title,
            headings: searchDocuments.headings,
            tags: searchDocuments.tags,
            body: searchDocuments.body,
          })
          .from(searchDocuments)
          .where(
            and(
              eq(searchDocuments.workspaceId, query.workspaceId),
              inArray(
                searchDocuments.noteId,
                searchRows.map((row) => row.noteId),
              ),
            ),
          );
        const detailsByNoteId = new Map(details.map((detail) => [detail.noteId, detail]));
        rows = searchRows.map((row) => {
          const detail = detailsByNoteId.get(row.noteId);
          return {
            ...row,
            title: detail?.title ?? row.title,
            headings: detail?.headings ?? "",
            tags: detail?.tags ?? "",
            body: detail?.body ?? row.snippet,
          };
        });
      } else {
        rows = searchRows.map((row) => ({
          ...row,
          headings: "",
          tags: "",
          body: row.snippet,
        }));
      }
    } catch {
      unavailable();
    }

    const rankedRows = applyRanking(rows, query.q, ranking);

    const hasMore = rankedRows.length > query.pageSize;
    const page = hasMore ? rankedRows.slice(0, query.pageSize) : rankedRows;
    const last = page[page.length - 1];

    return {
      items: page.map((row) => ({
        noteId: row.noteId,
        workspaceId: row.workspaceId,
        revision: row.revision,
        title: row.title,
        snippet: row.snippet,
        score: row.score,
        rankingVersion: row.rankingVersion,
        updatedAt: row.updatedAt,
      })),
      nextCursor:
        hasMore && last ? encodeCursor({ createdAt: last.updatedAt, id: last.noteId }) : null,
    };
  }

  async rebuildNote(
    actorId: string,
    input: SearchRebuildNoteInput,
  ): Promise<{ enqueued: boolean }> {
    this.operatorAuthorizer.authorize(actorId);

    const [note] = await this.db
      .select({ id: notes.id })
      .from(notes)
      .where(and(eq(notes.id, input.noteId), eq(notes.workspaceId, input.workspaceId)))
      .limit(1);
    if (!note) notFound();

    await this.dispatcher.enqueue({
      workspaceId: input.workspaceId,
      type: "search.rebuild",
      payload: input,
    });
    return { enqueued: true };
  }
}
