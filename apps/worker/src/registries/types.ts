import type { JobType } from "@glyphquire/api-contract/jobs";
import type { JobHandler, JobRegistry, JobDispatcher } from "@glyphquire/queue";
import type { Database } from "@glyphquire/database";
import type { DerivedSearchMutationPort, SearchPort } from "@glyphquire/search";
import type { WorkspaceServicesEnv } from "@glyphquire/shared";
import type { ObjectStoragePort } from "@glyphquire/storage";
import type { BackupVerifier } from "../handlers/backup-verification.js";
import type { DestructiveBackupGate } from "../handlers/workspace-purge.js";

export interface JobRegistryDependencies {
  readonly database: Database;
  readonly storage: ObjectStoragePort;
  readonly search: SearchPort & DerivedSearchMutationPort;
  readonly dispatcher: JobDispatcher;
  readonly environment: WorkspaceServicesEnv;
  readonly backupVerifier?: BackupVerifier;
  readonly destructiveBackupGate?: DestructiveBackupGate;
}

export type DomainJobRegistry<TTypes extends JobType> = {
  readonly [K in TTypes]: JobRegistry[K];
};

export type AnyDomainJobRegistry = Partial<JobRegistry>;

export type HandlerFor<TType extends JobType> = JobHandler<TType>;
