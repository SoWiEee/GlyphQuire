import { createImportHandler } from "../handlers/import.js";
import { createImportCleanupHandler as createImportCleanupJobHandler } from "../handlers/import-cleanup.js";
import { createExportHandler } from "../handlers/export.js";
import {
  createExportExpiryHandler,
  PostgresExportExpiryRepository,
} from "../handlers/export-expiry.js";
import type { DomainJobRegistry, JobRegistryDependencies } from "./types.js";

export type TransferJobRegistry = DomainJobRegistry<
  "import" | "import.cleanup" | "export" | "export.expire"
>;

export function createTransferRegistry(dependencies: JobRegistryDependencies): TransferJobRegistry {
  return {
    import: createImportHandler({
      database: dependencies.database,
      storage: dependencies.storage,
      maxAssetBytes: dependencies.environment.ASSET_MAX_BYTES,
      workspaceQuotaBytes: dependencies.environment.ASSET_WORKSPACE_QUOTA_BYTES,
      stagingGraceSeconds: dependencies.environment.IMPORT_STAGING_GRACE_SECONDS,
      leaseSeconds: dependencies.environment.JOB_LOCK_TIMEOUT_SECONDS,
    }),
    "import.cleanup": createImportCleanupJobHandler({
      database: dependencies.database,
      storage: dependencies.storage,
      graceSeconds: dependencies.environment.IMPORT_STAGING_GRACE_SECONDS,
      leaseSeconds: dependencies.environment.JOB_LOCK_TIMEOUT_SECONDS,
    }),
    export: createExportHandler({
      database: dependencies.database,
      storage: dependencies.storage,
    }),
    "export.expire": createExportExpiryHandler({
      repository: new PostgresExportExpiryRepository(dependencies.database),
      storage: dependencies.storage,
      dispatcher: dependencies.dispatcher,
    }),
  };
}
