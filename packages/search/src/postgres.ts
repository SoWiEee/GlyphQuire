import { and, desc, eq, isNull, lt, or, sql } from "drizzle-orm";
import { notes, searchDocuments, type Database } from "@glyphquire/database";
import { normalizeSearchText } from "./extract.js";
import type { SearchPort, SearchQuery, SearchResult, SearchableNote } from "./types.js";

const SNIPPET_MAX_LENGTH = 280;

function toSnippet(body: string): string {
  const trimmed = body.trim();
  if (trimmed.length <= SNIPPET_MAX_LENGTH) return trimmed;
  return `${trimmed.slice(0, SNIPPET_MAX_LENGTH).trimEnd()}…`;
}

function toScore(tsRank: unknown, similarity: unknown): number {
  const ts = typeof tsRank === "number" ? tsRank : Number(tsRank);
  const trgm = typeof similarity === "number" ? similarity : Number(similarity);
  return Math.max(Number.isFinite(ts) ? ts : 0, Number.isFinite(trgm) ? trgm : 0);
}

/**
 * PostgreSQL-backed SearchPort. Indexing is a revision-gated upsert (a
 * stale-revision write is a silent no-op); removal is a plain delete
 * (idempotent — deleting an absent row is a no-op too). Search combines
 * English tsvector matching with pg_trgm similarity so CJK and fuzzy terms
 * that `to_tsvector('english', ...)` cannot tokenize still match via
 * trigram fallback. Every query is scoped to `workspaceId` in the SQL
 * predicate itself, so a caller can never read another workspace's notes
 * regardless of what it passes.
 */
export class PostgresSearchAdapter implements SearchPort {
  constructor(private readonly db: Database) {}

  async indexNote(note: SearchableNote): Promise<void> {
    const headingsText = note.headings.join(" ");
    const tagsText = note.tags.join(" ");

    await this.db
      .insert(searchDocuments)
      .values({
        workspaceId: note.workspaceId,
        noteId: note.noteId,
        revision: note.revision,
        title: note.title,
        headings: headingsText,
        body: note.body,
        tags: tagsText,
        normalizedText: note.normalizedText,
      })
      .onConflictDoUpdate({
        target: searchDocuments.noteId,
        set: {
          workspaceId: note.workspaceId,
          revision: note.revision,
          title: note.title,
          headings: headingsText,
          body: note.body,
          tags: tagsText,
          normalizedText: note.normalizedText,
          updatedAt: new Date(),
        },
        setWhere: sql`${searchDocuments.revision} < ${note.revision}`,
      });
  }

  async removeNote(noteId: string): Promise<void> {
    await this.db.delete(searchDocuments).where(eq(searchDocuments.noteId, noteId));
  }

  async search(query: SearchQuery): Promise<SearchResult[]> {
    const normalizedQuery = normalizeSearchText(query.q);

    // `%` (pg_trgm's similarity operator) compares two strings as wholes,
    // which is the wrong shape for "does this note contain the query" —
    // it fails short/CJK queries embedded in longer normalized text. A
    // wildcard LIKE is a substring test that pg_trgm's GIN index still
    // accelerates, so it is the fuzzy/CJK fallback here; similarity() below
    // is used only for ranking, never for matching.
    const likePattern = `%${normalizedQuery.replaceAll("%", "\\%").replaceAll("_", "\\_")}%`;
    const conditions = [
      eq(searchDocuments.workspaceId, query.workspaceId),
      or(
        sql`${searchDocuments.searchVector} @@ websearch_to_tsquery('english', ${query.q})`,
        sql`${searchDocuments.normalizedText} LIKE ${likePattern}`,
      )!,
    ];

    if (query.cursor) {
      const cursorUpdatedAt = new Date(query.cursor.updatedAt);
      conditions.push(
        or(
          lt(searchDocuments.updatedAt, cursorUpdatedAt),
          and(
            eq(searchDocuments.updatedAt, cursorUpdatedAt),
            lt(searchDocuments.noteId, query.cursor.noteId),
          ),
        )!,
      );
    }

    const rows = await this.db
      .select({
        noteId: searchDocuments.noteId,
        workspaceId: searchDocuments.workspaceId,
        revision: searchDocuments.revision,
        title: searchDocuments.title,
        body: searchDocuments.body,
        updatedAt: searchDocuments.updatedAt,
        tsScore: sql`ts_rank_cd(${searchDocuments.searchVector}, websearch_to_tsquery('english', ${query.q}))`,
        trgmScore: sql`similarity(${searchDocuments.normalizedText}, ${normalizedQuery})`,
      })
      .from(searchDocuments)
      // Defense in depth: a note's removal (search.remove) is at-least-once
      // and may lag its soft-delete by a beat, so the query itself excludes
      // deleted notes rather than relying solely on the async cleanup job.
      .innerJoin(notes, and(eq(notes.id, searchDocuments.noteId), isNull(notes.deletedAt)))
      .where(and(...conditions))
      .orderBy(desc(searchDocuments.updatedAt), desc(searchDocuments.noteId))
      .limit(query.pageSize + 1);

    return rows.map((row) => ({
      noteId: row.noteId,
      workspaceId: row.workspaceId,
      revision: row.revision,
      title: row.title,
      snippet: toSnippet(row.body),
      score: toScore(row.tsScore, row.trgmScore),
      updatedAt: row.updatedAt.toISOString(),
    }));
  }
}
