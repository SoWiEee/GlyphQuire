import { describe, expect, it, vi } from "vitest";
import type { Database } from "@glyphquire/database";
import type { IdempotencyStoreOptions } from "@glyphquire/database";
import {
  P0_JOB_TYPES,
  type JobDispatcher,
  type JobRegistry,
  type PostgresJobDispatcherOptions,
} from "@glyphquire/queue";
import type { DerivedSearchMutationPort, SearchPort } from "@glyphquire/search";
import type { ObjectStoragePort, S3EnvLike } from "@glyphquire/storage";
import * as workerEntrypoint from "./index.js";
import { createJobRegistry } from "./registry.js";
import { WorkerRuntime, type WorkerRuntimeOptions } from "./runtime.js";

const encryptionKey = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

const baseEnvironment = {
  DATABASE_URL: "postgresql://worker:secret@localhost:5432/glyphquire",
  S3_ENDPOINT: "http://localhost:9000",
  S3_ACCESS_KEY: "worker-access-key",
  S3_SECRET_KEY: "worker-storage-secret",
  S3_BUCKET: "glyphquire-assets",
  S3_REGION: "us-east-1",
  IDEMPOTENCY_ENCRYPTION_KEY: encryptionKey,
  BACKUP_ENCRYPTION_KEY: encryptionKey,
};

interface WorkerFactories {
  createDatabase(url: string): unknown | Promise<unknown>;
  createStorage(environment: S3EnvLike): ObjectStoragePort | Promise<ObjectStoragePort>;
  createSearch(database: unknown): SearchPort | Promise<SearchPort>;
  createDispatcher(
    database: unknown,
    options: PostgresJobDispatcherOptions,
  ): JobDispatcher | Promise<JobDispatcher>;
  createIdempotencyStore(
    database: unknown,
    options: IdempotencyStoreOptions,
  ): unknown | Promise<unknown>;
  closeStorage(storage: ObjectStoragePort): Promise<void>;
  closeDatabase(database: unknown): Promise<void>;
}

interface StartWorkerOptions {
  source: unknown;
  registry?: JobRegistry;
  factories: WorkerFactories;
  runtime?: WorkerRuntimeOptions;
  signal?: AbortSignal;
}

interface StartedWorker {
  runtime: WorkerRuntime;
  idempotencyStore: unknown;
  storage: ObjectStoragePort;
  search: SearchPort;
  close(): Promise<void>;
}

type StartWorker = (options: StartWorkerOptions) => Promise<StartedWorker>;

type WorkerSignal = "SIGTERM" | "SIGINT";

interface WorkerSignalSource {
  on(signal: WorkerSignal, listener: () => void): void;
  off(signal: WorkerSignal, listener: () => void): void;
}

interface WorkerLogEntry {
  event: "worker_startup_failed" | "worker_runtime_failed";
  code: "JOB_FAILED";
}

type RunWorkerEntrypoint = (
  start: (signal: AbortSignal) => StartedWorker | Promise<StartedWorker>,
  log: (entry: WorkerLogEntry) => void,
  signals: WorkerSignalSource,
) => Promise<number>;

function getStartWorker(): StartWorker {
  return (workerEntrypoint as unknown as { startWorker: StartWorker }).startWorker;
}

function getRunWorkerEntrypoint(): RunWorkerEntrypoint {
  return (workerEntrypoint as unknown as { runWorkerEntrypoint: RunWorkerEntrypoint })
    .runWorkerEntrypoint;
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

function fakeStorage(): ObjectStoragePort {
  return {
    put: vi.fn(),
    get: vi.fn(),
    delete: vi.fn(),
    createDownloadUrl: vi.fn(),
    destroy: vi.fn(),
  };
}

function fakeSearch(): SearchPort & DerivedSearchMutationPort {
  return {
    indexNote: vi.fn(),
    removeNote: vi.fn(),
    indexNoteIfCurrent: vi.fn(),
    removeNoteIfCurrent: vi.fn(),
    removeNoteIfMissing: vi.fn(),
    search: vi.fn(),
  };
}

function fakeFactories() {
  const databaseEnd = vi.fn().mockResolvedValue(undefined);
  const workspaceRows: { id: string }[] = [];
  const database = {
    marker: "database",
    $client: { end: databaseEnd },
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        orderBy: vi.fn(async () => workspaceRows),
      })),
    })),
  };
  const storage = fakeStorage();
  const search = fakeSearch();
  const dispatcher = fakeDispatcher();
  const idempotencyStore = { marker: "idempotency" };
  const closeOrder: string[] = [];
  const factories: WorkerFactories = {
    createDatabase: vi.fn(() => database),
    createStorage: vi.fn(() => storage),
    createSearch: vi.fn(() => search),
    createDispatcher: vi.fn(() => dispatcher),
    createIdempotencyStore: vi.fn(() => idempotencyStore),
    closeStorage: vi.fn(async (resource) => {
      closeOrder.push("storage");
      resource.destroy();
    }),
    closeDatabase: vi.fn(async () => {
      closeOrder.push("database");
      await databaseEnd();
    }),
  };
  return {
    database,
    databaseEnd,
    workspaceRows,
    storage,
    search,
    dispatcher,
    idempotencyStore,
    closeOrder,
    factories,
  };
}

function createSignalSource(): WorkerSignalSource & { emit(signal: WorkerSignal): void } {
  const listeners = new Map<WorkerSignal, Set<() => void>>();
  return {
    on: vi.fn((signal: WorkerSignal, listener: () => void) => {
      const registered = listeners.get(signal) ?? new Set();
      registered.add(listener);
      listeners.set(signal, registered);
    }),
    off: vi.fn((signal: WorkerSignal, listener: () => void) => {
      listeners.get(signal)?.delete(listener);
    }),
    emit(signal: WorkerSignal) {
      for (const listener of listeners.get(signal) ?? []) listener();
    },
  };
}

function abortableWait(_milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe("production worker startup", () => {
  it.each([
    ["IDEMPOTENCY_ENCRYPTION_KEY", "not-a-valid-key"],
    ["THUMBNAIL_MAX_PIXELS", "40000001"],
    ["S3_SECRET_KEY", ""],
  ])("rejects invalid %s before initializing dependencies", async (field, value) => {
    const { factories } = fakeFactories();

    await expect(
      Promise.resolve().then(() =>
        getStartWorker()({
          source: { ...baseEnvironment, [field]: value },
          registry: completeRegistry(),
          factories,
        }),
      ),
    ).rejects.toThrow(new RegExp(`Invalid environment variables: ${field}`));

    expect(factories.createDatabase).not.toHaveBeenCalled();
    expect(factories.createStorage).not.toHaveBeenCalled();
    expect(factories.createSearch).not.toHaveBeenCalled();
    expect(factories.createDispatcher).not.toHaveBeenCalled();
    expect(factories.createIdempotencyStore).not.toHaveBeenCalled();
  });

  it("wires only validated settings into every dependency before returning", async () => {
    const { database, storage, search, dispatcher, idempotencyStore, factories } = fakeFactories();

    const started = await getStartWorker()({
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
    expect(factories.createStorage).toHaveBeenCalledWith({
      S3_ENDPOINT: baseEnvironment.S3_ENDPOINT,
      S3_ACCESS_KEY: baseEnvironment.S3_ACCESS_KEY,
      S3_SECRET_KEY: baseEnvironment.S3_SECRET_KEY,
      S3_BUCKET: baseEnvironment.S3_BUCKET,
      S3_REGION: baseEnvironment.S3_REGION,
    });
    expect(factories.createSearch).toHaveBeenCalledWith(database);
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
    expect(started.storage).toBe(storage);
    expect(started.search).toBe(search);
    expect(started.idempotencyStore).toBe(idempotencyStore);
    expect(started.runtime).toBeInstanceOf(workerEntrypoint.WorkerRuntime);
    expect(started.runtime).toHaveProperty("dispatcher", dispatcher);
    await started.close();
  });

  it("enqueues an initial idempotent staging cleanup scan before the first claim", async () => {
    const workspaceId = "11111111-1111-4111-8111-111111111111";
    const controller = new AbortController();
    const { dispatcher, factories, workspaceRows } = fakeFactories();
    workspaceRows.push({ id: workspaceId });
    const started = await getStartWorker()({
      source: { ...baseEnvironment, IMPORT_CLEANUP_BATCH_SIZE: "37" },
      registry: completeRegistry(),
      factories,
      runtime: {
        clock: () => 10_500,
        maintenanceIntervalMs: 1_000,
        pollIntervalMs: 1,
        wait: abortableWait,
      },
      signal: controller.signal,
    });

    const running = started.runtime.run();
    await vi.waitFor(() => expect(dispatcher.enqueue).toHaveBeenCalledTimes(1));

    expect(dispatcher.enqueue).toHaveBeenCalledWith({
      workspaceId,
      type: "import.cleanup",
      payload: { workspaceId, scope: "staging", batchSize: 37 },
      idempotencyKey: "import-cleanup-staging-window-10",
    });
    expect(vi.mocked(dispatcher.enqueue).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(dispatcher.dispatchBatch).mock.invocationCallOrder[0]!,
    );

    controller.abort();
    await expect(running).resolves.toBeUndefined();
    await started.close();
  });

  it("does not initialize dependencies when the static P0 registry gate fails", async () => {
    const { factories } = fakeFactories();

    await expect(
      Promise.resolve().then(() =>
        getStartWorker()({
          source: baseEnvironment,
          registry: { "asset.cleanup": vi.fn() },
          factories,
        }),
      ),
    ).rejects.toThrow(/Missing required job handlers/u);
    expect(factories.createDatabase).not.toHaveBeenCalled();
  });

  it("fails closed before initialization when the production registry has no backup verifier", async () => {
    const { factories } = fakeFactories();

    await expect(
      getStartWorker()({
        source: baseEnvironment,
        factories,
      }),
    ).rejects.toThrow("JOB_FAILED: backup verifier is not configured");

    expect(factories.createDatabase).not.toHaveBeenCalled();
    expect(factories.createStorage).not.toHaveBeenCalled();
  });

  it("awaits dependency readiness in order and makes no claim before all are ready", async () => {
    const { database, storage, search, dispatcher, idempotencyStore, factories } = fakeFactories();
    const databaseReady = deferred<unknown>();
    const order: string[] = [];
    factories.createDatabase = vi.fn(() => {
      order.push("database");
      return databaseReady.promise;
    });
    factories.createStorage = vi.fn(() => {
      order.push("storage");
      return storage;
    });
    factories.createSearch = vi.fn(() => {
      order.push("search");
      return search;
    });
    factories.createDispatcher = vi.fn(() => {
      order.push("dispatcher");
      return dispatcher;
    });
    factories.createIdempotencyStore = vi.fn(() => {
      order.push("idempotency");
      return idempotencyStore;
    });
    const signals = createSignalSource();
    const logs: WorkerLogEntry[] = [];
    const entrypoint = getRunWorkerEntrypoint()(
      (signal) =>
        getStartWorker()({
          source: baseEnvironment,
          registry: completeRegistry(),
          factories,
          runtime: { pollIntervalMs: 1, wait: abortableWait },
          signal,
        }),
      (entry) => logs.push(entry),
      signals,
    );

    await vi.waitFor(() => expect(factories.createDatabase).toHaveBeenCalledTimes(1));
    expect(order).toEqual(["database"]);
    expect(factories.createDispatcher).not.toHaveBeenCalled();
    expect(dispatcher.dispatchBatch).not.toHaveBeenCalled();

    databaseReady.resolve(database);
    await vi.waitFor(() => expect(dispatcher.dispatchBatch).toHaveBeenCalledTimes(1));
    expect(order).toEqual(["database", "storage", "search", "dispatcher", "idempotency"]);

    signals.emit("SIGTERM");
    await expect(entrypoint).resolves.toBe(0);
    expect(logs).toEqual([]);
  });

  it("fails closed, closes initialized state, and logs no dependency secrets", async () => {
    const { factories } = fakeFactories();
    factories.createStorage = vi.fn(async () => {
      throw new Error(
        `${baseEnvironment.DATABASE_URL} token=${baseEnvironment.S3_SECRET_KEY} password=hunter2`,
      );
    });
    const signals = createSignalSource();
    const logs: WorkerLogEntry[] = [];

    const status = await getRunWorkerEntrypoint()(
      (signal) =>
        getStartWorker()({
          source: baseEnvironment,
          registry: completeRegistry(),
          factories,
          signal,
        }),
      (entry) => logs.push(entry),
      signals,
    );

    expect(status).toBe(1);
    expect(logs).toEqual([{ event: "worker_startup_failed", code: "JOB_FAILED" }]);
    expect(JSON.stringify(logs)).not.toContain(baseEnvironment.DATABASE_URL);
    expect(JSON.stringify(logs)).not.toContain(baseEnvironment.S3_SECRET_KEY);
    expect(JSON.stringify(logs)).not.toContain("hunter2");
    expect(factories.closeDatabase).toHaveBeenCalledTimes(1);
    expect(factories.closeStorage).not.toHaveBeenCalled();
    expect(factories.createSearch).not.toHaveBeenCalled();
    expect(factories.createDispatcher).not.toHaveBeenCalled();
  });

  it.each(["createSearch", "createDispatcher"] as const)(
    "closes initialized storage before database when %s fails",
    async (failedFactory) => {
      const { database, storage, factories, closeOrder } = fakeFactories();
      factories[failedFactory] = vi.fn(async () => {
        throw new Error(`${failedFactory} raw failure`);
      }) as never;

      await expect(
        getStartWorker()({
          source: baseEnvironment,
          registry: completeRegistry(),
          factories,
        }),
      ).rejects.toThrow("JOB_FAILED: worker dependency initialization failed");

      expect(factories.closeStorage).toHaveBeenCalledTimes(1);
      expect(factories.closeStorage).toHaveBeenCalledWith(storage);
      expect(storage.destroy).toHaveBeenCalledTimes(1);
      expect(factories.closeDatabase).toHaveBeenCalledTimes(1);
      expect(factories.closeDatabase).toHaveBeenCalledWith(database);
      expect(closeOrder).toEqual(["storage", "database"]);
    },
  );

  it.each(["SIGTERM", "SIGINT"] as const)(
    "awaits the long-lived process and handles %s as an idempotent graceful stop",
    async (signalName) => {
      const runFinished = deferred<void>();
      const runtime = {
        run: vi.fn(() => runFinished.promise),
        stop: vi.fn(() => runFinished.resolve(undefined)),
      };
      const close = vi.fn(async () => runtime.stop());
      const started = { runtime, close } as unknown as StartedWorker;
      const signals = createSignalSource();
      const logs: WorkerLogEntry[] = [];
      let settled = false;

      const entrypoint = getRunWorkerEntrypoint()(
        async () => started,
        (entry) => logs.push(entry),
        signals,
      ).then((status) => {
        settled = true;
        return status;
      });

      await vi.waitFor(() => expect(runtime.run).toHaveBeenCalledTimes(1));
      expect(settled).toBe(false);
      signals.emit(signalName);
      signals.emit(signalName);

      await expect(entrypoint).resolves.toBe(0);
      expect(runtime.stop).toHaveBeenCalled();
      expect(close).toHaveBeenCalledTimes(1);
      expect(logs).toEqual([]);
      expect(signals.on).toHaveBeenCalledTimes(2);
      expect(signals.off).toHaveBeenCalledTimes(2);
    },
  );

  it("does not close PostgreSQL until an owned in-flight batch has settled", async () => {
    const batchFinished = deferred<void>();
    const { database, storage, dispatcher, factories } = fakeFactories();
    vi.mocked(dispatcher.dispatchBatch).mockImplementation(async () => {
      await batchFinished.promise;
      return { claimed: 1, succeeded: 1, retried: 0, deadLettered: 0 };
    });
    const started = await getStartWorker()({
      source: baseEnvironment,
      registry: completeRegistry(),
      factories,
    });
    const dispatching = started.runtime.dispatchOnce();
    await vi.waitFor(() => expect(dispatcher.dispatchBatch).toHaveBeenCalledTimes(1));

    const firstClose = started.close();
    const secondClose = started.close();
    await Promise.resolve();
    expect(factories.closeStorage).not.toHaveBeenCalled();
    expect(factories.closeDatabase).not.toHaveBeenCalled();

    batchFinished.resolve(undefined);
    await expect(Promise.all([dispatching, firstClose, secondClose])).resolves.toBeDefined();
    expect(factories.closeStorage).toHaveBeenCalledTimes(1);
    expect(factories.closeStorage).toHaveBeenCalledWith(storage);
    expect(factories.closeDatabase).toHaveBeenCalledTimes(1);
    expect(factories.closeDatabase).toHaveBeenCalledWith(database);
  });

  it("closes storage and database once on an idempotent normal shutdown", async () => {
    const { storage, factories, closeOrder } = fakeFactories();
    const started = await getStartWorker()({
      source: baseEnvironment,
      registry: completeRegistry(),
      factories,
    });

    await Promise.all([started.close(), started.close(), started.close()]);

    expect(factories.closeStorage).toHaveBeenCalledTimes(1);
    expect(factories.closeStorage).toHaveBeenCalledWith(storage);
    expect(storage.destroy).toHaveBeenCalledTimes(1);
    expect(factories.closeDatabase).toHaveBeenCalledTimes(1);
    expect(closeOrder).toEqual(["storage", "database"]);
  });

  it("dispatches the first claim through handlers bound to the ready dependencies", async () => {
    const workspaceId = "11111111-1111-4111-8111-111111111111";
    const noteId = "22222222-2222-4222-8222-222222222222";
    const database = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            limit: vi.fn().mockResolvedValue([
              {
                noteId,
                workspaceId,
                revision: 1,
                title: "Ready note",
                contentMarkdown: "# Ready note\n\nBody",
                deletedAt: null,
              },
            ]),
          })),
        })),
      })),
    } as unknown as Database;
    const storage = fakeStorage();
    const search = fakeSearch();
    const registry = createJobRegistry({
      database,
      storage,
      search,
      environment: workerEntrypoint.parseWorkerEnv(baseEnvironment),
    });
    const job = {
      id: "33333333-3333-4333-8333-333333333333",
      workspaceId,
      type: "search.index" as const,
      version: 1 as const,
      attempts: 1,
      createdAt: new Date(0).toISOString(),
      payload: {
        workspaceId,
        noteId,
        revision: 1,
        operationId: "44444444-4444-4444-8444-444444444444",
      },
    };
    const dispatcher = {
      enqueue: vi.fn(),
      dispatchBatch: vi.fn(async (handlers: JobRegistry, signal?: AbortSignal) => {
        await handlers["search.index"]!(job, signal ?? new AbortController().signal);
        return { claimed: 1, succeeded: 1, retried: 0, deadLettered: 0 };
      }),
    };
    const runtime = new WorkerRuntime(dispatcher, registry);

    await expect(runtime.dispatchOnce()).resolves.toMatchObject({ claimed: 1, succeeded: 1 });
    expect(search.indexNoteIfCurrent).toHaveBeenCalledWith(
      expect.objectContaining({ noteId, workspaceId, revision: 1 }),
    );
    expect(database.select).toHaveBeenCalledTimes(1);
    expect(storage.delete).not.toHaveBeenCalled();
  });
});
