import { randomUUID } from "node:crypto";
import {
  JOB_TYPES,
  P0_JOB_TYPES,
  P1_JOB_TYPES,
  idempotencyKeySchema,
  jobEnvelopeSchema,
  type JobEnvelope,
  type JobPayload,
  type JobType,
} from "@glyphquire/api-contract/jobs";
import { jobs, type Database, type JobStatus } from "@glyphquire/database";
import { and, eq, isNull, sql } from "drizzle-orm";
import type { DispatchSummary } from "./document-jobs.js";

export { P0_JOB_TYPES, P1_JOB_TYPES };

export type JobHandler<TType extends JobType> = (
  job: JobEnvelope<TType>,
  signal: AbortSignal,
) => Promise<void>;

export type JobRegistry = { [K in JobType]?: JobHandler<K> };

export interface EnqueueJobInput<TType extends JobType> {
  workspaceId: string | null;
  type: TType;
  payload: JobEnvelope<TType>["payload"];
  idempotencyKey?: string;
  runAt?: Date;
  maxAttempts?: number;
}

export interface JobDispatcher {
  enqueue<TType extends JobType>(
    input: EnqueueJobInput<TType>,
  ): Promise<{ id: string; duplicate: boolean }>;
  dispatchBatch(handlers: JobRegistry, signal?: AbortSignal): Promise<DispatchSummary>;
}

export interface JobRegistryDiagnostic {
  complete: boolean;
  missing: JobType[];
}

function validateRegistryKeys(registry: JobRegistry): void {
  const prototype = Object.getPrototypeOf(registry);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error("Job registry must be a plain static object");
  }
  const recognized = new Set<string>(JOB_TYPES);
  const unrecognized = Object.keys(registry).filter((key) => !recognized.has(key));
  if (unrecognized.length > 0) {
    throw new Error(`Unrecognized job handler keys: ${unrecognized.sort().join(", ")}`);
  }
  const invalidHandlers = Object.entries(registry)
    .filter(([, value]) => value !== undefined && typeof value !== "function")
    .map(([key]) => key)
    .sort();
  if (invalidHandlers.length > 0) {
    throw new Error(`Invalid job handler values: ${invalidHandlers.join(", ")}`);
  }
}

export function assertRegistryComplete(
  registry: JobRegistry,
  requiredTypes: readonly JobType[] = P0_JOB_TYPES,
): void {
  validateRegistryKeys(registry);
  const recognized = new Set<string>(JOB_TYPES);
  const seen = new Set<string>();
  for (const type of requiredTypes) {
    if (!recognized.has(type) || seen.has(type)) {
      throw new Error(`Invalid required job type list: ${type}`);
    }
    seen.add(type);
  }
  const missing = requiredTypes.filter((type) => typeof registry[type] !== "function");
  if (missing.length > 0) {
    throw new Error(`Missing required job handlers: ${missing.join(", ")}`);
  }
}

export function assertRequiredJobsComplete(registry: JobRegistry): JobRegistryDiagnostic {
  validateRegistryKeys(registry);
  const missing = P1_JOB_TYPES.filter((type) => typeof registry[type] !== "function");
  return { complete: missing.length === 0, missing: [...missing] };
}

export async function dispatchValidatedJob(
  value: unknown,
  registry: JobRegistry,
  signal: AbortSignal,
): Promise<void> {
  validateRegistryKeys(registry);
  const result = jobEnvelopeSchema.safeParse(value);
  if (!result.success) throw new Error("JOB_INVALID: invalid job envelope");
  const job = result.data as JobEnvelope;
  const handler = registry[job.type] as JobHandler<JobType> | undefined;
  if (!handler) throw new Error(`JOB_INVALID: unregistered job type ${job.type}`);
  await handler(job, signal);
}

export interface StoredJob extends Record<string, unknown> {
  id: string;
  workspaceId: string | null;
  type: string;
  version: number;
  payload: Record<string, unknown>;
  status: JobStatus;
  attempts: number;
  maxAttempts: number;
  availableAt: Date;
  lockedAt: Date | null;
  lockedBy: string | null;
  completedAt: Date | null;
  deadLetteredAt: Date | null;
  idempotencyKey: string | null;
  lastError: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface PersistJobInput {
  workspaceId: string | null;
  type: JobType;
  version: 1;
  payload: Record<string, unknown>;
  idempotencyKey: string | null;
  availableAt: Date;
  maxAttempts: number;
}

export interface ClaimJobsInput {
  dispatcherId: string;
  batchSize: number;
  now: Date;
  lockBefore: Date;
}

export interface CompleteJobInput {
  jobId: string;
  dispatcherId: string;
  claimGeneration: number;
  now: Date;
}

export interface RetryJobInput extends CompleteJobInput {
  availableAt: Date;
  lastError: string;
}

export interface DeadLetterJobInput extends CompleteJobInput {
  lastError: string;
}

export interface JobStore {
  enqueue(input: PersistJobInput): Promise<{ id: string; duplicate: boolean }>;
  claimBatch(input: ClaimJobsInput): Promise<StoredJob[]>;
  markCompleted(input: CompleteJobInput): Promise<boolean>;
  markRetry(input: RetryJobInput): Promise<boolean>;
  markDeadLetter(input: DeadLetterJobInput): Promise<boolean>;
}

/**
 * Database operations used by the PostgreSQL job store. Both the top-level
 * Drizzle database and a transaction callback implement this surface, so a
 * dispatcher can validate and persist an enqueue inside its caller's
 * transaction without exposing transaction lifecycle controls.
 */
export type JobDatabaseExecutor = Pick<Database, "execute" | "insert" | "select" | "update">;

/**
 * Binds enqueue persistence to a caller-owned Drizzle transaction. Services
 * that mutate source rows and emit generic jobs use this capability to fail
 * closed instead of silently falling back to a post-commit enqueue.
 */
export interface TransactionalJobDispatcher extends JobDispatcher {
  withDatabaseExecutor(executor: JobDatabaseExecutor): JobDispatcher;
}

class PostgresJobStore implements JobStore {
  constructor(private readonly db: JobDatabaseExecutor) {}

  async enqueue(input: PersistJobInput): Promise<{ id: string; duplicate: boolean }> {
    const inserted = await this.db
      .insert(jobs)
      .values({
        workspaceId: input.workspaceId,
        type: input.type,
        version: input.version,
        payload: input.payload,
        idempotencyKey: input.idempotencyKey,
        availableAt: input.availableAt,
        maxAttempts: input.maxAttempts,
      })
      .onConflictDoNothing()
      .returning({ id: jobs.id });
    if (inserted[0]) return { id: inserted[0].id, duplicate: false };
    if (input.idempotencyKey === null) throw new Error("JOB_FAILED: job insert was rejected");

    const workspacePredicate =
      input.workspaceId === null
        ? isNull(jobs.workspaceId)
        : eq(jobs.workspaceId, input.workspaceId);
    const existing = await this.db
      .select({ id: jobs.id })
      .from(jobs)
      .where(
        and(
          workspacePredicate,
          eq(jobs.type, input.type),
          eq(jobs.idempotencyKey, input.idempotencyKey),
        ),
      )
      .limit(1);
    if (!existing[0]) throw new Error("JOB_FAILED: idempotent job insert was rejected");
    return { id: existing[0].id, duplicate: true };
  }

  async claimBatch(input: ClaimJobsInput): Promise<StoredJob[]> {
    const now = input.now.toISOString();
    const lockBefore = input.lockBefore.toISOString();
    const result = await this.db.execute<StoredJob>(sql`
      WITH due AS (
        SELECT id
        FROM jobs
        WHERE available_at <= ${now}
          AND (
            status = 'pending'
            OR (status = 'processing' AND locked_at < ${lockBefore})
          )
        ORDER BY available_at, created_at, id
        LIMIT ${input.batchSize}
        FOR UPDATE SKIP LOCKED
      )
      UPDATE jobs AS queued
      SET
        status = 'processing',
        attempts = queued.attempts + 1,
        locked_at = ${now},
        locked_by = ${input.dispatcherId},
        updated_at = ${now}
      FROM due
      WHERE queued.id = due.id
      RETURNING
        queued.id AS "id",
        queued.workspace_id AS "workspaceId",
        queued.type AS "type",
        queued.version AS "version",
        queued.payload AS "payload",
        queued.status AS "status",
        queued.attempts AS "attempts",
        queued.max_attempts AS "maxAttempts",
        queued.available_at AS "availableAt",
        queued.locked_at AS "lockedAt",
        queued.locked_by AS "lockedBy",
        queued.completed_at AS "completedAt",
        queued.dead_lettered_at AS "deadLetteredAt",
        queued.idempotency_key AS "idempotencyKey",
        queued.last_error AS "lastError",
        queued.created_at AS "createdAt",
        queued.updated_at AS "updatedAt"
    `);
    return Array.from(result);
  }

  private owned(input: CompleteJobInput) {
    return and(
      eq(jobs.id, input.jobId),
      eq(jobs.status, "processing"),
      eq(jobs.lockedBy, input.dispatcherId),
      eq(jobs.attempts, input.claimGeneration),
    );
  }

  async markCompleted(input: CompleteJobInput): Promise<boolean> {
    const result = await this.db
      .update(jobs)
      .set({
        status: "completed",
        lockedAt: null,
        lockedBy: null,
        completedAt: input.now,
        lastError: null,
        updatedAt: input.now,
      })
      .where(this.owned(input))
      .returning({ id: jobs.id });
    return result.length === 1;
  }

  async markRetry(input: RetryJobInput): Promise<boolean> {
    const result = await this.db
      .update(jobs)
      .set({
        status: "pending",
        lockedAt: null,
        lockedBy: null,
        availableAt: input.availableAt,
        lastError: input.lastError.slice(0, 4000),
        updatedAt: input.now,
      })
      .where(this.owned(input))
      .returning({ id: jobs.id });
    return result.length === 1;
  }

  async markDeadLetter(input: DeadLetterJobInput): Promise<boolean> {
    const result = await this.db
      .update(jobs)
      .set({
        status: "dead_letter",
        lockedAt: null,
        lockedBy: null,
        deadLetteredAt: input.now,
        lastError: input.lastError.slice(0, 4000),
        updatedAt: input.now,
      })
      .where(this.owned(input))
      .returning({ id: jobs.id });
    return result.length === 1;
  }
}

export interface PostgresJobDispatcherOptions {
  dispatcherId?: string;
  batchSize?: number;
  lockTimeoutSeconds?: number;
  maxAttempts?: number;
  backoffBaseSeconds?: number;
  backoffCapSeconds?: number;
  clock?: () => number;
}

function isJobStore(value: JobDatabaseExecutor | JobStore): value is JobStore {
  return "claimBatch" in value && typeof value.claimBatch === "function";
}

function boundedInteger(value: number, minimum: number, maximum: number, label: string): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`Invalid ${label}`);
  }
  return value;
}

function failureCode(error: unknown): string {
  return error instanceof Error && error.message.startsWith("JOB_INVALID")
    ? "JOB_INVALID"
    : "JOB_FAILED";
}

export class PostgresJobDispatcher implements TransactionalJobDispatcher {
  private readonly store: JobStore;
  private readonly dispatcherId: string;
  private readonly batchSize: number;
  private readonly lockTimeoutSeconds: number;
  private readonly maxAttempts: number;
  private readonly backoffBaseSeconds: number;
  private readonly backoffCapSeconds: number;
  private readonly clock: () => number;

  constructor(
    databaseOrStore: JobDatabaseExecutor | JobStore,
    options: PostgresJobDispatcherOptions = {},
  ) {
    this.store = isJobStore(databaseOrStore)
      ? databaseOrStore
      : new PostgresJobStore(databaseOrStore);
    this.dispatcherId = options.dispatcherId ?? randomUUID();
    if (
      new TextEncoder().encode(this.dispatcherId).byteLength > 200 ||
      this.dispatcherId.length === 0
    ) {
      throw new Error("Invalid dispatcher id");
    }
    this.batchSize = boundedInteger(options.batchSize ?? 10, 1, 100, "job batch size");
    this.lockTimeoutSeconds = boundedInteger(
      options.lockTimeoutSeconds ?? 300,
      1,
      3_600,
      "job lock timeout",
    );
    this.maxAttempts = boundedInteger(options.maxAttempts ?? 5, 1, 20, "job max attempts");
    this.backoffBaseSeconds = boundedInteger(
      options.backoffBaseSeconds ?? 5,
      1,
      300,
      "job backoff base",
    );
    this.backoffCapSeconds = boundedInteger(
      options.backoffCapSeconds ?? 300,
      this.backoffBaseSeconds,
      3_600,
      "job backoff cap",
    );
    this.clock = options.clock ?? Date.now;
  }

  withDatabaseExecutor(executor: JobDatabaseExecutor): PostgresJobDispatcher {
    return new PostgresJobDispatcher(executor, {
      dispatcherId: this.dispatcherId,
      batchSize: this.batchSize,
      lockTimeoutSeconds: this.lockTimeoutSeconds,
      maxAttempts: this.maxAttempts,
      backoffBaseSeconds: this.backoffBaseSeconds,
      backoffCapSeconds: this.backoffCapSeconds,
      clock: this.clock,
    });
  }

  async enqueue<TType extends JobType>(
    input: EnqueueJobInput<TType>,
  ): Promise<{ id: string; duplicate: boolean }> {
    const prototype = Object.getPrototypeOf(input);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error("JOB_INVALID: enqueue input must be a plain object");
    }
    const allowedKeys = new Set([
      "workspaceId",
      "type",
      "payload",
      "idempotencyKey",
      "runAt",
      "maxAttempts",
    ]);
    if (Object.keys(input).some((key) => !allowedKeys.has(key))) {
      throw new Error("JOB_INVALID: enqueue input contains unknown keys");
    }
    const now = new Date(this.clock());
    const envelope = jobEnvelopeSchema.safeParse({
      id: randomUUID(),
      workspaceId: input.workspaceId,
      type: input.type,
      version: 1,
      attempts: 1,
      createdAt: now.toISOString(),
      payload: input.payload,
    });
    if (!envelope.success) throw new Error("JOB_INVALID: invalid enqueue payload");
    if (
      input.idempotencyKey !== undefined &&
      !idempotencyKeySchema.safeParse(input.idempotencyKey).success
    ) {
      throw new Error("JOB_INVALID: invalid idempotency key");
    }
    const availableAt = input.runAt ?? now;
    if (!(availableAt instanceof Date) || Number.isNaN(availableAt.getTime())) {
      throw new Error("JOB_INVALID: invalid runAt");
    }
    const maxAttempts = boundedInteger(
      input.maxAttempts ?? this.maxAttempts,
      1,
      20,
      "job max attempts",
    );
    return this.store.enqueue({
      workspaceId: input.workspaceId,
      type: input.type,
      version: 1,
      payload: envelope.data.payload as JobPayload<TType> & Record<string, unknown>,
      idempotencyKey: input.idempotencyKey ?? null,
      availableAt,
      maxAttempts,
    });
  }

  async dispatchBatch(
    handlers: JobRegistry,
    signal: AbortSignal = new AbortController().signal,
  ): Promise<DispatchSummary> {
    const nowMs = this.clock();
    const now = new Date(nowMs);
    const claimed = await this.store.claimBatch({
      dispatcherId: this.dispatcherId,
      batchSize: this.batchSize,
      now,
      lockBefore: new Date(nowMs - this.lockTimeoutSeconds * 1_000),
    });
    let succeeded = 0;
    let retried = 0;
    let deadLettered = 0;

    for (const job of claimed) {
      if (job.attempts > job.maxAttempts) {
        if (
          await this.store.markDeadLetter({
            jobId: job.id,
            dispatcherId: this.dispatcherId,
            claimGeneration: job.attempts,
            now: new Date(this.clock()),
            lastError: "JOB_FAILED",
          })
        ) {
          deadLettered += 1;
        }
        continue;
      }
      try {
        await dispatchValidatedJob(
          {
            id: job.id,
            workspaceId: job.workspaceId,
            type: job.type,
            version: job.version,
            attempts: job.attempts,
            createdAt: new Date(job.createdAt).toISOString(),
            payload: job.payload,
          },
          handlers,
          signal,
        );
        if (
          await this.store.markCompleted({
            jobId: job.id,
            dispatcherId: this.dispatcherId,
            claimGeneration: job.attempts,
            now: new Date(this.clock()),
          })
        ) {
          succeeded += 1;
        }
      } catch (error) {
        const transitionNowMs = this.clock();
        const transitionNow = new Date(transitionNowMs);
        const lastError = failureCode(error).slice(0, 4000);
        if (job.attempts >= job.maxAttempts) {
          if (
            await this.store.markDeadLetter({
              jobId: job.id,
              dispatcherId: this.dispatcherId,
              claimGeneration: job.attempts,
              now: transitionNow,
              lastError,
            })
          ) {
            deadLettered += 1;
          }
        } else {
          const delaySeconds = Math.min(
            this.backoffCapSeconds,
            this.backoffBaseSeconds * 2 ** Math.max(0, job.attempts - 1),
          );
          if (
            await this.store.markRetry({
              jobId: job.id,
              dispatcherId: this.dispatcherId,
              claimGeneration: job.attempts,
              now: transitionNow,
              availableAt: new Date(transitionNowMs + delaySeconds * 1_000),
              lastError,
            })
          ) {
            retried += 1;
          }
        }
      }
    }

    return { claimed: claimed.length, succeeded, retried, deadLettered };
  }
}
