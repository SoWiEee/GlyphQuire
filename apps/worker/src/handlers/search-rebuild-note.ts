import { extractSearchableText, type DerivedSearchMutationPort } from "@glyphquire/search";
import type { JobEnvelope, SearchRebuildPayload } from "@glyphquire/api-contract/jobs";
import { notes, type Database } from "@glyphquire/database";
import type { JobHandler } from "@glyphquire/queue";
import { eq } from "drizzle-orm";

export interface SearchRebuildNoteRow {
  noteId: string;
  workspaceId: string;
  revision: number;
  title: string;
  contentMarkdown: string;
  deletedAt: Date | null;
}

/** Narrow repository seam so the handler is unit-testable without PostgreSQL. */
export interface SearchRebuildNoteRepository {
  loadNote(noteId: string): Promise<SearchRebuildNoteRow | undefined>;
}

export class PostgresSearchRebuildNoteRepository implements SearchRebuildNoteRepository {
  constructor(private readonly db: Database) {}

  async loadNote(noteId: string): Promise<SearchRebuildNoteRow | undefined> {
    const [row] = await this.db
      .select({
        noteId: notes.id,
        workspaceId: notes.workspaceId,
        revision: notes.revision,
        title: notes.title,
        contentMarkdown: notes.contentMarkdown,
        deletedAt: notes.deletedAt,
      })
      .from(notes)
      .where(eq(notes.id, noteId))
      .limit(1);
    return row;
  }
}

export interface SearchRebuildNoteHandlerDeps {
  repository: SearchRebuildNoteRepository;
  searchPort: DerivedSearchMutationPort;
}

/**
 * P0 handler for the `scope: "note"` branch of `search.rebuild`
 * (`noteId`, `batchSize: 1`, optional cursor — the cursor is unused by a
 * single-note rebuild and only meaningful once Task 7 extends this same
 * handler to scheduled `scope: "workspace"` scans). Re-extracts the note's
 * current Markdown and upserts it into the index; a missing or soft-deleted
 * note is treated as "should not be indexed" and removed instead, so the
 * handler stays correct even when the job races a delete. Both branches are
 * idempotent, matching the queue's at-least-once delivery.
 */
export function createSearchRebuildNoteHandler(
  deps: SearchRebuildNoteHandlerDeps,
): JobHandler<"search.rebuild"> {
  return async (job: JobEnvelope<"search.rebuild">) => {
    const payload: SearchRebuildPayload = job.payload;
    if (payload.scope !== "note") {
      // The workspace-scan branch is not registered until Task 7's scheduler handoff.
      throw new Error("JOB_INVALID: unsupported search.rebuild scope");
    }

    const note = await deps.repository.loadNote(payload.noteId);
    if (!note) {
      await deps.searchPort.removeNoteIfMissing({
        noteId: payload.noteId,
        workspaceId: payload.workspaceId,
      });
      return;
    }
    // A mismatched routing scope is invalid, not evidence that the note was
    // deleted. Never turn a forged/corrupt cross-workspace payload into an
    // unconditional removal by note id.
    if (note.workspaceId !== payload.workspaceId) {
      throw new Error("JOB_INVALID: search.rebuild workspace mismatch");
    }
    if (note.deletedAt !== null) {
      await deps.searchPort.removeNoteIfCurrent({
        noteId: note.noteId,
        workspaceId: note.workspaceId,
        revision: note.revision,
      });
      return;
    }

    const extracted = extractSearchableText(note.title, note.contentMarkdown);
    await deps.searchPort.indexNoteIfCurrent({
      noteId: note.noteId,
      workspaceId: note.workspaceId,
      revision: note.revision,
      title: extracted.title,
      headings: extracted.headings,
      body: extracted.body,
      tags: extracted.tags,
      normalizedText: extracted.normalizedText,
    });
  };
}
