import { pathToFileURL } from "node:url";
import {
  createDb,
  IdempotencyStore,
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
import {
  databaseEnvSchema,
  phase5EnvSchema,
  type Phase5Env,
} from "@glyphquire/shared";
import { jobRegistry } from "./registry.js";
import { WorkerRuntime, type WorkerRuntimeOptions } from "./runtime.js";

export { jobRegistry } from "./registry.js";
export { WorkerRuntime, type WorkerRuntimeOptions } from "./runtime.js";

export type WorkerEnv = Phase5Env & { DATABASE_URL: string };

export interface WorkerFactories {
  createDatabase(url: string): Database;
  createDispatcher(database: Database, options: PostgresJobDispatcherOptions): JobDispatcher;
  createIdempotencyStore(database: Database, options: IdempotencyStoreOptions): IdempotencyStore;
}

export interface StartWorkerOptions {
  source?: unknown;
  registry?: JobRegistry;
  factories?: WorkerFactories;
  runtime?: WorkerRuntimeOptions;
}

export interface StartedWorker {
  env: WorkerEnv;
  runtime: WorkerRuntime;
  idempotencyStore: IdempotencyStore;
  close(): Promise<void>;
}

const defaultFactories: WorkerFactories = {
  createDatabase: createDb,
  createDispatcher: (database, options) => new PostgresJobDispatcher(database, options),
  createIdempotencyStore: (database, options) => new IdempotencyStore(database, options),
};

export function parseWorkerEnv(source: unknown): WorkerEnv {
  const database = databaseEnvSchema.safeParse(source);
  const phase5 = phase5EnvSchema.safeParse(source);
  if (!database.success || !phase5.success) {
    const issues = [
      ...(database.success ? [] : database.error.issues),
      ...(phase5.success ? [] : phase5.error.issues),
    ];
    const fields = [...new Set(issues.map((issue) => issue.path.join(".")))].sort();
    throw new Error(`Invalid environment variables: ${fields.join(", ")}`);
  }
  return { ...phase5.data, ...database.data };
}

export function startWorker(options: StartWorkerOptions = {}): StartedWorker {
  const env = parseWorkerEnv(options.source === undefined ? process.env : options.source);
  const registry = options.registry ?? jobRegistry;
  assertRegistryComplete(registry);

  const factories = options.factories ?? defaultFactories;
  const database = factories.createDatabase(env.DATABASE_URL);
  const dispatcher = factories.createDispatcher(database, {
    lockTimeoutSeconds: env.JOB_LOCK_TIMEOUT_SECONDS,
    maxAttempts: env.JOB_MAX_ATTEMPTS,
    backoffBaseSeconds: env.JOB_BACKOFF_BASE_SECONDS,
    backoffCapSeconds: env.JOB_BACKOFF_CAP_SECONDS,
  });
  const idempotencyStore = factories.createIdempotencyStore(database, {
    encryptionKey: env.IDEMPOTENCY_ENCRYPTION_KEY,
    leaseSeconds: env.IDEMPOTENCY_LEASE_SECONDS,
  });
  const runtime = new WorkerRuntime(dispatcher, registry, options.runtime);
  let closed = false;

  return {
    env,
    runtime,
    idempotencyStore,
    async close() {
      if (closed) return;
      closed = true;
      runtime.stop();
      await database.$client.end();
    },
  };
}

interface StartupFailureLogEntry {
  event: "worker_startup_failed";
  code: "JOB_FAILED";
}

export async function runWorkerEntrypoint(
  start: () => StartedWorker | Promise<StartedWorker> = startWorker,
  log: (entry: StartupFailureLogEntry) => void = (entry) => {
    console.error(JSON.stringify(entry));
  },
): Promise<number> {
  try {
    await start();
    return 0;
  } catch {
    try {
      log({ event: "worker_startup_failed", code: "JOB_FAILED" });
    } catch {
      // A logging outage cannot turn a failed startup into a successful one.
    }
    return 1;
  }
}

const executedPath = process.argv[1];
if (executedPath && import.meta.url === pathToFileURL(executedPath).href) {
  process.exitCode = await runWorkerEntrypoint();
}
