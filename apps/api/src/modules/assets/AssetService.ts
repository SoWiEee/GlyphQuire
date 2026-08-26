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
import type { JobDispatcher } from "@glyphquire/queue";
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
}

const DEFAULT_LIMITS: AssetServiceLimits = {
  maxBytes: 5 * 1024 * 1024,
  workspaceQuotaBytes: 100 * 1024 * 1024,
  downloadUrlExpirySeconds: 300,
};

/**
 * Fault-injection hooks for exercising create-flow atomicity in tests. The
 * production create() order is: insert the metadata row inside a
 * transaction, then write the object; a failure writing the object rolls the
 * transaction back automatically (nothing external was written). A failure
 * that occurs *after* the object write (surfaced via afterObjectPut) still
 * rolls the DB transaction back, so the service explicitly compensates by
 * deleting the now-orphaned object.
 */
export interface AssetServiceHooks {
  beforeDbInsert?(): void | Promise<void>;
  afterDbInsert?(): void | Promise<void>;
  beforeObjectPut?(): void | Promise<void>;
  afterObjectPut?(): void | Promise<void>;
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
        and(eq(workspaceMembers.workspaceId, assets.workspaceId), eq(workspaceMembers.userId, actorId)),
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
        and(eq(workspaceMembers.workspaceId, assets.workspaceId), eq(workspaceMembers.userId, actorId)),
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

    const [updated] = await this.db
      .update(assets)
      .set({ deletedAt: new Date() })
      .where(and(eq(assets.id, assetId), isNull(assets.deletedAt)))
      .returning();

    if (updated) {
      await this.dispatcher.enqueue({
        workspaceId: asset.workspaceId,
        type: "asset.cleanup",
        payload: { workspaceId: asset.workspaceId, assetId },
        idempotencyKey: `asset-cleanup-${assetId}`,
      });
    }

    // If a differently-keyed request already deleted this asset first,
    // `updated` is undefined; fall back to the row loaded above (which
    // already reflects the deleted state) so the response stays idempotent
    // without a duplicate cleanup enqueue.
    const response = toAssetResponse(updated ?? asset);
    await this.idempotencyStore.complete(lease.recordId, lease.leaseToken, response);
    return response;
  }
}
