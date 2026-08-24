import type { Database, DocumentJob } from "@glyphquire/database";

export type { DocumentJob };

/** Epoch-millisecond clock, injectable for deterministic tests. */
export type Clock = () => number;

export interface DispatchSummary {
  /** Rows atomically claimed (moved to `processing`) this batch. */
  readonly claimed: number;
  /** Claimed jobs whose handler resolved and were marked `completed`. */
  readonly succeeded: number;
  /** Claimed jobs whose handler threw and were rescheduled as `pending`. */
  readonly retried: number;
  /** Claimed jobs whose handler threw after exhausting retries. */
  readonly deadLettered: number;
}

/**
 * Claims and dispatches due `document_jobs` rows to a caller-supplied
 * handler, then records success, retry, or terminal dead-letter based on
 * the handler's outcome. `NoteWriter` only ever inserts a `pending` row in
 * the same transaction as the note mutation it derives from; everything
 * past that — claiming, retrying, dead-lettering — is this port's job.
 */
export interface DocumentJobDispatcher {
  dispatchBatch(handler: (job: DocumentJob) => Promise<void>): Promise<DispatchSummary>;
}

/**
 * Proves a job's captured revision is still the note's current revision
 * before a handler replaces any derived state (a search index, a rendered
 * cache, ...) for that job. A stale job — superseded by a later save,
 * checkpoint, or restore that already advanced the note's revision — must
 * never let out-of-order processing (e.g. after a crash and reclaim)
 * overwrite derived state with older content.
 */
export async function isCurrentRevision(
  db: Database,
  noteId: string,
  revision: number,
): Promise<boolean> {
  const row = await db.query.notes.findFirst({
    columns: { revision: true },
    where: (table, { eq: whereEq }) => whereEq(table.id, noteId),
  });
  return row !== undefined && row.revision === revision;
}
