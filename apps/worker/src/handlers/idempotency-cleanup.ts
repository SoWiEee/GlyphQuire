import {
  decodeCursor,
  encodeCursor,
  jobPayloadSchemas,
  type JobEnvelope,
} from "@glyphquire/api-contract/jobs";
import { idempotencyRecords, type Database } from "@glyphquire/database";
import { PostgresJobDispatcher, type EnqueueJobInput, type JobHandler } from "@glyphquire/queue";
import { and, asc, eq, gt, isNotNull, isNull, lte, or } from "drizzle-orm";

const MILLISECONDS_PER_DAY = 86_400_000;
const MAX_RETENTION_DAYS = 3_650;

export interface IdempotencyCleanupRow {
  id: string;
  workspaceId: string;
  createdAt: Date;
  completedAt: Date;
}

export interface IdempotencyCleanupRepository {
  listEligible(input: {
    workspaceId: string;
    cutoff: Date;
    cursor?: { createdAt: string; id: string };
    limit: number;
  }): Promise<IdempotencyCleanupRow[]>;
  deleteIfCompletedBefore(input: {
    recordId: string;
    workspaceId: string;
    cutoff: Date;
  }): Promise<boolean>;
}

export interface IdempotencyCleanupDispatcher {
  enqueue(
    input: EnqueueJobInput<"idempotency.cleanup">,
  ): Promise<{ id: string; duplicate: boolean }>;
}

export interface IdempotencyCleanupHandlerDependencies {
  repository: IdempotencyCleanupRepository;
  dispatcher: IdempotencyCleanupDispatcher;
  retentionDays?: number;
  clock?: () => number;
}

const selectedRecord = {
  id: idempotencyRecords.id,
  workspaceId: idempotencyRecords.workspaceId,
  createdAt: idempotencyRecords.createdAt,
  completedAt: idempotencyRecords.completedAt,
};

function completedState() {
  return and(
    isNotNull(idempotencyRecords.completedAt),
    isNotNull(idempotencyRecords.responseCiphertext),
    isNull(idempotencyRecords.ownerTokenHash),
    isNull(idempotencyRecords.leaseExpiresAt),
  );
}

export class PostgresIdempotencyCleanupRepository implements IdempotencyCleanupRepository {
  constructor(private readonly db: Database) {}

  async listEligible(input: {
    workspaceId: string;
    cutoff: Date;
    cursor?: { createdAt: string; id: string };
    limit: number;
  }): Promise<IdempotencyCleanupRow[]> {
    const cursorCondition = input.cursor
      ? or(
          gt(idempotencyRecords.createdAt, new Date(input.cursor.createdAt)),
          and(
            eq(idempotencyRecords.createdAt, new Date(input.cursor.createdAt)),
            gt(idempotencyRecords.id, input.cursor.id),
          ),
        )
      : undefined;
    const rows = await this.db
      .select(selectedRecord)
      .from(idempotencyRecords)
      .where(
        and(
          eq(idempotencyRecords.workspaceId, input.workspaceId),
          completedState(),
          lte(idempotencyRecords.completedAt, input.cutoff),
          cursorCondition,
        ),
      )
      .orderBy(asc(idempotencyRecords.createdAt), asc(idempotencyRecords.id))
      .limit(input.limit);
    return rows.flatMap((row) =>
      row.completedAt ? [{ ...row, completedAt: row.completedAt }] : [],
    );
  }

  async deleteIfCompletedBefore(input: {
    recordId: string;
    workspaceId: string;
    cutoff: Date;
  }): Promise<boolean> {
    const [deleted] = await this.db
      .delete(idempotencyRecords)
      .where(
        and(
          eq(idempotencyRecords.id, input.recordId),
          eq(idempotencyRecords.workspaceId, input.workspaceId),
          completedState(),
          lte(idempotencyRecords.completedAt, input.cutoff),
        ),
      )
      .returning({ id: idempotencyRecords.id });
    return deleted !== undefined;
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

export function createIdempotencyCleanupHandler(
  dependencies: IdempotencyCleanupHandlerDependencies,
): JobHandler<"idempotency.cleanup"> {
  const retentionDays = dependencies.retentionDays ?? 30;
  if (!Number.isInteger(retentionDays) || retentionDays < 1 || retentionDays > MAX_RETENTION_DAYS) {
    throw new Error("Invalid idempotency retention days");
  }
  const clock = dependencies.clock ?? Date.now;

  return async (job: JobEnvelope<"idempotency.cleanup">, signal: AbortSignal) => {
    checkAborted(signal);
    const parsed = jobPayloadSchemas["idempotency.cleanup"].safeParse(job.payload);
    if (!parsed.success || job.workspaceId !== parsed.data.workspaceId) {
      throw new Error("JOB_INVALID: invalid idempotency.cleanup payload");
    }
    const now = clock();
    if (!Number.isSafeInteger(now) || now < 0) throw new Error("JOB_FAILED");
    const cutoff = new Date(now - retentionDays * MILLISECONDS_PER_DAY);
    let cursor: { createdAt: string; id: string } | undefined;
    if (parsed.data.cursor) {
      try {
        cursor = decodeCursor(parsed.data.cursor);
      } catch {
        throw new Error("JOB_INVALID: invalid idempotency.cleanup cursor");
      }
    }
    const rows = await scrubbed(() =>
      dependencies.repository.listEligible({
        workspaceId: parsed.data.workspaceId,
        cutoff,
        cursor,
        limit: parsed.data.batchSize,
      }),
    );
    for (const row of rows) {
      checkAborted(signal);
      if (row.workspaceId !== parsed.data.workspaceId) {
        throw new Error("JOB_INVALID: idempotency.cleanup scan source mismatch");
      }
      await scrubbed(() =>
        dependencies.repository.deleteIfCompletedBefore({
          recordId: row.id,
          workspaceId: row.workspaceId,
          cutoff,
        }),
      );
    }

    if (rows.length === parsed.data.batchSize) {
      const last = rows[rows.length - 1]!;
      const nextCursor = encodeCursor({ createdAt: last.createdAt.toISOString(), id: last.id });
      await scrubbed(() =>
        dependencies.dispatcher.enqueue({
          workspaceId: parsed.data.workspaceId,
          type: "idempotency.cleanup",
          payload: {
            workspaceId: parsed.data.workspaceId,
            batchSize: parsed.data.batchSize,
            cursor: nextCursor,
          },
          idempotencyKey: `idempotency-cleanup-${parsed.data.workspaceId}-${last.createdAt.getTime()}-${last.id}`,
        }),
      );
    }
  };
}

export function createPostgresIdempotencyCleanupHandler(input: {
  database: Database;
  retentionDays: number;
  clock?: () => number;
}): JobHandler<"idempotency.cleanup"> {
  return createIdempotencyCleanupHandler({
    repository: new PostgresIdempotencyCleanupRepository(input.database),
    dispatcher: new PostgresJobDispatcher(input.database),
    retentionDays: input.retentionDays,
    clock: input.clock,
  });
}
