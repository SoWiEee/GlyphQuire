import { JOB_TYPES, type JobType } from "@glyphquire/api-contract/jobs";
import type { JobHandler, JobRegistry } from "@glyphquire/queue";
import { createAssetsRegistry, type AssetJobRegistry } from "./registries/assets.js";
import {
  createMaintenanceRegistry,
  type MaintenanceJobRegistry,
} from "./registries/maintenance.js";
import { createSearchRegistry, type SearchJobRegistry } from "./registries/search.js";
import { createTransferRegistry, type TransferJobRegistry } from "./registries/transfer.js";
import type { JobRegistryDependencies } from "./registries/types.js";

export type { JobRegistryDependencies } from "./registries/types.js";
export {
  createStructuredMaintenanceAudit,
  createStructuredShareCleanupAudit,
} from "./registries/maintenance.js";
export type { MaintenanceAudit, MaintenanceAuditEvent } from "./registries/maintenance.js";

/**
 * Static keys are the activation contract. Handlers are bound only by
 * createJobRegistry after database, storage, search, and dispatcher readiness.
 */
const unboundHandler: JobHandler<JobType> = async () => {
  throw new Error("JOB_FAILED: worker handlers are not initialized");
};

export const jobRegistry: JobRegistry = Object.freeze({
  "search.index": unboundHandler,
  "search.remove": unboundHandler,
  "search.rebuild": unboundHandler,
  "asset.cleanup": unboundHandler,
  "asset.orphan_cleanup": unboundHandler,
  "asset.thumbnail": unboundHandler,
  import: unboundHandler,
  "import.cleanup": unboundHandler,
  export: unboundHandler,
  "export.expire": unboundHandler,
  "share.cleanup": unboundHandler,
  "version.retention": unboundHandler,
  "idempotency.cleanup": unboundHandler,
  "backup.verify": unboundHandler,
  "workspace.purge": unboundHandler,
  "account.purge": unboundHandler,
});

type BoundDomainRegistry = SearchJobRegistry &
  TransferJobRegistry &
  MaintenanceJobRegistry &
  AssetJobRegistry;

/** Bind the four domain registries to one ready dispatcher and infrastructure graph. */
export function createJobRegistry(dependencies: JobRegistryDependencies): JobRegistry {
  const domains: BoundDomainRegistry = {
    ...createSearchRegistry(dependencies),
    ...createTransferRegistry(dependencies),
    ...createMaintenanceRegistry(dependencies),
    ...createAssetsRegistry(dependencies),
  };
  const ordered = Object.fromEntries(JOB_TYPES.map((type) => [type, domains[type]])) as JobRegistry;
  return Object.freeze(ordered);
}
