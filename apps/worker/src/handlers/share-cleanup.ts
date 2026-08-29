import {
  decodeCursor,
  encodeCursor,
  jobPayloadSchemas,
  type JobEnvelope,
} from "@glyphquire/api-contract/jobs";
import { shareLinks, type Database } from "@glyphquire/database";
import { PostgresJobDispatcher, type EnqueueJobInput, type JobHandler } from "@glyphquire/queue";
import { and, asc, eq, gt, isNotNull, isNull, lte, or } from "drizzle-orm";

const DEFAULT_GRACE_SECONDS = 3_600;
const MAX_GRACE_SECONDS = 31_536_000;
const MILLISECONDS_PER_SECOND = 1_000;

export interface ShareCleanupRow {
  id: string;
  workspaceId: string;
  createdAt: Date;
  expiresAt: Date | null;
  revokedAt: Date | null;
}

export interface ShareCleanupRepository {
  load(shareLinkId: string): Promise<ShareCleanupRow | undefined>;
  listEligible(input: {
    workspaceId: string;
    cutoff: Date;
    cursor?: { createdAt: string; id: string };
    limit: number;
  }): Promise<ShareCleanupRow[]>;
  deleteIfEligible(input: {
    shareLinkId: string;
    workspaceId: string;
    cutoff: Date;
    beforeDelete?: (reason: "expired" | "revoked") => Promise<void>;
    afterDelete?: (reason: "expired" | "revoked") => Promise<void>;
  }): Promise<"expired" | "revoked" | null>;
}

export interface ShareCleanupDispatcher {
  enqueue(input: EnqueueJobInput<"share.cleanup">): Promise<{ id: string; duplicate: boolean }>;
}

export interface ShareCleanupAuditEvent {
  event: "share_link_delete_intent" | "share_link_deleted";
  jobId: string;
  workspaceId: string;
  shareLinkId: string;
  reason: "expired" | "revoked";
}

export interface ShareCleanupAudit {
  /**
   * Delivery is at least once. Sinks must accept replay and may deduplicate on
   * the stable (event, jobId, shareLinkId) tuple.
   */
  record(event: ShareCleanupAuditEvent): Promise<void>;
}

export interface ShareCleanupHandlerDependencies {
  repository: ShareCleanupRepository;
  dispatcher: ShareCleanupDispatcher;
  audit: ShareCleanupAudit;
  graceSeconds?: number;
  clock?: () => number;
}

function eligibleAt(cutoff: Date) {
  return or(
    and(isNotNull(shareLinks.revokedAt), lte(shareLinks.revokedAt, cutoff)),
    and(
      isNull(shareLinks.revokedAt),
      isNotNull(shareLinks.expiresAt),
      lte(shareLinks.expiresAt, cutoff),
    ),
  );
}

const selectedRow = {
  id: shareLinks.id,
  workspaceId: shareLinks.workspaceId,
  createdAt: shareLinks.createdAt,
  expiresAt: shareLinks.expiresAt,
  revokedAt: shareLinks.revokedAt,
};

export class PostgresShareCleanupRepository implements ShareCleanupRepository {
  constructor(private readonly db: Database) {}

  async load(shareLinkId: string): Promise<ShareCleanupRow | undefined> {
    const [row] = await this.db
      .select(selectedRow)
      .from(shareLinks)
      .where(eq(shareLinks.id, shareLinkId))
      .limit(1);
    return row;
  }

  async listEligible(input: {
    workspaceId: string;
    cutoff: Date;
    cursor?: { createdAt: string; id: string };
    limit: number;
  }): Promise<ShareCleanupRow[]> {
    const cursorCondition = input.cursor
      ? or(
          gt(shareLinks.createdAt, new Date(input.cursor.createdAt)),
          and(
            eq(shareLinks.createdAt, new Date(input.cursor.createdAt)),
            gt(shareLinks.id, input.cursor.id),
          ),
        )
      : undefined;
    return this.db
      .select(selectedRow)
      .from(shareLinks)
      .where(
        and(
          eq(shareLinks.workspaceId, input.workspaceId),
          eligibleAt(input.cutoff),
          cursorCondition,
        ),
      )
      .orderBy(asc(shareLinks.createdAt), asc(shareLinks.id))
      .limit(input.limit);
  }

  async deleteIfEligible(input: {
    shareLinkId: string;
    workspaceId: string;
    cutoff: Date;
    beforeDelete?: (reason: "expired" | "revoked") => Promise<void>;
    afterDelete?: (reason: "expired" | "revoked") => Promise<void>;
  }): Promise<"expired" | "revoked" | null> {
    return this.db.transaction(async (transaction) => {
      const [current] = await transaction
        .select(selectedRow)
        .from(shareLinks)
        .where(
          and(eq(shareLinks.id, input.shareLinkId), eq(shareLinks.workspaceId, input.workspaceId)),
        )
        .limit(1)
        .for("update");
      if (!current) return null;
      const reason = current.revokedAt !== null ? "revoked" : "expired";
      if (
        (reason === "revoked" && current.revokedAt!.getTime() > input.cutoff.getTime()) ||
        (reason === "expired" &&
          (current.expiresAt === null || current.expiresAt.getTime() > input.cutoff.getTime()))
      ) {
        return null;
      }
      await input.beforeDelete?.(reason);
      const [deleted] = await transaction
        .delete(shareLinks)
        .where(
          and(
            eq(shareLinks.id, input.shareLinkId),
            eq(shareLinks.workspaceId, input.workspaceId),
            eligibleAt(input.cutoff),
          ),
        )
        .returning({ revokedAt: shareLinks.revokedAt });
      if (!deleted) return null;
      const deletedReason = deleted.revokedAt === null ? "expired" : "revoked";
      await input.afterDelete?.(deletedReason);
      return deletedReason;
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

export function createShareCleanupHandler(
  dependencies: ShareCleanupHandlerDependencies,
): JobHandler<"share.cleanup"> {
  const audit = dependencies.audit;
  if (!audit) throw new Error("JOB_FAILED: share cleanup audit is required");
  const graceSeconds = dependencies.graceSeconds ?? DEFAULT_GRACE_SECONDS;
  if (!Number.isInteger(graceSeconds) || graceSeconds < 1 || graceSeconds > MAX_GRACE_SECONDS) {
    throw new Error("Invalid share cleanup grace seconds");
  }
  const clock = dependencies.clock ?? Date.now;

  async function auditAndDelete(
    job: JobEnvelope<"share.cleanup">,
    row: ShareCleanupRow,
    cutoff: Date,
  ): Promise<void> {
    await scrubbed(() =>
      dependencies.repository.deleteIfEligible({
        shareLinkId: row.id,
        workspaceId: row.workspaceId,
        cutoff,
        beforeDelete: async (deleteReason) => {
          await scrubbed(() =>
            audit.record({
              event: "share_link_delete_intent",
              jobId: job.id,
              workspaceId: row.workspaceId,
              shareLinkId: row.id,
              reason: deleteReason,
            }),
          );
        },
        afterDelete: async (deleteReason) => {
          await scrubbed(() =>
            audit.record({
              event: "share_link_deleted",
              jobId: job.id,
              workspaceId: row.workspaceId,
              shareLinkId: row.id,
              reason: deleteReason,
            }),
          );
        },
      }),
    );
  }

  return async (job: JobEnvelope<"share.cleanup">, signal: AbortSignal) => {
    checkAborted(signal);
    const parsed = jobPayloadSchemas["share.cleanup"].safeParse(job.payload);
    if (!parsed.success || job.workspaceId !== parsed.data.workspaceId) {
      throw new Error("JOB_INVALID: invalid share.cleanup payload");
    }
    const now = clock();
    if (!Number.isSafeInteger(now) || now < 0) throw new Error("JOB_FAILED");
    const cutoff = new Date(now - graceSeconds * MILLISECONDS_PER_SECOND);
    const payload = parsed.data;

    if (payload.scope === "one") {
      const source = await scrubbed(() => dependencies.repository.load(payload.shareLinkId));
      if (!source) return;
      if (source.workspaceId !== payload.workspaceId) {
        throw new Error("JOB_INVALID: share.cleanup source mismatch");
      }
      await auditAndDelete(job, source, cutoff);
      return;
    }

    let cursor: { createdAt: string; id: string } | undefined;
    if (payload.cursor) {
      try {
        cursor = decodeCursor(payload.cursor);
      } catch {
        throw new Error("JOB_INVALID: invalid share.cleanup cursor");
      }
    }
    const rows = await scrubbed(() =>
      dependencies.repository.listEligible({
        workspaceId: payload.workspaceId,
        cutoff,
        cursor,
        limit: payload.batchSize,
      }),
    );
    for (const row of rows) {
      checkAborted(signal);
      if (row.workspaceId !== payload.workspaceId) {
        throw new Error("JOB_INVALID: share.cleanup scan source mismatch");
      }
      await auditAndDelete(job, row, cutoff);
    }

    if (rows.length === payload.batchSize) {
      const last = rows[rows.length - 1]!;
      const nextCursor = encodeCursor({
        createdAt: last.createdAt.toISOString(),
        id: last.id,
      });
      await scrubbed(() =>
        dependencies.dispatcher.enqueue({
          workspaceId: payload.workspaceId,
          type: "share.cleanup",
          payload: {
            workspaceId: payload.workspaceId,
            scope: "expired",
            batchSize: payload.batchSize,
            cursor: nextCursor,
          },
          idempotencyKey: `share-cleanup-expired-${payload.workspaceId}-${last.createdAt.getTime()}-${last.id}`,
        }),
      );
    }
  };
}

export function createPostgresShareCleanupHandler(input: {
  database: Database;
  audit: ShareCleanupAudit;
  graceSeconds?: number;
  clock?: () => number;
}): JobHandler<"share.cleanup"> {
  return createShareCleanupHandler({
    repository: new PostgresShareCleanupRepository(input.database),
    dispatcher: new PostgresJobDispatcher(input.database),
    graceSeconds: input.graceSeconds,
    clock: input.clock,
    audit: input.audit,
  });
}
