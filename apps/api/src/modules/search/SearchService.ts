import { notes, workspaceMembers, type Database } from "@glyphquire/database";
import type { JobDispatcher } from "@glyphquire/queue";
import type { SearchRebuildPayload } from "@glyphquire/api-contract/jobs";
import {
  decodeCursor,
  encodeCursor,
  type SearchQuery as SearchQueryContract,
  type SearchResponse,
} from "@glyphquire/api-contract";
import type { SearchPort, SearchResult } from "@glyphquire/search";
import { and, eq } from "drizzle-orm";
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

    let cursor: { updatedAt: string; noteId: string } | undefined;
    if (query.cursor) {
      try {
        const decoded = decodeCursor(query.cursor);
        cursor = { updatedAt: decoded.createdAt, noteId: decoded.id };
      } catch {
        notFound(); // Treat a malformed cursor as a request for content this actor cannot see.
      }
    }

    let rows: SearchResult[];
    try {
      rows = await this.searchPort.search({
        actorId,
        workspaceId: query.workspaceId,
        q: query.q,
        cursor,
        pageSize: query.pageSize,
      });
    } catch {
      unavailable();
    }

    const hasMore = rows.length > query.pageSize;
    const page = hasMore ? rows.slice(0, query.pageSize) : rows;
    const last = page[page.length - 1];

    return {
      items: page.map((row) => ({
        noteId: row.noteId,
        workspaceId: row.workspaceId,
        revision: row.revision,
        title: row.title,
        snippet: row.snippet,
        score: row.score,
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
