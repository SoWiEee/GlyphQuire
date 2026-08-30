import {
  decodeCursor,
  encodeCursor,
  jobPayloadSchemas,
  type JobEnvelope,
} from "@glyphquire/api-contract/jobs";
import { exports, type Database, type ExportStatus } from "@glyphquire/database";
import { PostgresJobDispatcher, type EnqueueJobInput, type JobHandler } from "@glyphquire/queue";
import type { ObjectStoragePort } from "@glyphquire/storage";
import { and, asc, eq, gt, isNotNull, lte, or } from "drizzle-orm";

export interface ExportExpiryRow {
  id: string;
  workspaceId: string;
  createdAt: Date;
  expiresAt: Date;
  status: ExportStatus;
  hasArtifact: boolean;
}

export interface ExportExpiryRepository {
  listEligible(input: {
    workspaceId: string;
    now: Date;
    cursor?: { createdAt: string; id: string };
    limit: number;
  }): Promise<ExportExpiryRow[]>;
  expireIfEligible(
    input: { exportId: string; workspaceId: string; now: Date },
    deleteArtifact: () => Promise<void>,
  ): Promise<boolean>;
}

export interface ExportExpiryDispatcher {
  enqueue(input: EnqueueJobInput<"export.expire">): Promise<{ id: string; duplicate: boolean }>;
}

export interface ExportExpiryHandlerDependencies {
  repository: ExportExpiryRepository;
  storage: Pick<ObjectStoragePort, "delete">;
  dispatcher: ExportExpiryDispatcher;
  clock?: () => number;
}

const selectedExport = {
  id: exports.id,
  workspaceId: exports.workspaceId,
  createdAt: exports.createdAt,
  expiresAt: exports.expiresAt,
  status: exports.status,
  objectKey: exports.objectKey,
};

export class PostgresExportExpiryRepository implements ExportExpiryRepository {
  constructor(private readonly db: Database) {}

  async listEligible(input: {
    workspaceId: string;
    now: Date;
    cursor?: { createdAt: string; id: string };
    limit: number;
  }): Promise<ExportExpiryRow[]> {
    const cursorCondition = input.cursor
      ? or(
          gt(exports.createdAt, new Date(input.cursor.createdAt)),
          and(
            eq(exports.createdAt, new Date(input.cursor.createdAt)),
            gt(exports.id, input.cursor.id),
          ),
        )
      : undefined;
    const rows = await this.db
      .select(selectedExport)
      .from(exports)
      .where(
        and(
          eq(exports.workspaceId, input.workspaceId),
          eq(exports.status, "completed"),
          isNotNull(exports.objectKey),
          lte(exports.expiresAt, input.now),
          cursorCondition,
        ),
      )
      .orderBy(asc(exports.createdAt), asc(exports.id))
      .limit(input.limit);
    return rows.map((row) => ({ ...row, hasArtifact: row.objectKey !== null }));
  }

  async expireIfEligible(
    input: { exportId: string; workspaceId: string; now: Date },
    deleteArtifact: () => Promise<void>,
  ): Promise<boolean> {
    return this.db.transaction(async (transaction) => {
      const [current] = await transaction
        .select(selectedExport)
        .from(exports)
        .where(and(eq(exports.id, input.exportId), eq(exports.workspaceId, input.workspaceId)))
        .limit(1)
        .for("update");
      if (
        !current ||
        current.status !== "completed" ||
        current.objectKey === null ||
        current.expiresAt.getTime() > input.now.getTime()
      ) {
        return false;
      }
      const expectedKey = `workspace/${input.workspaceId}/exports/${input.exportId}/artifact`;
      if (current.objectKey !== expectedKey) throw new Error("JOB_FAILED");
      await deleteArtifact();
      const [expired] = await transaction
        .update(exports)
        .set({ status: "expired", objectKey: null, lastError: null })
        .where(
          and(
            eq(exports.id, input.exportId),
            eq(exports.workspaceId, input.workspaceId),
            eq(exports.status, "completed"),
            eq(exports.objectKey, expectedKey),
            lte(exports.expiresAt, input.now),
          ),
        )
        .returning({ id: exports.id });
      return expired !== undefined;
    });
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

export function createExportExpiryHandler(
  dependencies: ExportExpiryHandlerDependencies,
): JobHandler<"export.expire"> {
  const clock = dependencies.clock ?? Date.now;
  return async (job: JobEnvelope<"export.expire">, signal: AbortSignal) => {
    checkAborted(signal);
    const parsed = jobPayloadSchemas["export.expire"].safeParse(job.payload);
    if (!parsed.success || job.workspaceId !== parsed.data.workspaceId) {
      throw new Error("JOB_INVALID: invalid export.expire payload");
    }
    const nowMs = clock();
    if (!Number.isSafeInteger(nowMs) || nowMs < 0) throw new Error("JOB_FAILED");
    const now = new Date(nowMs);
    let cursor: { createdAt: string; id: string } | undefined;
    if (parsed.data.cursor) {
      try {
        cursor = decodeCursor(parsed.data.cursor);
      } catch {
        throw new Error("JOB_INVALID: invalid export.expire cursor");
      }
    }

    const rows = await scrubbed(() =>
      dependencies.repository.listEligible({
        workspaceId: parsed.data.workspaceId,
        now,
        cursor,
        limit: parsed.data.batchSize,
      }),
    );
    for (const row of rows) {
      checkAborted(signal);
      if (row.workspaceId !== parsed.data.workspaceId) {
        throw new Error("JOB_INVALID: export.expire scan source mismatch");
      }
      await scrubbed(() =>
        dependencies.repository.expireIfEligible(
          { exportId: row.id, workspaceId: row.workspaceId, now },
          async () => {
            if (row.hasArtifact) {
              await dependencies.storage.delete(
                `workspace/${row.workspaceId}/exports/${row.id}/artifact`,
              );
            }
          },
        ),
      );
    }

    if (rows.length === parsed.data.batchSize) {
      const last = rows[rows.length - 1]!;
      const nextCursor = encodeCursor({ createdAt: last.createdAt.toISOString(), id: last.id });
      await scrubbed(() =>
        dependencies.dispatcher.enqueue({
          workspaceId: parsed.data.workspaceId,
          type: "export.expire",
          payload: {
            workspaceId: parsed.data.workspaceId,
            batchSize: parsed.data.batchSize,
            cursor: nextCursor,
          },
          idempotencyKey: `export-expire-${parsed.data.workspaceId}-${last.createdAt.getTime()}-${last.id}`,
        }),
      );
    }
  };
}

export function createPostgresExportExpiryHandler(input: {
  database: Database;
  storage: Pick<ObjectStoragePort, "delete">;
  clock?: () => number;
}): JobHandler<"export.expire"> {
  return createExportExpiryHandler({
    repository: new PostgresExportExpiryRepository(input.database),
    storage: input.storage,
    dispatcher: new PostgresJobDispatcher(input.database),
    clock: input.clock,
  });
}
