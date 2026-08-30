import {
  decodeCursor,
  encodeCursor,
  jobPayloadSchemas,
  type JobEnvelope,
} from "@glyphquire/api-contract/jobs";
import { assets, notes, noteVersions, type Database } from "@glyphquire/database";
import { PostgresJobDispatcher, type EnqueueJobInput, type JobHandler } from "@glyphquire/queue";
import type { ObjectStoragePort } from "@glyphquire/storage";
import { and, asc, eq, gt, isNotNull, isNull, lte, or, sql } from "drizzle-orm";

const MILLISECONDS_PER_DAY = 86_400_000;
const MAX_GRACE_DAYS = 3_650;

export interface AssetOrphanCleanupRow {
  id: string;
  workspaceId: string;
  createdAt: Date;
  deletedAt: Date;
  hasThumbnail: boolean;
}

export interface AssetOrphanCleanupAuditEvent {
  event: "asset_orphan_deleted";
  jobId: string;
  workspaceId: string;
  assetId: string;
}

export interface AssetOrphanCleanupAudit {
  record(event: AssetOrphanCleanupAuditEvent): Promise<void>;
}

export interface AssetOrphanCleanupRepository {
  listCandidates(input: {
    workspaceId: string;
    cutoff: Date;
    cursor?: { createdAt: string; id: string };
    limit: number;
  }): Promise<AssetOrphanCleanupRow[]>;
  deleteIfUnreferenced(
    input: { assetId: string; workspaceId: string; cutoff: Date },
    deleteObjects: () => Promise<void>,
    recordAudit?: () => Promise<void>,
  ): Promise<boolean>;
}

export interface AssetOrphanCleanupDispatcher {
  enqueue(
    input: EnqueueJobInput<"asset.orphan_cleanup">,
  ): Promise<{ id: string; duplicate: boolean }>;
}

export interface AssetOrphanCleanupHandlerDependencies {
  repository: AssetOrphanCleanupRepository;
  storage: Pick<ObjectStoragePort, "delete">;
  dispatcher: AssetOrphanCleanupDispatcher;
  audit: AssetOrphanCleanupAudit;
  graceDays?: number;
  clock?: () => number;
}

const selectedAsset = {
  id: assets.id,
  workspaceId: assets.workspaceId,
  createdAt: assets.createdAt,
  deletedAt: assets.deletedAt,
  objectKey: assets.objectKey,
  thumbnailObjectKey: assets.thumbnailObjectKey,
  thumbnailStatus: assets.thumbnailStatus,
};

export class PostgresAssetOrphanCleanupRepository implements AssetOrphanCleanupRepository {
  constructor(private readonly db: Database) {}

  async listCandidates(input: {
    workspaceId: string;
    cutoff: Date;
    cursor?: { createdAt: string; id: string };
    limit: number;
  }): Promise<AssetOrphanCleanupRow[]> {
    const cursorCondition = input.cursor
      ? or(
          gt(assets.createdAt, new Date(input.cursor.createdAt)),
          and(
            eq(assets.createdAt, new Date(input.cursor.createdAt)),
            gt(assets.id, input.cursor.id),
          ),
        )
      : undefined;
    const rows = await this.db
      .select(selectedAsset)
      .from(assets)
      .where(
        and(
          eq(assets.workspaceId, input.workspaceId),
          isNotNull(assets.deletedAt),
          lte(assets.deletedAt, input.cutoff),
          cursorCondition,
        ),
      )
      .orderBy(asc(assets.createdAt), asc(assets.id))
      .limit(input.limit);
    return rows.flatMap((row) =>
      row.deletedAt
        ? [{ ...row, deletedAt: row.deletedAt, hasThumbnail: row.thumbnailStatus === "ready" }]
        : [],
    );
  }

  async deleteIfUnreferenced(
    input: { assetId: string; workspaceId: string; cutoff: Date },
    deleteObjects: () => Promise<void>,
    recordAudit?: () => Promise<void>,
  ): Promise<boolean> {
    return this.db.transaction(async (transaction) => {
      const [current] = await transaction
        .select(selectedAsset)
        .from(assets)
        .where(and(eq(assets.id, input.assetId), eq(assets.workspaceId, input.workspaceId)))
        .limit(1)
        .for("update");
      if (
        !current ||
        current.deletedAt === null ||
        current.deletedAt.getTime() > input.cutoff.getTime()
      ) {
        return false;
      }

      const reference = `asset://${input.assetId}`;
      const [liveCurrent] = await transaction
        .select({ id: notes.id })
        .from(notes)
        .where(
          and(
            eq(notes.workspaceId, input.workspaceId),
            isNull(notes.deletedAt),
            sql`position(${reference} in ${notes.contentMarkdown}) > 0`,
          ),
        )
        .limit(1);
      if (liveCurrent) return false;

      // Historical content for an active note is still a live restore source.
      const [liveVersion] = await transaction
        .select({ id: noteVersions.id })
        .from(noteVersions)
        .innerJoin(
          notes,
          and(eq(notes.id, noteVersions.noteId), eq(notes.workspaceId, noteVersions.workspaceId)),
        )
        .where(
          and(
            eq(noteVersions.workspaceId, input.workspaceId),
            isNull(notes.deletedAt),
            sql`position(${reference} in ${noteVersions.contentMarkdown}) > 0`,
          ),
        )
        .limit(1);
      if (liveVersion) return false;

      const expectedOriginal = `workspace/${input.workspaceId}/assets/${input.assetId}/original`;
      const expectedThumbnail = `workspace/${input.workspaceId}/assets/${input.assetId}/thumbnail.webp`;
      if (
        current.objectKey !== expectedOriginal ||
        (current.thumbnailObjectKey !== null && current.thumbnailObjectKey !== expectedThumbnail)
      ) {
        throw new Error("JOB_FAILED");
      }
      await deleteObjects();
      await recordAudit?.();
      const [deleted] = await transaction
        .delete(assets)
        .where(
          and(
            eq(assets.id, input.assetId),
            eq(assets.workspaceId, input.workspaceId),
            isNotNull(assets.deletedAt),
            lte(assets.deletedAt, input.cutoff),
          ),
        )
        .returning({ id: assets.id });
      return deleted !== undefined;
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

export function createAssetOrphanCleanupHandler(
  dependencies: AssetOrphanCleanupHandlerDependencies,
): JobHandler<"asset.orphan_cleanup"> {
  if (!dependencies.audit) throw new Error("JOB_FAILED: asset cleanup audit is required");
  const graceDays = dependencies.graceDays ?? 30;
  if (!Number.isInteger(graceDays) || graceDays < 1 || graceDays > MAX_GRACE_DAYS) {
    throw new Error("Invalid asset orphan grace days");
  }
  const clock = dependencies.clock ?? Date.now;

  return async (job: JobEnvelope<"asset.orphan_cleanup">, signal: AbortSignal) => {
    checkAborted(signal);
    const parsed = jobPayloadSchemas["asset.orphan_cleanup"].safeParse(job.payload);
    if (!parsed.success || job.workspaceId !== parsed.data.workspaceId) {
      throw new Error("JOB_INVALID: invalid asset.orphan_cleanup payload");
    }
    const now = clock();
    if (!Number.isSafeInteger(now) || now < 0) throw new Error("JOB_FAILED");
    const cutoff = new Date(now - graceDays * MILLISECONDS_PER_DAY);
    let cursor: { createdAt: string; id: string } | undefined;
    if (parsed.data.cursor) {
      try {
        cursor = decodeCursor(parsed.data.cursor);
      } catch {
        throw new Error("JOB_INVALID: invalid asset.orphan_cleanup cursor");
      }
    }
    const rows = await scrubbed(() =>
      dependencies.repository.listCandidates({
        workspaceId: parsed.data.workspaceId,
        cutoff,
        cursor,
        limit: parsed.data.batchSize,
      }),
    );
    for (const row of rows) {
      checkAborted(signal);
      if (row.workspaceId !== parsed.data.workspaceId) {
        throw new Error("JOB_INVALID: asset.orphan_cleanup scan source mismatch");
      }
      let auditRecorded = false;
      const recordAudit = async () => {
        await dependencies.audit.record({
          event: "asset_orphan_deleted",
          jobId: job.id,
          workspaceId: row.workspaceId,
          assetId: row.id,
        });
        auditRecorded = true;
      };
      const deleted = await scrubbed(() =>
        dependencies.repository.deleteIfUnreferenced(
          { assetId: row.id, workspaceId: row.workspaceId, cutoff },
          async () => {
            await dependencies.storage.delete(
              `workspace/${row.workspaceId}/assets/${row.id}/original`,
            );
            if (row.hasThumbnail) {
              await dependencies.storage.delete(
                `workspace/${row.workspaceId}/assets/${row.id}/thumbnail.webp`,
              );
            }
          },
          recordAudit,
        ),
      );
      // Test doubles and alternative repositories may not support the optional
      // transactional callback; preserve the audit contract for those adapters.
      if (deleted && !auditRecorded) await scrubbed(recordAudit);
    }

    if (rows.length === parsed.data.batchSize) {
      const last = rows[rows.length - 1]!;
      const nextCursor = encodeCursor({ createdAt: last.createdAt.toISOString(), id: last.id });
      await scrubbed(() =>
        dependencies.dispatcher.enqueue({
          workspaceId: parsed.data.workspaceId,
          type: "asset.orphan_cleanup",
          payload: {
            workspaceId: parsed.data.workspaceId,
            batchSize: parsed.data.batchSize,
            cursor: nextCursor,
          },
          idempotencyKey: `asset-orphan-cleanup-${parsed.data.workspaceId}-${last.createdAt.getTime()}-${last.id}`,
        }),
      );
    }
  };
}

export function createPostgresAssetOrphanCleanupHandler(input: {
  database: Database;
  storage: Pick<ObjectStoragePort, "delete">;
  audit: AssetOrphanCleanupAudit;
  graceDays: number;
  clock?: () => number;
}): JobHandler<"asset.orphan_cleanup"> {
  return createAssetOrphanCleanupHandler({
    repository: new PostgresAssetOrphanCleanupRepository(input.database),
    storage: input.storage,
    dispatcher: new PostgresJobDispatcher(input.database),
    audit: input.audit,
    graceDays: input.graceDays,
    clock: input.clock,
  });
}
