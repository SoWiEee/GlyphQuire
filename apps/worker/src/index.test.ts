import { describe, expect, it, vi } from "vitest";
import {
  P0_JOB_TYPES,
  type JobDispatcher,
  type JobRegistry,
  type PostgresJobDispatcherOptions,
} from "@glyphquire/queue";
import type { IdempotencyStoreOptions } from "@glyphquire/database";
import * as workerEntrypoint from "./index.js";
import type { WorkerRuntime } from "./runtime.js";

const encryptionKey = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

const baseEnvironment = {
  DATABASE_URL: "postgresql://worker:secret@localhost:5432/glyphquire",
  IDEMPOTENCY_ENCRYPTION_KEY: encryptionKey,
  BACKUP_ENCRYPTION_KEY: encryptionKey,
};

interface WorkerFactories {
  createDatabase(url: string): unknown;
  createDispatcher(database: unknown, options: PostgresJobDispatcherOptions): JobDispatcher;
  createIdempotencyStore(database: unknown, options: IdempotencyStoreOptions): unknown;
}

interface StartWorkerOptions {
  source: unknown;
  registry: JobRegistry;
  factories: WorkerFactories;
}

interface StartedWorker {
  runtime: WorkerRuntime;
  idempotencyStore: unknown;
}

type StartWorker = (options: StartWorkerOptions) => StartedWorker;

function getStartWorker(): StartWorker {
  return (workerEntrypoint as unknown as { startWorker: StartWorker }).startWorker;
}

function completeRegistry(): JobRegistry {
  return Object.fromEntries(P0_JOB_TYPES.map((type) => [type, vi.fn()])) as JobRegistry;
}

function fakeDispatcher(): JobDispatcher {
  return {
    enqueue: vi.fn(),
    dispatchBatch: vi.fn().mockResolvedValue({
      claimed: 0,
      succeeded: 0,
      retried: 0,
      deadLettered: 0,
    }),
  };
}

function fakeFactories() {
  const database = { marker: "database" };
  const dispatcher = fakeDispatcher();
  const idempotencyStore = { marker: "idempotency" };
  const factories: WorkerFactories = {
    createDatabase: vi.fn(() => database),
    createDispatcher: vi.fn(() => dispatcher),
    createIdempotencyStore: vi.fn(() => idempotencyStore),
  };
  return { database, dispatcher, idempotencyStore, factories };
}

describe("production worker startup", () => {
  it.each([
    ["IDEMPOTENCY_ENCRYPTION_KEY", "not-a-valid-key"],
    ["THUMBNAIL_MAX_PIXELS", "40000001"],
  ])("rejects invalid %s before initializing dependencies", (field, value) => {
    const { factories } = fakeFactories();

    expect(() =>
      getStartWorker()({
        source: { ...baseEnvironment, [field]: value },
        registry: completeRegistry(),
        factories,
      }),
    ).toThrow(new RegExp(`Invalid environment variables: ${field}`));

    expect(factories.createDatabase).not.toHaveBeenCalled();
    expect(factories.createDispatcher).not.toHaveBeenCalled();
    expect(factories.createIdempotencyStore).not.toHaveBeenCalled();
  });

  it("wires only validated job and lease settings into dependencies", () => {
    const { database, dispatcher, idempotencyStore, factories } = fakeFactories();

    const started = getStartWorker()({
      source: {
        ...baseEnvironment,
        IDEMPOTENCY_LEASE_SECONDS: "42",
        JOB_LOCK_TIMEOUT_SECONDS: "17",
        JOB_MAX_ATTEMPTS: "7",
        JOB_BACKOFF_BASE_SECONDS: "3",
        JOB_BACKOFF_CAP_SECONDS: "29",
      },
      registry: completeRegistry(),
      factories,
    });

    expect(factories.createDatabase).toHaveBeenCalledWith(baseEnvironment.DATABASE_URL);
    expect(factories.createDispatcher).toHaveBeenCalledWith(database, {
      lockTimeoutSeconds: 17,
      maxAttempts: 7,
      backoffBaseSeconds: 3,
      backoffCapSeconds: 29,
    });
    expect(factories.createIdempotencyStore).toHaveBeenCalledWith(database, {
      encryptionKey,
      leaseSeconds: 42,
    });
    expect(started.idempotencyStore).toBe(idempotencyStore);
    expect(started.runtime).toBeInstanceOf(workerEntrypoint.WorkerRuntime);
    expect(started.runtime).toHaveProperty("dispatcher", dispatcher);
  });
});
