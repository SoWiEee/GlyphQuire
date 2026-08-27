import type { AssetCleanupPayload, JobEnvelope } from "@glyphquire/api-contract/jobs";
import { assets, type Database } from "@glyphquire/database";
import type { JobHandler } from "@glyphquire/queue";
import type { ObjectStoragePort } from "@glyphquire/storage";
import { eq } from "drizzle-orm";

const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1_000;
const MAX_GRACE_DAYS = 3_650;

export interface AssetCleanupRow {
  assetId: string;
  workspaceId: string;
  deletedAt: Date | null;
}

export interface AssetCleanupRepository {
  loadAsset(assetId: string): Promise<AssetCleanupRow | undefined>;
}

export class PostgresAssetCleanupRepository implements AssetCleanupRepository {
  constructor(private readonly db: Database) {}

  async loadAsset(assetId: string): Promise<AssetCleanupRow | undefined> {
    const [row] = await this.db
      .select({
        assetId: assets.id,
        workspaceId: assets.workspaceId,
        deletedAt: assets.deletedAt,
      })
      .from(assets)
      .where(eq(assets.id, assetId))
      .limit(1);
    return row;
  }
}

export interface AssetCleanupHandlerDeps {
  repository: AssetCleanupRepository;
  storage: ObjectStoragePort;
  graceDays: number;
  clock?: () => number;
}

export function createAssetCleanupHandler(
  deps: AssetCleanupHandlerDeps,
): JobHandler<"asset.cleanup"> {
  if (!Number.isInteger(deps.graceDays) || deps.graceDays < 1 || deps.graceDays > MAX_GRACE_DAYS) {
    throw new Error("Invalid asset cleanup grace days");
  }

  const clock = deps.clock ?? Date.now;
  const graceMilliseconds = deps.graceDays * MILLISECONDS_PER_DAY;

  return async (job: JobEnvelope<"asset.cleanup">) => {
    const payload: AssetCleanupPayload = job.payload;
    let asset: AssetCleanupRow | undefined;
    try {
      asset = await deps.repository.loadAsset(payload.assetId);
    } catch {
      throw new Error("JOB_FAILED");
    }

    if (!asset) return;
    if (asset.assetId !== payload.assetId || asset.workspaceId !== payload.workspaceId) {
      throw new Error("JOB_INVALID: asset.cleanup source mismatch");
    }
    if (asset.deletedAt === null) return;

    const now = clock();
    if (!Number.isFinite(now)) throw new Error("JOB_FAILED");
    const deletedAt = asset.deletedAt.getTime();
    if (!Number.isFinite(deletedAt)) throw new Error("JOB_FAILED");
    if (deletedAt > now - graceMilliseconds) return;

    const objectKey = `workspace/${asset.workspaceId}/assets/${asset.assetId}/original`;
    try {
      await deps.storage.delete(objectKey);
    } catch {
      throw new Error("JOB_FAILED");
    }
  };
}
