import type { JobEnvelope, SearchIndexPayload } from "@glyphquire/api-contract/jobs";
import { notes, type Database } from "@glyphquire/database";
import type { JobHandler } from "@glyphquire/queue";
import { extractSearchableText, type SearchPort } from "@glyphquire/search";
import { eq } from "drizzle-orm";

export interface SearchIndexNoteRow {
  noteId: string;
  workspaceId: string;
  revision: number;
  title: string;
  contentMarkdown: string;
  deletedAt: Date | null;
}

export interface SearchIndexRepository {
  loadNote(noteId: string): Promise<SearchIndexNoteRow | undefined>;
}

export class PostgresSearchIndexRepository implements SearchIndexRepository {
  constructor(private readonly db: Database) {}

  async loadNote(noteId: string): Promise<SearchIndexNoteRow | undefined> {
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

export interface SearchIndexHandlerDeps {
  repository: SearchIndexRepository;
  searchPort: SearchPort;
}

export function createSearchIndexHandler(deps: SearchIndexHandlerDeps): JobHandler<"search.index"> {
  return async (job: JobEnvelope<"search.index">) => {
    const payload: SearchIndexPayload = job.payload;
    let note: SearchIndexNoteRow | undefined;
    try {
      note = await deps.repository.loadNote(payload.noteId);
    } catch {
      throw new Error("JOB_FAILED");
    }

    if (!note) {
      try {
        await deps.searchPort.removeNote(payload.noteId);
      } catch {
        throw new Error("JOB_FAILED");
      }
      return;
    }
    if (note.noteId !== payload.noteId || note.workspaceId !== payload.workspaceId) {
      throw new Error("JOB_INVALID: search.index source mismatch");
    }
    if (note.revision !== payload.revision) return;

    try {
      if (note.deletedAt !== null) {
        await deps.searchPort.removeNote(note.noteId);
        return;
      }

      const extracted = extractSearchableText(note.title, note.contentMarkdown);
      await deps.searchPort.indexNote({
        noteId: note.noteId,
        workspaceId: note.workspaceId,
        revision: note.revision,
        title: extracted.title,
        headings: extracted.headings,
        body: extracted.body,
        tags: extracted.tags,
        normalizedText: extracted.normalizedText,
      });
    } catch {
      throw new Error("JOB_FAILED");
    }
  };
}
