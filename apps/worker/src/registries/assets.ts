import {
  createAssetCleanupHandler,
  PostgresAssetCleanupRepository,
} from "../handlers/asset-cleanup.js";
import { PostgresAssetThumbnailRepository } from "../handlers/asset-thumbnail-repository.js";
import { createAssetThumbnailHandler } from "../handlers/asset-thumbnail.js";
import {
  createAssetOrphanCleanupHandler,
  PostgresAssetOrphanCleanupRepository,
} from "../handlers/asset-orphan-cleanup.js";
import { createStructuredMaintenanceAudit } from "./maintenance.js";
import type { DomainJobRegistry, JobRegistryDependencies } from "./types.js";

export type AssetJobRegistry = DomainJobRegistry<
  "asset.cleanup" | "asset.orphan_cleanup" | "asset.thumbnail"
>;

export function createAssetsRegistry(dependencies: JobRegistryDependencies): AssetJobRegistry {
  return {
    "asset.cleanup": createAssetCleanupHandler({
      repository: new PostgresAssetCleanupRepository(dependencies.database),
      storage: dependencies.storage,
      graceDays: dependencies.environment.ASSET_DELETE_GRACE_DAYS,
    }),
    "asset.orphan_cleanup": createAssetOrphanCleanupHandler({
      repository: new PostgresAssetOrphanCleanupRepository(dependencies.database),
      storage: dependencies.storage,
      dispatcher: dependencies.dispatcher,
      audit: createStructuredMaintenanceAudit(),
      graceDays: dependencies.environment.ASSET_DELETE_GRACE_DAYS,
    }),
    "asset.thumbnail": createAssetThumbnailHandler({
      repository: new PostgresAssetThumbnailRepository(dependencies.database),
      storage: dependencies.storage,
      limits: {
        maxSourceBytes: dependencies.environment.THUMBNAIL_MAX_SOURCE_BYTES,
        maxPixels: dependencies.environment.THUMBNAIL_MAX_PIXELS,
        maxOutputBytes: dependencies.environment.THUMBNAIL_MAX_OUTPUT_BYTES,
      },
      buildThumbnailObjectKey(workspaceId, assetId) {
        return `workspace/${workspaceId}/assets/${assetId}/thumbnail.webp`;
      },
    }),
  };
}
