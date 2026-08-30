import { pathToFileURL } from "node:url";
import {
  createDb,
  IdempotencyStore,
  workspaces,
  type Database,
  type IdempotencyStoreOptions,
} from "@glyphquire/database";
import {
  assertRegistryComplete,
  PostgresJobDispatcher,
  type JobDispatcher,
  type JobRegistry,
  type PostgresJobDispatcherOptions,
} from "@glyphquire/queue";
import type { DerivedSearchMutationPort, SearchPort } from "@glyphquire/search";
import {
  databaseEnvSchema,
  phase5EnvSchema,
  s3EnvSchema,
  type Phase5Env,
} from "@glyphquire/shared";
import type { ObjectStoragePort, S3EnvLike } from "@glyphquire/storage";
import { asc, sql } from "drizzle-orm";
import {
  DEFAULT_MAINTENANCE_INTERVAL_MS,
  WorkerRuntime,
  type WorkerRuntimeOptions,
} from "./runtime.js";
import type { BackupVerifier } from "./handlers/backup-verification.js";

export { WorkerRuntime, type WorkerRuntimeOptions } from "./runtime.js";

export type WorkerEnv = Phase5Env & S3EnvLike & { DATABASE_URL: string };

type MaybePromise<T> = T | Promise<T>;
type WorkerSearchPort = SearchPort & DerivedSearchMutationPort;

export interface WorkerFactories {
  createDatabase(url: string): MaybePromise<Database>;
  createStorage(environment: S3EnvLike): MaybePromise<ObjectStoragePort>;
  createSearch(database: Database): MaybePromise<WorkerSearchPort>;
  createDispatcher(
    database: Database,
    options: PostgresJobDispatcherOptions,
  ): MaybePromise<JobDispatcher>;
  createIdempotencyStore(
    database: Database,
    options: IdempotencyStoreOptions,
  ): MaybePromise<IdempotencyStore>;
  closeStorage(storage: ObjectStoragePort): Promise<void>;
  closeDatabase(database: Database): Promise<void>;
}

export interface StartWorkerOptions {
  source?: unknown;
  registry?: JobRegistry;
  factories?: WorkerFactories;
  runtime?: WorkerRuntimeOptions;
  signal?: AbortSignal;
  /**
   * Server-owned verifier for `backups/${backupId}/manifest.json`. Production
   * startup fails closed unless this is supplied with the built-in registry.
   */
  backupVerifier?: BackupVerifier;
}

export interface StartedWorker {
  env: WorkerEnv;
  runtime: WorkerRuntime;
  idempotencyStore: IdempotencyStore;
  storage: ObjectStoragePort;
  search: WorkerSearchPort;
  close(): Promise<void>;
}

const defaultFactories: WorkerFactories = {
  async createDatabase(url) {
    const database = createDb(url);
    try {
      await database.execute(sql`select 1`);
      return database;
    } catch {
      await database.$client.end().catch(() => undefined);
      throw new Error("JOB_FAILED: database initialization failed");
    }
  },
  async createStorage(environment) {
    const { createMinioObjectStorage } = await import("@glyphquire/storage");
    return createMinioObjectStorage(environment);
  },
  async createSearch(database) {
    const { PostgresSearchAdapter } = await import("@glyphquire/search");
    return new PostgresSearchAdapter(database);
  },
  createDispatcher: (database, options) => new PostgresJobDispatcher(database, options),
  createIdempotencyStore: (database, options) => new IdempotencyStore(database, options),
  closeStorage: async (storage) => storage.destroy(),
  closeDatabase: async (database) => database.$client.end(),
};

export function parseWorkerEnv(source: unknown): WorkerEnv {
  const database = databaseEnvSchema.safeParse(source);
  const storage = s3EnvSchema.safeParse(source);
  const phase5 = phase5EnvSchema.safeParse(source);
  if (!database.success || !storage.success || !phase5.success) {
    const issues = [
      ...(database.success ? [] : database.error.issues),
      ...(storage.success ? [] : storage.error.issues),
      ...(phase5.success ? [] : phase5.error.issues),
    ];
    const fields = [...new Set(issues.map((issue) => issue.path.join(".")))].sort();
    throw new Error(`Invalid environment variables: ${fields.join(", ")}`);
  }
  return { ...phase5.data, ...storage.data, ...database.data };
}

function throwIfStartupAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new Error("Worker startup aborted");
}

async function closeInitializedResources(
  factories: WorkerFactories,
  storage: ObjectStoragePort | undefined,
  database: Database | undefined,
): Promise<void> {
  let firstError: unknown;

  if (storage) {
    try {
      await factories.closeStorage(storage);
    } catch (error) {
      firstError = error;
    }
  }

  if (database) {
    try {
      await factories.closeDatabase(database);
    } catch (error) {
      firstError ??= error;
    }
  }

  if (firstError) throw firstError;
}

async function enqueueImportStagingCleanup(
  database: Database,
  dispatcher: JobDispatcher,
  batchSize: number,
  intervalMs: number,
  scheduledAt: number,
  signal: AbortSignal,
): Promise<void> {
  const maintenanceWindow = Math.floor(scheduledAt / intervalMs);
  const workspaceRows = await database
    .select({ id: workspaces.id })
    .from(workspaces)
    .orderBy(asc(workspaces.id));
  for (const workspace of workspaceRows) {
    if (signal.aborted) throw new Error("JOB_FAILED");
    await dispatcher.enqueue({
      workspaceId: workspace.id,
      type: "import.cleanup",
      payload: {
        workspaceId: workspace.id,
        scope: "staging",
        batchSize,
      },
      idempotencyKey: `import-cleanup-staging-window-${maintenanceWindow}`,
    });
  }
}

export async function startWorker(options: StartWorkerOptions = {}): Promise<StartedWorker> {
  const env = parseWorkerEnv(options.source === undefined ? process.env : options.source);
  // Keep the entrypoint importable before optional provider packages load so
  // invalid configuration is always reduced to the stable startup event.
  // The loaded registry itself remains the frozen static map in registry.ts.
  const registryModule = options.registry ? undefined : await import("./registry.js");
  const staticRegistry = options.registry ?? registryModule!.jobRegistry;
  assertRegistryComplete(staticRegistry);
  if (!options.registry && !options.backupVerifier) {
    throw new Error("JOB_FAILED: backup verifier is not configured");
  }

  const factories = options.factories ?? defaultFactories;
  const signal = options.signal ?? options.runtime?.signal;
  let database: Database | undefined;
  let storage: ObjectStoragePort | undefined;

  try {
    throwIfStartupAborted(signal);
    database = await factories.createDatabase(env.DATABASE_URL);
    throwIfStartupAborted(signal);
    storage = await factories.createStorage({
      S3_ENDPOINT: env.S3_ENDPOINT,
      S3_ACCESS_KEY: env.S3_ACCESS_KEY,
      S3_SECRET_KEY: env.S3_SECRET_KEY,
      S3_BUCKET: env.S3_BUCKET,
      S3_REGION: env.S3_REGION,
    });
    throwIfStartupAborted(signal);
    const search = await factories.createSearch(database);
    throwIfStartupAborted(signal);
    const dispatcher = await factories.createDispatcher(database, {
      lockTimeoutSeconds: env.JOB_LOCK_TIMEOUT_SECONDS,
      maxAttempts: env.JOB_MAX_ATTEMPTS,
      backoffBaseSeconds: env.JOB_BACKOFF_BASE_SECONDS,
      backoffCapSeconds: env.JOB_BACKOFF_CAP_SECONDS,
    });
    throwIfStartupAborted(signal);
    const idempotencyStore = await factories.createIdempotencyStore(database, {
      encryptionKey: env.IDEMPOTENCY_ENCRYPTION_KEY,
      leaseSeconds: env.IDEMPOTENCY_LEASE_SECONDS,
    });
    throwIfStartupAborted(signal);
    const registry = options.registry
      ? options.registry
      : registryModule!.createJobRegistry(
          {
            database,
            storage,
            search,
            environment: env,
            backupVerifier: options.backupVerifier,
          },
          staticRegistry,
        );
    assertRegistryComplete(registry);
    const readyDatabase = database;
    const maintenanceIntervalMs =
      options.runtime?.maintenanceIntervalMs ?? DEFAULT_MAINTENANCE_INTERVAL_MS;
    const runtime = new WorkerRuntime(dispatcher, registry, {
      ...options.runtime,
      maintenance: (scheduledAt, maintenanceSignal) =>
        enqueueImportStagingCleanup(
          readyDatabase,
          dispatcher,
          env.IMPORT_CLEANUP_BATCH_SIZE,
          maintenanceIntervalMs,
          scheduledAt,
          maintenanceSignal,
        ),
      maintenanceIntervalMs,
      signal,
    });
    let closeResult: Promise<void> | undefined;

    return {
      env,
      runtime,
      idempotencyStore,
      storage,
      search,
      close() {
        closeResult ??= runtime
          .shutdown()
          .then(() => closeInitializedResources(factories, storage, database));
        return closeResult;
      },
    };
  } catch {
    await closeInitializedResources(factories, storage, database).catch(() => undefined);
    throw new Error("JOB_FAILED: worker dependency initialization failed");
  }
}

export type WorkerProcessSignal = "SIGTERM" | "SIGINT";

export interface WorkerSignalSource {
  on(signal: WorkerProcessSignal, listener: () => void): void;
  off(signal: WorkerProcessSignal, listener: () => void): void;
}

export interface WorkerFailureLogEntry {
  event: "worker_startup_failed" | "worker_runtime_failed";
  code: "JOB_FAILED";
}

const processSignals: WorkerSignalSource = {
  on: (signal, listener) => process.on(signal, listener),
  off: (signal, listener) => process.off(signal, listener),
};

function emitFailureLog(
  log: (entry: WorkerFailureLogEntry) => void,
  event: WorkerFailureLogEntry["event"],
): void {
  try {
    log({ event, code: "JOB_FAILED" });
  } catch {
    // A logging outage cannot turn a failed worker into a successful one.
  }
}

export async function runWorkerEntrypoint(
  start: (signal: AbortSignal) => StartedWorker | Promise<StartedWorker> = (signal) =>
    startWorker({ signal }),
  log: (entry: WorkerFailureLogEntry) => void = (entry) => {
    console.error(JSON.stringify(entry));
  },
  signals: WorkerSignalSource = processSignals,
): Promise<number> {
  const controller = new AbortController();
  let started: StartedWorker | undefined;
  let runtimeStarted = false;
  let cleanupFailed = false;
  const handleSignal = () => {
    controller.abort();
    started?.runtime.stop();
  };

  signals.on("SIGTERM", handleSignal);
  signals.on("SIGINT", handleSignal);
  try {
    started = await start(controller.signal);
    runtimeStarted = true;
    if (!controller.signal.aborted) await started.runtime.run();
    await started.close();
    return 0;
  } catch {
    try {
      await started?.close();
    } catch {
      cleanupFailed = true;
    }
    if (controller.signal.aborted && !cleanupFailed) return 0;
    emitFailureLog(log, runtimeStarted ? "worker_runtime_failed" : "worker_startup_failed");
    return 1;
  } finally {
    signals.off("SIGTERM", handleSignal);
    signals.off("SIGINT", handleSignal);
  }
}

const executedPath = process.argv[1];
if (executedPath && import.meta.url === pathToFileURL(executedPath).href) {
  process.exitCode = await runWorkerEntrypoint();
}
