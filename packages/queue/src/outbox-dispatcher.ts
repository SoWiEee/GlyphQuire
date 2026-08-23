import { randomUUID } from "node:crypto";
import { documentJobs, type Database, type DocumentJob } from "@glyphquire/database";
import { and, eq, sql } from "drizzle-orm";
import type { Clock, DispatchSummary, DocumentJobDispatcher } from "./document-jobs.js";

const DEFAULT_BATCH_SIZE = 10;
const DEFAULT_LOCK_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_BASE_DELAY_MS = 1000;
const DEFAULT_MAX_DELAY_MS = 5 * 60 * 1000;
const MAX_ERROR_MESSAGE_LENGTH = 4000;

function defaultBackoffMs(attempt: number): number {
  const exponential = DEFAULT_BASE_DELAY_MS * 2 ** Math.max(0, attempt - 1);
  return Math.min(exponential, DEFAULT_MAX_DELAY_MS);
}

export interface PostgresDocumentJobDispatcherOptions {
  /** Identity recorded in `locked_by`. Defaults to a fresh UUID per instance. */
  dispatcherId?: string;
  /** Maximum rows claimed per `dispatchBatch` call. */
  batchSize?: number;
  /** A `processing` row whose lock is older than this is treated as crashed and reclaimed. */
  lockTimeoutMs?: number;
  /** Attempts (inclusive) after which a failing job is dead-lettered instead of retried. */
  maxAttempts?: number;
  /** Delay before a failed job becomes claimable again, given its attempt count so far. */
  backoffMs?: (attempt: number) => number;
  clock?: Clock;
}

function errorMessageOf(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, MAX_ERROR_MESSAGE_LENGTH);
}

/**
 * Postgres-backed `DocumentJobDispatcher`. Claiming is a single atomic
 * `UPDATE ... FROM (SELECT ... FOR UPDATE SKIP LOCKED)` statement: concurrent
 * dispatchers never claim the same row (`SKIP LOCKED`), a `processing` row
 * past `lockTimeoutMs` is claimable again (crash/reclaim), and the DB's own
 * `document_jobs` status-transition trigger is the final authority on which
 * transitions are legal — this adapter never attempts one the trigger
 * forbids (no delete, no touching a terminal row, no decreasing `attempts`).
 */
export class PostgresDocumentJobDispatcher implements DocumentJobDispatcher {
  private readonly dispatcherId: string;
  private readonly batchSize: number;
  private readonly lockTimeoutMs: number;
  private readonly maxAttempts: number;
  private readonly backoffMs: (attempt: number) => number;
  private readonly clock: Clock;

  constructor(
    private readonly db: Database,
    options: PostgresDocumentJobDispatcherOptions = {},
  ) {
    this.dispatcherId = options.dispatcherId ?? randomUUID();
    this.batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
    this.lockTimeoutMs = options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
    this.maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    this.backoffMs = options.backoffMs ?? defaultBackoffMs;
    this.clock = options.clock ?? Date.now;
  }

  async dispatchBatch(handler: (job: DocumentJob) => Promise<void>): Promise<DispatchSummary> {
    const claimed = await this.claimBatch();

    let succeeded = 0;
    let retried = 0;
    let deadLettered = 0;

    for (const job of claimed) {
      try {
        await handler(job);
        await this.markCompleted(job);
        succeeded += 1;
      } catch (error) {
        const message = errorMessageOf(error);
        if (job.attempts >= this.maxAttempts) {
          await this.markDeadLetter(job, message);
          deadLettered += 1;
        } else {
          await this.markRetry(job, message);
          retried += 1;
        }
      }
    }

    return { claimed: claimed.length, succeeded, retried, deadLettered };
  }

  private async claimBatch(): Promise<DocumentJob[]> {
    const result = await this.db.execute<DocumentJob>(sql`
      WITH due AS (
        SELECT id
        FROM document_jobs
        WHERE available_at <= now()
          AND (
            status = 'pending'
            OR (status = 'processing' AND locked_at < now() - (${this.lockTimeoutMs}::int * interval '1 millisecond'))
          )
        ORDER BY available_at, created_at, id
        LIMIT ${this.batchSize}
        FOR UPDATE SKIP LOCKED
      )
      UPDATE document_jobs AS dj
      SET status = 'processing', attempts = dj.attempts + 1, locked_at = now(), locked_by = ${this.dispatcherId}
      FROM due
      WHERE dj.id = due.id
      RETURNING
        dj.id AS "id",
        dj.workspace_id AS "workspaceId",
        dj.note_id AS "noteId",
        dj.note_operation_id AS "noteOperationId",
        dj.operation_id AS "operationId",
        dj.revision AS "revision",
        dj.kind AS "kind",
        dj.status AS "status",
        dj.attempts AS "attempts",
        dj.available_at AS "availableAt",
        dj.locked_at AS "lockedAt",
        dj.locked_by AS "lockedBy",
        dj.completed_at AS "completedAt",
        dj.dead_lettered_at AS "deadLetteredAt",
        dj.last_error AS "lastError",
        dj.created_at AS "createdAt",
        dj.updated_at AS "updatedAt"
    `);
    return Array.from(result);
  }

  /** Only this dispatcher's own currently-held lock on the row may transition it. */
  private ownedProcessingRow(jobId: string) {
    return and(
      eq(documentJobs.id, jobId),
      eq(documentJobs.status, "processing"),
      eq(documentJobs.lockedBy, this.dispatcherId),
    );
  }

  private async markCompleted(job: DocumentJob): Promise<void> {
    await this.db
      .update(documentJobs)
      .set({ status: "completed", lockedAt: null, lockedBy: null, completedAt: new Date(this.clock()) })
      .where(this.ownedProcessingRow(job.id));
  }

  private async markRetry(job: DocumentJob, message: string): Promise<void> {
    const delayMs = this.backoffMs(job.attempts);
    await this.db
      .update(documentJobs)
      .set({
        status: "pending",
        lockedAt: null,
        lockedBy: null,
        availableAt: new Date(this.clock() + delayMs),
        lastError: message,
      })
      .where(this.ownedProcessingRow(job.id));
  }

  private async markDeadLetter(job: DocumentJob, message: string): Promise<void> {
    await this.db
      .update(documentJobs)
      .set({
        status: "dead_letter",
        lockedAt: null,
        lockedBy: null,
        deadLetteredAt: new Date(this.clock()),
        lastError: message,
      })
      .where(this.ownedProcessingRow(job.id));
  }
}
