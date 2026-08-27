import type { JobEnvelope, SearchRemovePayload } from "@glyphquire/api-contract/jobs";
import { notes, type Database } from "@glyphquire/database";
import type { JobHandler } from "@glyphquire/queue";
import type { SearchPort } from "@glyphquire/search";
import { eq } from "drizzle-orm";

export interface SearchRemoveNoteRow {
  noteId: string;
  workspaceId: string;
  revision: number;
  deletedAt: Date | null;
}

export interface SearchRemoveRepository {
  loadNote(noteId: string): Promise<SearchRemoveNoteRow | undefined>;
}

export class PostgresSearchRemoveRepository implements SearchRemoveRepository {
  constructor(private readonly db: Database) {}

  async loadNote(noteId: string): Promise<SearchRemoveNoteRow | undefined> {
    const [row] = await this.db
      .select({
        noteId: notes.id,
        workspaceId: notes.workspaceId,
        revision: notes.revision,
        deletedAt: notes.deletedAt,
      })
      .from(notes)
      .where(eq(notes.id, noteId))
      .limit(1);
    return row;
  }
}

export interface SearchRemoveHandlerDeps {
  repository: SearchRemoveRepository;
  searchPort: SearchPort;
}

export function createSearchRemoveHandler(
  deps: SearchRemoveHandlerDeps,
): JobHandler<"search.remove"> {
  return async (job: JobEnvelope<"search.remove">) => {
    const payload: SearchRemovePayload = job.payload;
    let note: SearchRemoveNoteRow | undefined;
    try {
      note = await deps.repository.loadNote(payload.noteId);
    } catch {
      throw new Error("JOB_FAILED");
    }

    if (note) {
      if (note.noteId !== payload.noteId || note.workspaceId !== payload.workspaceId) {
        throw new Error("JOB_INVALID: search.remove source mismatch");
      }
      if (note.revision !== payload.revision || note.deletedAt === null) return;
    }

    try {
      await deps.searchPort.removeNote(payload.noteId);
    } catch {
      throw new Error("JOB_FAILED");
    }
  };
}
