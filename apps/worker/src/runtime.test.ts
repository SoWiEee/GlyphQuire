import { describe, expect, it, vi } from "vitest";
import {
  P0_JOB_TYPES,
  type DispatchSummary,
  type JobDispatcher,
  type JobRegistry,
} from "@glyphquire/queue";
import { phase5EnvSchema } from "@glyphquire/shared";
import { WorkerRuntime } from "./runtime.js";

const encryptionKey = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

const minimumEnv = {
  IDEMPOTENCY_ENCRYPTION_KEY: encryptionKey,
  BACKUP_ENCRYPTION_KEY: encryptionKey,
};

describe("Phase 5 environment", () => {
  it("applies the exact safe defaults once", () => {
    expect(phase5EnvSchema.parse(minimumEnv)).toMatchObject({
      IDEMPOTENCY_LEASE_SECONDS: 60,
      JOB_LOCK_TIMEOUT_SECONDS: 300,
      JOB_MAX_ATTEMPTS: 5,
      JOB_BACKOFF_BASE_SECONDS: 5,
      JOB_BACKOFF_CAP_SECONDS: 300,
      THUMBNAIL_MAX_SOURCE_BYTES: 5_242_880,
      THUMBNAIL_MAX_PIXELS: 40_000_000,
      THUMBNAIL_MAX_OUTPUT_BYTES: 262_144,
      ASSET_MAX_BYTES: 5_242_880,
      AUDIT_LOG_RETENTION_DAYS: 90,
      DELETION_DEADLINE_DAYS: 30,
      PHASE5_OPERATOR_IDS: [],
    });
  });

  it("accepts a normal process environment while stripping unrelated variables", () => {
    const parsed = phase5EnvSchema.parse({
      ...minimumEnv,
      PATH: "/usr/bin",
      NODE_ENV: "test",
    });

    expect(parsed).not.toHaveProperty("PATH");
    expect(parsed).not.toHaveProperty("NODE_ENV");
  });

  it.each([
    ["THUMBNAIL_MAX_SOURCE_BYTES", "0"],
    ["THUMBNAIL_MAX_SOURCE_BYTES", "5242881"],
    ["THUMBNAIL_MAX_PIXELS", "0"],
    ["THUMBNAIL_MAX_PIXELS", "40000001"],
    ["THUMBNAIL_MAX_OUTPUT_BYTES", "262145"],
    ["ASSET_MAX_BYTES", "0"],
    ["ASSET_MAX_BYTES", "5242881"],
    ["JOB_MAX_ATTEMPTS", "0"],
    ["JOB_MAX_ATTEMPTS", "21"],
    ["ASSET_CLEANUP_BATCH_SIZE", "101"],
  ])("rejects unsafe %s=%s rather than widening a limit", (field, value) => {
    expect(phase5EnvSchema.safeParse({ ...minimumEnv, [field]: value }).success).toBe(false);
  });

  it.each(["operator-a, operator-b", "operator-a,,operator-b", "*", "operator-a,operator-a"])(
    "rejects a malformed operator allowlist: %s",
    (value) => {
      expect(phase5EnvSchema.safeParse({ ...minimumEnv, PHASE5_OPERATOR_IDS: value }).success).toBe(
        false,
      );
    },
  );

  it("parses at most twenty exact opaque operator ids", () => {
    const ids = Array.from({ length: 20 }, (_, index) => `operator-${index}`);
    expect(
      phase5EnvSchema.parse({ ...minimumEnv, PHASE5_OPERATOR_IDS: ids.join(",") })
        .PHASE5_OPERATOR_IDS,
    ).toEqual(ids);
    expect(
      phase5EnvSchema.safeParse({
        ...minimumEnv,
        PHASE5_OPERATOR_IDS: [...ids, "operator-20"].join(","),
      }).success,
    ).toBe(false);
  });

  it("requires exact 32-byte base64url encryption keys", () => {
    expect(
      phase5EnvSchema.safeParse({ ...minimumEnv, IDEMPOTENCY_ENCRYPTION_KEY: "short" }).success,
    ).toBe(false);
    expect(
      phase5EnvSchema.safeParse({
        ...minimumEnv,
        IDEMPOTENCY_ENCRYPTION_KEY: `${encryptionKey}=`,
      }).success,
    ).toBe(false);
  });
});

describe("WorkerRuntime", () => {
  const summary: DispatchSummary = { claimed: 1, succeeded: 1, retried: 0, deadLettered: 0 };

  function fakeDispatcher() {
    return {
      enqueue: vi.fn(),
      dispatchBatch: vi.fn().mockResolvedValue(summary),
    } satisfies JobDispatcher;
  }

  function deferred<T>() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    const promise = new Promise<T>((resolvePromise) => {
      resolve = resolvePromise;
    });
    return { promise, resolve };
  }

  it("allows staged dispatch but gates activation on every P0 handler", async () => {
    const dispatcher = fakeDispatcher();
    const partial: JobRegistry = { "asset.cleanup": vi.fn() };
    const runtime = new WorkerRuntime(dispatcher, partial, { clock: () => 1_000 });

    await expect(runtime.dispatchOnce()).resolves.toEqual(summary);
    expect(dispatcher.dispatchBatch).toHaveBeenCalledWith(partial, expect.any(AbortSignal));
    expect(() => runtime.assertCanActivate()).toThrow(/search\.rebuild/);

    const complete = Object.fromEntries(P0_JOB_TYPES.map((type) => [type, vi.fn()])) as JobRegistry;
    expect(() => new WorkerRuntime(dispatcher, complete).assertCanActivate()).not.toThrow();
  });

  it("stops claiming after shutdown and aborts the active signal", async () => {
    const dispatcher = fakeDispatcher();
    const runtime = new WorkerRuntime(dispatcher, {});
    runtime.stop();

    await expect(runtime.dispatchOnce()).rejects.toThrow(/stopped/i);
    expect(dispatcher.dispatchBatch).not.toHaveBeenCalled();
    expect(runtime.signal.aborted).toBe(true);
  });

  it("runs an injectable polling loop until its external signal is aborted", async () => {
    const dispatcher = fakeDispatcher();
    const externalController = new AbortController();
    const waits: number[] = [];
    const wait = vi.fn(async (milliseconds: number, signal: AbortSignal) => {
      waits.push(milliseconds);
      if (signal.aborted) return;
      await new Promise<void>((resolve) => {
        signal.addEventListener("abort", () => resolve(), { once: true });
      });
    });
    const complete = Object.fromEntries(P0_JOB_TYPES.map((type) => [type, vi.fn()])) as JobRegistry;
    const runtime = new WorkerRuntime(dispatcher, complete, {
      clock: () => 12_345,
      pollIntervalMs: 25,
      signal: externalController.signal,
      wait,
    });

    const running = runtime.run();
    await vi.waitFor(() => expect(dispatcher.dispatchBatch).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(wait).toHaveBeenCalledTimes(1));

    expect(runtime.now()).toBe(12_345);
    expect(waits).toEqual([25]);
    externalController.abort();

    await expect(running).resolves.toBeUndefined();
    expect(runtime.signal.aborted).toBe(true);
    expect(dispatcher.dispatchBatch).toHaveBeenCalledTimes(1);
  });

  it("aborts and drains an in-flight batch before shutdown resolves", async () => {
    let activeSignal: AbortSignal | undefined;
    let releaseBatch: (() => void) | undefined;
    const batchFinished = new Promise<void>((resolve) => {
      releaseBatch = resolve;
    });
    const dispatcher = {
      enqueue: vi.fn(),
      dispatchBatch: vi.fn(async (_registry: JobRegistry, signal?: AbortSignal) => {
        activeSignal = signal;
        await batchFinished;
        return summary;
      }),
    } satisfies JobDispatcher;
    const runtime = new WorkerRuntime(dispatcher, {});
    const dispatching = runtime.dispatchOnce();
    await vi.waitFor(() => expect(dispatcher.dispatchBatch).toHaveBeenCalledTimes(1));

    let firstShutdownSettled = false;
    const firstShutdown = runtime.shutdown().then(() => {
      firstShutdownSettled = true;
    });
    const secondShutdown = runtime.shutdown();
    await Promise.resolve();

    expect(activeSignal?.aborted).toBe(true);
    expect(firstShutdownSettled).toBe(false);
    releaseBatch?.();

    await expect(Promise.all([dispatching, firstShutdown, secondShutdown])).resolves.toBeDefined();
    expect(dispatcher.dispatchBatch).toHaveBeenCalledTimes(1);
    await expect(runtime.shutdown()).resolves.toBeUndefined();
  });

  it("treats an abort rejection from an in-flight loop batch as graceful shutdown", async () => {
    const started = deferred<void>();
    const dispatcher = {
      enqueue: vi.fn(),
      dispatchBatch: vi.fn(async (_registry: JobRegistry, signal?: AbortSignal) => {
        started.resolve(undefined);
        await new Promise<void>((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(new Error("raw abort detail")), {
            once: true,
          });
        });
        return summary;
      }),
    } satisfies JobDispatcher;
    const complete = Object.fromEntries(P0_JOB_TYPES.map((type) => [type, vi.fn()])) as JobRegistry;
    const runtime = new WorkerRuntime(dispatcher, complete);

    const running = runtime.run();
    await started.promise;
    const shuttingDown = runtime.shutdown();

    await expect(running).resolves.toBeUndefined();
    await expect(shuttingDown).resolves.toBeUndefined();
    expect(runtime.signal.aborted).toBe(true);
  });
});
