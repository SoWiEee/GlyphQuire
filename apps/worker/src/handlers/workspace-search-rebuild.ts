import {
  decodeCursor,
  encodeCursor,
  jobPayloadSchemas,
  type JobEnvelope,
} from "@glyphquire/api-contract/jobs";
import { notes, type Database } from "@glyphquire/database";
import type { EnqueueJobInput, JobHandler } from "@glyphquire/queue";
import { extractSearchableText, type DerivedSearchMutationPort } from "@glyphquire/search";
import { and, asc, eq, gt, or } from "drizzle-orm";

export interface WorkspaceSearchRebuildRow {
  noteId: string;
  workspaceId: string;
  revision: number;
  title: string;
  contentMarkdown: string;
  deletedAt: Date | null;
  createdAt: Date;
}

export interface WorkspaceSearchRebuildRepository {
  listNotes(input: {
    workspaceId: string;
    cursor?: { createdAt: string; id: string };
    limit: number;
  }): Promise<WorkspaceSearchRebuildRow[]>;
}

export interface WorkspaceSearchRebuildDispatcher {
  enqueue(input: EnqueueJobInput<"search.rebuild">): Promise<{ id: string; duplicate: boolean }>;
}

export interface WorkspaceSearchRebuildHandlerDependencies {
  repository: WorkspaceSearchRebuildRepository;
  searchPort: DerivedSearchMutationPort;
  dispatcher: WorkspaceSearchRebuildDispatcher;
}

const selectedNote = {
  noteId: notes.id,
  workspaceId: notes.workspaceId,
  revision: notes.revision,
  title: notes.title,
  contentMarkdown: notes.contentMarkdown,
  deletedAt: notes.deletedAt,
  createdAt: notes.createdAt,
};

export class PostgresWorkspaceSearchRebuildRepository implements WorkspaceSearchRebuildRepository {
  constructor(private readonly db: Database) {}

  async listNotes(input: {
    workspaceId: string;
    cursor?: { createdAt: string; id: string };
    limit: number;
  }): Promise<WorkspaceSearchRebuildRow[]> {
    const cursorCondition = input.cursor
      ? or(
          gt(notes.createdAt, new Date(input.cursor.createdAt)),
          and(eq(notes.createdAt, new Date(input.cursor.createdAt)), gt(notes.id, input.cursor.id)),
        )
      : undefined;
    return this.db
      .select(selectedNote)
      .from(notes)
      .where(and(eq(notes.workspaceId, input.workspaceId), cursorCondition))
      .orderBy(asc(notes.createdAt), asc(notes.id))
      .limit(input.limit);
  }
}

function checkAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new Error("JOB_FAILED");
}

async function scrubbed<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("JOB_INVALID")) throw error;
    throw new Error("JOB_FAILED");
  }
}

export function createWorkspaceSearchRebuildHandler(
  dependencies: WorkspaceSearchRebuildHandlerDependencies,
): JobHandler<"search.rebuild"> {
  return async (job: JobEnvelope<"search.rebuild">, signal: AbortSignal) => {
    checkAborted(signal);
    const parsed = jobPayloadSchemas["search.rebuild"].safeParse(job.payload);
    if (
      !parsed.success ||
      parsed.data.scope !== "workspace" ||
      job.workspaceId !== parsed.data.workspaceId
    ) {
      throw new Error("JOB_INVALID: invalid workspace search.rebuild payload");
    }
    const payload = parsed.data;
    let cursor: { createdAt: string; id: string } | undefined;
    if (payload.cursor) {
      try {
        cursor = decodeCursor(payload.cursor);
      } catch {
        throw new Error("JOB_INVALID: invalid search.rebuild cursor");
      }
    }

    const rows = await scrubbed(() =>
      dependencies.repository.listNotes({
        workspaceId: payload.workspaceId,
        cursor,
        limit: payload.batchSize,
      }),
    );
    for (const row of rows) {
      checkAborted(signal);
      if (row.workspaceId !== payload.workspaceId) {
        throw new Error("JOB_INVALID: search.rebuild scan source mismatch");
      }
      if (row.deletedAt !== null) {
        await scrubbed(() =>
          dependencies.searchPort.removeNoteIfCurrent({
            noteId: row.noteId,
            workspaceId: row.workspaceId,
            revision: row.revision,
          }),
        );
        continue;
      }
      const extracted = extractSearchableText(row.title, row.contentMarkdown);
      await scrubbed(() =>
        dependencies.searchPort.indexNoteIfCurrent({
          noteId: row.noteId,
          workspaceId: row.workspaceId,
          revision: row.revision,
          title: extracted.title,
          headings: extracted.headings,
          body: extracted.body,
          tags: extracted.tags,
          normalizedText: extracted.normalizedText,
        }),
      );
    }

    if (rows.length === payload.batchSize) {
      const last = rows[rows.length - 1]!;
      const nextCursor = encodeCursor({
        createdAt: last.createdAt.toISOString(),
        id: last.noteId,
      });
      await scrubbed(() =>
        dependencies.dispatcher.enqueue({
          workspaceId: payload.workspaceId,
          type: "search.rebuild",
          payload: {
            workspaceId: payload.workspaceId,
            scope: "workspace",
            batchSize: payload.batchSize,
            cursor: nextCursor,
          },
          idempotencyKey: `search-rebuild-workspace-${payload.workspaceId}-${last.createdAt.getTime()}-${last.noteId}`,
        }),
      );
    }
  };
}
