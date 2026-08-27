import { and, desc, eq, isNull, lt, or, sql } from "drizzle-orm";
import { notes, searchDocuments, workspaceMembers, type Database } from "@glyphquire/database";
import { normalizeSearchText } from "./extract.js";
import type {
  DerivedSearchMissingTarget,
  DerivedSearchMutationPort,
  DerivedSearchMutationTarget,
  SearchPort,
  SearchQuery,
  SearchResult,
  SearchableNote,
} from "./types.js";

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

async function upsertSearchDocument(
  executor: Pick<Database, "insert">,
  note: SearchableNote,
): Promise<void> {
  const headingsText = note.headings.join(" ");
  const tagsText = note.tags.join(" ");

  await executor
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

/**
 * PostgreSQL-backed SearchPort. Indexing is a revision-gated upsert (a
 * stale-revision write is a silent no-op); removal is a plain delete
 * (idempotent — deleting an absent row is a no-op too). Search combines
 * English tsvector matching with pg_trgm similarity so CJK and fuzzy terms
 * that `to_tsvector('english', ...)` cannot tokenize still match via
 * trigram fallback. Every query scopes both `workspaceId` and current actor
 * membership in the result-selecting SQL statement. The separate derived-job
 * mutations lock the authoritative note row and apply their compare-and-write
 * in one transaction; ordinary SearchPort callers retain the original direct
 * index/remove semantics.
 */
export class PostgresSearchAdapter implements SearchPort, DerivedSearchMutationPort {
  constructor(private readonly db: Database) {}

  async indexNote(note: SearchableNote): Promise<void> {
    await upsertSearchDocument(this.db, note);
  }

  async removeNote(noteId: string): Promise<void> {
    await this.db.delete(searchDocuments).where(eq(searchDocuments.noteId, noteId));
  }

  async indexNoteIfCurrent(note: SearchableNote): Promise<void> {
    await this.db.transaction(async (transaction) => {
      const [source] = await transaction
        .select({
          noteId: notes.id,
          workspaceId: notes.workspaceId,
          revision: notes.revision,
          deletedAt: notes.deletedAt,
        })
        .from(notes)
        .where(eq(notes.id, note.noteId))
        .for("update")
        .limit(1);

      if (
        !source ||
        source.noteId !== note.noteId ||
        source.workspaceId !== note.workspaceId ||
        source.revision !== note.revision ||
        source.deletedAt !== null
      ) {
        return;
      }

      await upsertSearchDocument(transaction, note);
    });
  }

  async removeNoteIfCurrent(target: DerivedSearchMutationTarget): Promise<void> {
    await this.db.transaction(async (transaction) => {
      const [source] = await transaction
        .select({
          noteId: notes.id,
          workspaceId: notes.workspaceId,
          revision: notes.revision,
          deletedAt: notes.deletedAt,
        })
        .from(notes)
        .where(eq(notes.id, target.noteId))
        .for("update")
        .limit(1);

      if (
        source &&
        (source.noteId !== target.noteId ||
          source.workspaceId !== target.workspaceId ||
          source.revision !== target.revision ||
          source.deletedAt === null)
      ) {
        return;
      }

      await transaction
        .delete(searchDocuments)
        .where(
          and(
            eq(searchDocuments.noteId, target.noteId),
            eq(searchDocuments.workspaceId, target.workspaceId),
          ),
        );
    });
  }

  async removeNoteIfMissing(target: DerivedSearchMissingTarget): Promise<void> {
    await this.db.transaction(async (transaction) => {
      const [source] = await transaction
        .select({ noteId: notes.id })
        .from(notes)
        .where(eq(notes.id, target.noteId))
        .for("update")
        .limit(1);

      if (source) return;

      await transaction
        .delete(searchDocuments)
        .where(
          and(
            eq(searchDocuments.noteId, target.noteId),
            eq(searchDocuments.workspaceId, target.workspaceId),
          ),
        );
    });
  }

  async search(query: SearchQuery): Promise<SearchResult[]> {
    const normalizedQuery = normalizeSearchText(query.q);
    // Avoid `LIKE '%%'`, which would turn whitespace-only input into a
    // workspace-wide scan if a caller bypassed the HTTP schema boundary.
    if (normalizedQuery.length === 0) return [];

    // `LIKE` supplies exact substring matching for CJK/short terms. PostgreSQL's
    // `<%` word-similarity operator supplies indexed fuzzy-word matching
    // without comparing the query against the whole (usually much longer)
    // document as the `%` operator would.
    const likePattern = `%${normalizedQuery.replaceAll("%", "\\%").replaceAll("_", "\\_")}%`;
    const conditions = [
      eq(searchDocuments.workspaceId, query.workspaceId),
      or(
        sql`${searchDocuments.searchVector} @@ websearch_to_tsquery('english', ${query.q})`,
        sql`${searchDocuments.normalizedText} LIKE ${likePattern}`,
        sql`${normalizedQuery} <% ${searchDocuments.normalizedText}`,
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
        trgmScore: sql`word_similarity(${normalizedQuery}, ${searchDocuments.normalizedText})`,
      })
      .from(searchDocuments)
      // Defense in depth: a note's removal (search.remove) is at-least-once
      // and may lag its soft-delete by a beat, so the query itself excludes
      // deleted notes rather than relying solely on the async cleanup job.
      .innerJoin(notes, and(eq(notes.id, searchDocuments.noteId), isNull(notes.deletedAt)))
      // Authorization is part of the same SQL statement as result selection.
      // The service's pre-check supplies a uniform missing/unauthorized error;
      // this join closes the revocation race between that check and this read.
      .innerJoin(
        workspaceMembers,
        and(
          eq(workspaceMembers.workspaceId, searchDocuments.workspaceId),
          eq(workspaceMembers.userId, query.actorId),
        ),
      )
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
