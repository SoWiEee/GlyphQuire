import type { JobType } from "@glyphquire/api-contract/jobs";
import type { Database } from "@glyphquire/database";
import type { JobHandler, JobRegistry } from "@glyphquire/queue";
import type { DerivedSearchMutationPort, SearchPort } from "@glyphquire/search";
import type { Phase5Env } from "@glyphquire/shared";
import type { ObjectStoragePort } from "@glyphquire/storage";
import {
  createAssetCleanupHandler,
  PostgresAssetCleanupRepository,
} from "./handlers/asset-cleanup.js";
import { PostgresAssetThumbnailRepository } from "./handlers/asset-thumbnail-repository.js";
import { createAssetThumbnailHandler } from "./handlers/asset-thumbnail.js";
import {
  createSearchIndexHandler,
  PostgresSearchIndexRepository,
} from "./handlers/search-index.js";
import {
  createSearchRemoveHandler,
  PostgresSearchRemoveRepository,
} from "./handlers/search-remove.js";
import {
  createSearchRebuildNoteHandler,
  PostgresSearchRebuildNoteRepository,
} from "./handlers/search-rebuild-note.js";
import { createImportCleanupHandler } from "./handlers/import-cleanup.js";
import { createImportHandler } from "./handlers/import.js";
import { createExportHandler } from "./handlers/export.js";
import {
  createPostgresShareCleanupHandler,
  type ShareCleanupAudit,
  type ShareCleanupAuditEvent,
} from "./handlers/share-cleanup.js";

type AuditWriteCallback = (error?: Error | null) => void;
type AuditWriter = (chunk: string, callback: AuditWriteCallback) => boolean | void;

/**
 * Write audit records only after stderr acknowledges the write. Console APIs
 * intentionally hide stream callback failures, which would otherwise let a
 * cleanup transaction commit without durable audit evidence.
 */
export function createStructuredShareCleanupAudit(
  writer: AuditWriter = (chunk, callback) => process.stderr.write(chunk, callback),
): ShareCleanupAudit {
  return Object.freeze({
    record(event: ShareCleanupAuditEvent) {
      const chunk = `${JSON.stringify(event)}\n`;
      return new Promise<void>((resolve, reject) => {
        try {
          writer(chunk, (error) => {
            if (error) reject(error);
            else resolve();
          });
        } catch (error) {
          reject(error);
        }
      });
    },
  });
}

const structuredShareCleanupAudit = createStructuredShareCleanupAudit();

export interface JobRegistryDependencies {
  database: Database;
  storage: ObjectStoragePort;
  search: SearchPort & DerivedSearchMutationPort;
  environment: Phase5Env;
}

/**
 * The staged registry remains a frozen, static map. Its handlers deliberately
 * fail until startup has injected the ready dependencies through
 * createJobRegistry, so importing this module cannot create a second client
 * or accidentally run a handler against process environment state.
 */
const unboundHandler: JobHandler<JobType> = async () => {
  throw new Error("JOB_FAILED: worker handlers are not initialized");
};

export const jobRegistry: JobRegistry = Object.freeze({
  "search.index": unboundHandler,
  "search.remove": unboundHandler,
  "search.rebuild": unboundHandler,
  "asset.cleanup": unboundHandler,
  "asset.thumbnail": unboundHandler,
  import: unboundHandler,
  "import.cleanup": unboundHandler,
  export: unboundHandler,
  "share.cleanup": unboundHandler,
});

/**
 * Binds every reviewed handler to the exact resources that completed worker
 * readiness. The optional base registry keeps later static handoffs intact:
 * only the handlers owned by this worker slice are replaced here.
 */
export function createJobRegistry(
  dependencies: JobRegistryDependencies,
  baseRegistry: JobRegistry = jobRegistry,
): JobRegistry {
  const searchIndex = createSearchIndexHandler({
    repository: new PostgresSearchIndexRepository(dependencies.database),
    searchPort: dependencies.search,
  });

  const searchRemove = createSearchRemoveHandler({
    repository: new PostgresSearchRemoveRepository(dependencies.database),
    searchPort: dependencies.search,
  });

  const searchRebuildNote = createSearchRebuildNoteHandler({
    repository: new PostgresSearchRebuildNoteRepository(dependencies.database),
    searchPort: dependencies.search,
  });

  const assetCleanup = createAssetCleanupHandler({
    repository: new PostgresAssetCleanupRepository(dependencies.database),
    storage: dependencies.storage,
    graceDays: dependencies.environment.ASSET_DELETE_GRACE_DAYS,
  });

  const assetThumbnail = createAssetThumbnailHandler({
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
  });

  const importNote = createImportHandler({
    database: dependencies.database,
    storage: dependencies.storage,
    maxAssetBytes: dependencies.environment.ASSET_MAX_BYTES,
    workspaceQuotaBytes: dependencies.environment.ASSET_WORKSPACE_QUOTA_BYTES,
    stagingGraceSeconds: dependencies.environment.IMPORT_STAGING_GRACE_SECONDS,
    leaseSeconds: dependencies.environment.JOB_LOCK_TIMEOUT_SECONDS,
  });

  const importCleanup = createImportCleanupHandler({
    database: dependencies.database,
    storage: dependencies.storage,
    graceSeconds: dependencies.environment.IMPORT_STAGING_GRACE_SECONDS,
    leaseSeconds: dependencies.environment.JOB_LOCK_TIMEOUT_SECONDS,
  });

  const exportArtifact = createExportHandler({
    database: dependencies.database,
    storage: dependencies.storage,
  });

  const shareCleanup = createPostgresShareCleanupHandler({
    database: dependencies.database,
    audit: structuredShareCleanupAudit,
    graceSeconds: dependencies.environment.SHARE_DELETE_GRACE_SECONDS,
  });

  return Object.freeze({
    ...baseRegistry,
    "search.index": searchIndex,
    "search.remove": searchRemove,
    "search.rebuild": searchRebuildNote,
    "asset.cleanup": assetCleanup,
    "asset.thumbnail": assetThumbnail,
    import: importNote,
    "import.cleanup": importCleanup,
    export: exportArtifact,
    "share.cleanup": shareCleanup,
  });
}
