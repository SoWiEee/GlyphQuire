import {
  createPostgresShareCleanupHandler,
  type ShareCleanupAudit,
  type ShareCleanupAuditEvent,
} from "../handlers/share-cleanup.js";
import {
  createVersionRetentionHandler,
  PostgresVersionRetentionRepository,
  type VersionRetentionAudit,
  type VersionRetentionAuditEvent,
} from "../handlers/version-retention.js";
import type {
  AssetOrphanCleanupAudit,
  AssetOrphanCleanupAuditEvent,
} from "../handlers/asset-orphan-cleanup.js";
import {
  createIdempotencyCleanupHandler,
  PostgresIdempotencyCleanupRepository,
} from "../handlers/idempotency-cleanup.js";
import {
  createBackupVerificationHandler,
  failClosedBackupVerifier,
} from "../handlers/backup-verification.js";
import {
  createWorkspacePurgeHandler,
  PostgresDestructiveBackupGate,
  PostgresWorkspacePurgeRepository,
} from "../handlers/workspace-purge.js";
import {
  createAccountPurgeHandler,
  PostgresAccountPurgeRepository,
} from "../handlers/account-purge.js";
import type { DomainJobRegistry, JobRegistryDependencies } from "./types.js";

type AuditWriteCallback = (error?: Error | null) => void;
type AuditWriter = (chunk: string, callback: AuditWriteCallback) => boolean | void;

export type MaintenanceAuditEvent = AssetOrphanCleanupAuditEvent | VersionRetentionAuditEvent;
export type MaintenanceAudit = AssetOrphanCleanupAudit & VersionRetentionAudit;

export function createStructuredShareCleanupAudit(
  writer: AuditWriter = (chunk, callback) => process.stderr.write(chunk, callback),
): ShareCleanupAudit {
  return Object.freeze({
    record(event: ShareCleanupAuditEvent) {
      const chunk = `${JSON.stringify(event)}\n`;
      return new Promise<void>((resolve, reject) => {
        try {
          writer(chunk, (error) => (error ? reject(error) : resolve()));
        } catch (error) {
          reject(error);
        }
      });
    },
  });
}

export function createStructuredMaintenanceAudit(
  writer: AuditWriter = (chunk, callback) => process.stderr.write(chunk, callback),
): MaintenanceAudit {
  return Object.freeze({
    record(event: MaintenanceAuditEvent) {
      const chunk = `${JSON.stringify(event)}\n`;
      return new Promise<void>((resolve, reject) => {
        try {
          writer(chunk, (error) => (error ? reject(error) : resolve()));
        } catch (error) {
          reject(error);
        }
      });
    },
  });
}

const structuredShareCleanupAudit = createStructuredShareCleanupAudit();
const structuredMaintenanceAudit = createStructuredMaintenanceAudit();

export type MaintenanceJobRegistry = DomainJobRegistry<
  | "share.cleanup"
  | "version.retention"
  | "idempotency.cleanup"
  | "backup.verify"
  | "workspace.purge"
  | "account.purge"
>;

export function createMaintenanceRegistry(
  dependencies: JobRegistryDependencies,
): MaintenanceJobRegistry {
  const backupGate =
    dependencies.destructiveBackupGate ?? new PostgresDestructiveBackupGate(dependencies.database);
  return {
    "share.cleanup": createPostgresShareCleanupHandler({
      database: dependencies.database,
      dispatcher: dependencies.dispatcher,
      audit: structuredShareCleanupAudit,
      graceSeconds: dependencies.environment.SHARE_DELETE_GRACE_SECONDS,
    }),
    "version.retention": createVersionRetentionHandler({
      repository: new PostgresVersionRetentionRepository(dependencies.database),
      dispatcher: dependencies.dispatcher,
      audit: structuredMaintenanceAudit,
      retentionDays: dependencies.environment.VERSION_RETENTION_DAYS,
    }),
    "idempotency.cleanup": createIdempotencyCleanupHandler({
      repository: new PostgresIdempotencyCleanupRepository(dependencies.database),
      dispatcher: dependencies.dispatcher,
      retentionDays: dependencies.environment.IDEMPOTENCY_RETENTION_DAYS,
    }),
    "backup.verify": createBackupVerificationHandler({
      verifier: dependencies.backupVerifier ?? failClosedBackupVerifier,
    }),
    "workspace.purge": createWorkspacePurgeHandler({
      repository: new PostgresWorkspacePurgeRepository(dependencies.database),
      storage: dependencies.storage,
      backupGate,
    }),
    "account.purge": createAccountPurgeHandler({
      repository: new PostgresAccountPurgeRepository(dependencies.database),
      backupGate,
    }),
  };
}
