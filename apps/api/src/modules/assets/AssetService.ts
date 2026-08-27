import { createHash, randomUUID } from "node:crypto";
import {
  assets,
  workspaceMembers,
  type Asset,
  type Database,
  type IdempotencyStore,
} from "@glyphquire/database";
import type { ObjectStoragePort } from "@glyphquire/storage";
import type { AssetResponse } from "@glyphquire/api-contract";
import { assetResponseSchema } from "@glyphquire/api-contract";
import type { JobDispatcher, TransactionalJobDispatcher } from "@glyphquire/queue";
import { and, eq, isNull, sql } from "drizzle-orm";
import { PublicApiError } from "../../middleware/error-handler.js";
import {
  assertActualMatchesDeclared,
  assertAllowedMimeType,
  assertNoMimeSpoof,
  assertWithinMaxBytes,
  assertWithinWorkspaceQuota,
  buildOriginalObjectKey,
  normalizeFilename,
} from "./limits.js";

export interface CreateAssetInput {
  originalName: string;
  declaredMimeType: string;
  declaredSize: number;
  body: Buffer;
}

export interface AssetServiceLimits {
  maxBytes: number;
  workspaceQuotaBytes: number;
  downloadUrlExpirySeconds: number;
  assetDeleteGraceDays: number;
}

const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1_000;
const MAX_ASSET_DELETE_GRACE_DAYS = 3_650;

const DEFAULT_LIMITS: AssetServiceLimits = {
  maxBytes: 5 * 1024 * 1024,
  workspaceQuotaBytes: 100 * 1024 * 1024,
  downloadUrlExpirySeconds: 300,
  assetDeleteGraceDays: 30,
};

/**
 * Fault-injection hooks for exercising create-flow atomicity in tests. The
 * production create() order is: insert the metadata row inside a
 * transaction, then write the object; a failure writing the object rolls the
 * transaction back automatically (nothing external was written). A failure
 * that occurs *after* the object write (surfaced via afterObjectPut) still
 * rolls the DB transaction back, so the service explicitly compensates by
 * deleting the now-orphaned object. afterDeleteJobInsert exercises the delete
 * transaction after both the soft-delete row and cleanup job have been written.
 */
export interface AssetServiceHooks {
  beforeDbInsert?(): void | Promise<void>;
  afterDbInsert?(): void | Promise<void>;
  beforeObjectPut?(): void | Promise<void>;
  afterObjectPut?(): void | Promise<void>;
  afterDeleteJobInsert?(): void | Promise<void>;
}

export interface AssetService {
  create(
    actorId: string,
    workspaceId: string,
    input: CreateAssetInput,
    idempotencyKey: string,
  ): Promise<AssetResponse>;
  get(actorId: string, assetId: string): Promise<AssetResponse>;
  getDownloadUrl(actorId: string, assetId: string): Promise<AssetResponse>;
  getThumbnailUrl(actorId: string, assetId: string): Promise<AssetResponse>;
  delete(actorId: string, assetId: string, idempotencyKey: string): Promise<AssetResponse>;
}

function invalidAsset(): never {
  throw new PublicApiError("ASSET_INVALID", 400);
}

function notFound(): never {
  throw new PublicApiError("ASSET_INVALID", 404);
}

function canonicalRequestHash(payload: Record<string, unknown>): string {
  const keys = Object.keys(payload).sort();
  return createHash("sha256").update(JSON.stringify(payload, keys), "utf8").digest("hex");
}

function toAssetResponse(row: Asset): AssetResponse {
  const base: AssetResponse = {
    id: row.id,
    workspaceId: row.workspaceId,
    originalName: row.originalName,
    mimeType: row.mimeType,
    size: row.sizeBytes,
    sha256: row.sha256,
    createdAt: row.createdAt.toISOString(),
    deletedAt: row.deletedAt ? row.deletedAt.toISOString() : null,
    thumbnailStatus: row.thumbnailStatus,
  };
  if (row.thumbnailStatus === "ready") {
    return {
      ...base,
      thumbnailMimeType: row.thumbnailMimeType ?? undefined,
      thumbnailWidth: row.thumbnailWidth ?? undefined,
      thumbnailHeight: row.thumbnailHeight ?? undefined,
      thumbnailBytes: row.thumbnailBytes ?? undefined,
    };
  }
  return base;
}

type DbTransaction = Parameters<Database["transaction"]>[0] extends (tx: infer Tx) => unknown
  ? Tx
  : never;

function isTransactionalDispatcher(
  dispatcher: JobDispatcher,
): dispatcher is TransactionalJobDispatcher {
  return (
    "withDatabaseExecutor" in dispatcher && typeof dispatcher.withDatabaseExecutor === "function"
  );
}

export class AssetServiceImpl implements AssetService {
  private readonly limits: AssetServiceLimits;

  constructor(
    private readonly db: Database,
    private readonly storage: ObjectStoragePort,
    private readonly dispatcher: JobDispatcher,
    private readonly idempotencyStore: IdempotencyStore,
    limits: Partial<AssetServiceLimits> = {},
    private readonly hooks: AssetServiceHooks = {},
  ) {
    this.limits = { ...DEFAULT_LIMITS, ...limits };
    if (
      !Number.isInteger(this.limits.assetDeleteGraceDays) ||
      this.limits.assetDeleteGraceDays < 1 ||
      this.limits.assetDeleteGraceDays > MAX_ASSET_DELETE_GRACE_DAYS
    ) {
      throw new Error("Invalid asset delete grace days");
    }
  }

  private transactionDispatcher(tx: DbTransaction): JobDispatcher {
    if (!isTransactionalDispatcher(this.dispatcher)) {
      throw new Error("JOB_FAILED: transactional enqueue unavailable");
    }
    return this.dispatcher.withDatabaseExecutor(tx);
  }

  private async requireMembership(actorId: string, workspaceId: string): Promise<void> {
    const [member] = await this.db
      .select({ role: workspaceMembers.role })
      .from(workspaceMembers)
      .where(
        and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, actorId)),
      )
      .limit(1);
    if (!member) notFound();
    if (member.role !== "owner" && member.role !== "editor") notFound();
  }

  async create(
    actorId: string,
    workspaceId: string,
    input: CreateAssetInput,
    idempotencyKey: string,
  ): Promise<AssetResponse> {
    await this.requireMembership(actorId, workspaceId);

    assertWithinMaxBytes(input.declaredSize, this.limits.maxBytes);
    assertActualMatchesDeclared(input.body.byteLength, input.declaredSize);
    assertAllowedMimeType(input.declaredMimeType);
    assertNoMimeSpoof(input.declaredMimeType, input.body);
    const originalName = normalizeFilename(input.originalName);
    const sha256 = createHash("sha256").update(input.body).digest("hex");

    const requestHash = canonicalRequestHash({
      originalName,
      mimeType: input.declaredMimeType,
      size: input.declaredSize,
      sha256,
    });

    const lease = await this.idempotencyStore.begin({
      workspaceId,
      actorId,
      operation: "asset.create",
      key: idempotencyKey,
      requestHash,
      responseSchema: assetResponseSchema,
    });
    if (lease.kind === "replay") return lease.response;
    if (lease.kind === "conflict") throw new PublicApiError("OPERATION_REUSED", 409);
    if (lease.kind === "in_progress") throw new PublicApiError("OPERATION_REUSED", 409);

    const [{ total } = { total: 0 }] = await this.db
      .select({ total: sql<number>`coalesce(sum(${assets.sizeBytes}), 0)` })
      .from(assets)
      .where(and(eq(assets.workspaceId, workspaceId), isNull(assets.deletedAt)));
    assertWithinWorkspaceQuota(Number(total), input.declaredSize, this.limits.workspaceQuotaBytes);

    const assetId = randomUUID();
    const objectKey = buildOriginalObjectKey(workspaceId, assetId);
    let objectWritten = false;

    let row: Asset;
    try {
      row = await this.db.transaction(async (tx) => {
        await this.hooks.beforeDbInsert?.();
        const [inserted] = await tx
          .insert(assets)
          .values({
            id: assetId,
            workspaceId,
            ownerId: actorId,
            objectKey,
            originalName,
            mimeType: input.declaredMimeType,
            sizeBytes: input.declaredSize,
            sha256,
          })
          .returning();
        if (!inserted) throw new Error("Asset insert returned no row");
        await this.hooks.afterDbInsert?.();

        await this.hooks.beforeObjectPut?.();
        await this.storage.put({
          key: objectKey,
          body: input.body,
          contentType: input.declaredMimeType,
          contentLength: input.declaredSize,
          sha256,
        });
        objectWritten = true;
        await this.hooks.afterObjectPut?.();

        return inserted;
      });
    } catch (error) {
      if (objectWritten) {
        try {
          await this.storage.delete(objectKey);
        } catch {
          // Best-effort compensation; the orphan is also swept by asset.cleanup.
        }
      }
      throw error;
    }

    const response = toAssetResponse(row);
    await this.idempotencyStore.complete(lease.recordId, lease.leaseToken, response);
    return response;
  }

  private async loadAuthorized(actorId: string, assetId: string) {
    const rows = await this.db
      .select({ asset: assets, role: workspaceMembers.role })
      .from(assets)
      .innerJoin(
        workspaceMembers,
        and(
          eq(workspaceMembers.workspaceId, assets.workspaceId),
          eq(workspaceMembers.userId, actorId),
        ),
      )
      .where(and(eq(assets.id, assetId), isNull(assets.deletedAt)))
      .limit(1);
    const row = rows[0];
    if (!row) notFound();
    return row;
  }

  /**
   * Loads an asset for a mutation regardless of its current soft-delete
   * state (unlike loadAuthorized, which only ever returns active assets).
   * delete() needs this so that a replayed or racing delete against an
   * already-deleted asset can still resolve idempotently instead of 404ing.
   */
  private async loadForMutation(actorId: string, assetId: string) {
    const rows = await this.db
      .select({ asset: assets, role: workspaceMembers.role })
      .from(assets)
      .innerJoin(
        workspaceMembers,
        and(
          eq(workspaceMembers.workspaceId, assets.workspaceId),
          eq(workspaceMembers.userId, actorId),
        ),
      )
      .where(eq(assets.id, assetId))
      .limit(1);
    const row = rows[0];
    if (!row) notFound();
    return row;
  }

  async get(actorId: string, assetId: string): Promise<AssetResponse> {
    const { asset } = await this.loadAuthorized(actorId, assetId);
    return toAssetResponse(asset);
  }

  async getDownloadUrl(actorId: string, assetId: string): Promise<AssetResponse> {
    const { asset } = await this.loadAuthorized(actorId, assetId);
    const downloadUrl = await this.storage.createDownloadUrl(
      asset.objectKey,
      this.limits.downloadUrlExpirySeconds,
    );
    return { ...toAssetResponse(asset), downloadUrl };
  }

  async getThumbnailUrl(actorId: string, assetId: string): Promise<AssetResponse> {
    const { asset } = await this.loadAuthorized(actorId, assetId);
    if (asset.thumbnailStatus !== "ready" || !asset.thumbnailObjectKey) invalidAsset();
    const thumbnailUrl = await this.storage.createDownloadUrl(
      asset.thumbnailObjectKey,
      this.limits.downloadUrlExpirySeconds,
    );
    return { ...toAssetResponse(asset), thumbnailUrl };
  }

  async delete(actorId: string, assetId: string, idempotencyKey: string): Promise<AssetResponse> {
    const { asset, role } = await this.loadForMutation(actorId, assetId);
    if (role !== "owner" && role !== "editor") notFound();

    const requestHash = canonicalRequestHash({ assetId });
    const lease = await this.idempotencyStore.begin({
      workspaceId: asset.workspaceId,
      actorId,
      operation: "asset.delete",
      key: idempotencyKey,
      requestHash,
      responseSchema: assetResponseSchema,
    });
    if (lease.kind === "replay") return lease.response;
    if (lease.kind === "conflict") throw new PublicApiError("OPERATION_REUSED", 409);
    if (lease.kind === "in_progress") throw new PublicApiError("OPERATION_REUSED", 409);

    const current = await this.db.transaction(async (tx) => {
      const deletedAt = new Date();
      const [updated] = await tx
        .update(assets)
        .set({ deletedAt })
        .where(and(eq(assets.id, assetId), isNull(assets.deletedAt)))
        .returning();

      if (!updated) {
        // The row loaded before this transaction can be stale when a
        // differently-keyed delete wins the row lock. Reload inside the
        // transaction so this request records and replays the winner's
        // authoritative deletedAt value without emitting a second job.
        const [reloaded] = await tx.select().from(assets).where(eq(assets.id, assetId)).limit(1);
        if (!reloaded) notFound();
        return reloaded;
      }

      const runAt = new Date(
        deletedAt.getTime() + this.limits.assetDeleteGraceDays * MILLISECONDS_PER_DAY,
      );
      await this.transactionDispatcher(tx).enqueue({
        workspaceId: updated.workspaceId,
        type: "asset.cleanup",
        payload: { workspaceId: updated.workspaceId, assetId: updated.id },
        idempotencyKey: `asset-cleanup-${updated.id}`,
        runAt,
      });
      await this.hooks.afterDeleteJobInsert?.();

      return updated;
    });

    const response = toAssetResponse(current);
    await this.idempotencyStore.complete(lease.recordId, lease.leaseToken, response);
    return response;
  }
}
