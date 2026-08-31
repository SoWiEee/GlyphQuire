import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { JobEnvelope, JobType } from "@glyphquire/api-contract";
import {
  P0_JOB_TYPES,
  P1_JOB_TYPES,
  assertRequiredJobsComplete,
  assertRegistryComplete,
  dispatchValidatedJob,
  PostgresJobDispatcher,
  type JobHandler,
  type JobStore,
  type StoredJob,
  type JobRegistry,
} from "./jobs.js";

function envelope<TType extends JobType>(
  type: TType,
  payload: JobEnvelope<TType>["payload"],
): JobEnvelope<TType> {
  return {
    id: randomUUID(),
    workspaceId: payload.workspaceId,
    type,
    version: 1,
    attempts: 1,
    createdAt: new Date().toISOString(),
    payload,
  };
}

const handler = vi.fn<JobHandler<"asset.cleanup">>().mockResolvedValue(undefined);

describe("static job dispatch", () => {
  it("dispatches a registered staged handler", async () => {
    handler.mockClear();
    const registry: JobRegistry = { "asset.cleanup": handler };
    const job = envelope("asset.cleanup", {
      workspaceId: randomUUID(),
      assetId: randomUUID(),
    });
    const signal = new AbortController().signal;

    await dispatchValidatedJob(job, registry, signal);

    expect(handler).toHaveBeenCalledWith(job, signal);
  });

  it("rejects unregistered and unknown database values without dynamic lookup", async () => {
    const job = envelope("asset.cleanup", {
      workspaceId: randomUUID(),
      assetId: randomUUID(),
    });
    await expect(dispatchValidatedJob(job, {}, new AbortController().signal)).rejects.toThrow(
      /unregistered.*asset\.cleanup/i,
    );
    await expect(
      dispatchValidatedJob(
        { ...job, type: "shell.exec", payload: { module: "node:child_process" } },
        {},
        new AbortController().signal,
      ),
    ).rejects.toThrow(/JOB_INVALID/);
  });

  it("reports the exact missing P0 keys and does not conflate the P1 diagnostic", () => {
    const partial: JobRegistry = {
      "search.index": vi.fn(),
      "search.remove": vi.fn(),
    };
    expect(() => assertRegistryComplete(partial, P0_JOB_TYPES)).toThrow(/search\.rebuild/);

    const p0 = Object.fromEntries(P0_JOB_TYPES.map((type) => [type, vi.fn()])) as JobRegistry;
    expect(() => assertRegistryComplete(p0)).not.toThrow();
    expect(assertRequiredJobsComplete(p0)).toEqual({ complete: false, missing: [...P1_JOB_TYPES] });

    const complete = Object.fromEntries(
      [...P0_JOB_TYPES, ...P1_JOB_TYPES].map((type) => [type, vi.fn()]),
    ) as JobRegistry;
    expect(assertRequiredJobsComplete(complete)).toEqual({ complete: true, missing: [] });
  });

  it("rejects extra unrecognized registry keys", () => {
    const registry = Object.fromEntries(P0_JOB_TYPES.map((type) => [type, vi.fn()])) as JobRegistry;
    Object.defineProperty(registry, "shell.exec", { value: vi.fn(), enumerable: true });
    expect(() => assertRegistryComplete(registry)).toThrow(/unrecognized.*shell\.exec/i);
  });

  it("rejects non-function values even for optional staged handler keys", () => {
    const registry = Object.fromEntries(P0_JOB_TYPES.map((type) => [type, vi.fn()])) as JobRegistry;
    (registry as Record<string, unknown>)["asset.thumbnail"] = "node:child_process";

    expect(() => assertRegistryComplete(registry)).toThrow(/invalid.*asset\.thumbnail/i);
  });
});

class MemoryJobStore implements JobStore {
  readonly enqueued: unknown[] = [];
  readonly claims: unknown[] = [];
  readonly completed: unknown[] = [];
  readonly retried: unknown[] = [];
  readonly deadLettered: unknown[] = [];
  claimed: StoredJob[] = [];

  async enqueue(input: Parameters<JobStore["enqueue"]>[0]) {
    this.enqueued.push(input);
    return { id: randomUUID(), duplicate: false };
  }

  async claimBatch(input: Parameters<JobStore["claimBatch"]>[0]) {
    this.claims.push(input);
    const result = this.claimed;
    this.claimed = [];
    return result;
  }

  async markCompleted(input: Parameters<JobStore["markCompleted"]>[0]) {
    this.completed.push(input);
    return true;
  }

  async markRetry(input: Parameters<JobStore["markRetry"]>[0]) {
    this.retried.push(input);
    return true;
  }

  async markDeadLetter(input: Parameters<JobStore["markDeadLetter"]>[0]) {
    this.deadLettered.push(input);
    return true;
  }
}

function storedAssetJob(attempts = 1, maxAttempts = 5): StoredJob {
  const workspaceId = randomUUID();
  return {
    id: randomUUID(),
    workspaceId,
    type: "asset.cleanup",
    version: 1,
    payload: { workspaceId, assetId: randomUUID() },
    status: "processing",
    attempts,
    maxAttempts,
    availableAt: new Date("2026-08-26T00:00:00.000Z"),
    lockedAt: new Date("2026-08-26T00:00:00.000Z"),
    lockedBy: "dispatcher-test",
    completedAt: null,
    deadLetteredAt: null,
    idempotencyKey: null,
    lastError: null,
    createdAt: new Date("2026-08-26T00:00:00.000Z"),
    updatedAt: new Date("2026-08-26T00:00:00.000Z"),
  };
}

describe("PostgresJobDispatcher policy", () => {
  it("validates enqueue input before persistence", async () => {
    const store = new MemoryJobStore();
    const dispatcher = new PostgresJobDispatcher(store, { dispatcherId: "dispatcher-test" });
    const workspaceId = randomUUID();

    await expect(
      dispatcher.enqueue({
        workspaceId,
        type: "asset.cleanup",
        payload: { workspaceId, assetId: randomUUID() },
        idempotencyKey: "asset-cleanup-1",
        maxAttempts: 20,
      }),
    ).resolves.toMatchObject({ duplicate: false });
    expect(store.enqueued).toHaveLength(1);

    await expect(
      dispatcher.enqueue({
        workspaceId,
        type: "asset.cleanup",
        payload: { workspaceId, assetId: "not-a-uuid" },
      }),
    ).rejects.toThrow(/JOB_INVALID/);
    expect(store.enqueued).toHaveLength(1);
  });

  it("uses the configured default maximum attempts for enqueue", async () => {
    const store = new MemoryJobStore();
    const dispatcher = new PostgresJobDispatcher(store, {
      dispatcherId: "dispatcher-test",
      maxAttempts: 7,
    });
    const workspaceId = randomUUID();

    await dispatcher.enqueue({
      workspaceId,
      type: "asset.cleanup",
      payload: { workspaceId, assetId: randomUUID() },
    });

    expect(store.enqueued[0]).toMatchObject({ maxAttempts: 7 });
  });

  it("claims with the injected five-minute lock boundary and marks owned success", async () => {
    const store = new MemoryJobStore();
    store.claimed = [storedAssetJob()];
    const handler = vi.fn().mockResolvedValue(undefined);
    const now = Date.parse("2026-08-26T01:00:00.000Z");
    const dispatcher = new PostgresJobDispatcher(store, {
      dispatcherId: "dispatcher-test",
      clock: () => now,
      lockTimeoutSeconds: 300,
    });

    await expect(dispatcher.dispatchBatch({ "asset.cleanup": handler })).resolves.toEqual({
      claimed: 1,
      succeeded: 1,
      retried: 0,
      deadLettered: 0,
    });
    expect(store.claims[0]).toMatchObject({
      dispatcherId: "dispatcher-test",
      now: new Date(now),
      lockBefore: new Date(now - 300_000),
    });
    expect(store.completed).toEqual([
      {
        jobId: expect.any(String),
        dispatcherId: "dispatcher-test",
        claimGeneration: 1,
        now: new Date(now),
      },
    ]);
  });

  it("prevents a stale claim from completing a reclaimed job under the same dispatcher id", async () => {
    const original = storedAssetJob(1, 5);
    let generation = 0;
    const acceptedCompletions: number[] = [];
    const attemptedCompletions: unknown[] = [];
    const store: JobStore = {
      enqueue: vi.fn(),
      claimBatch: vi.fn(async () => {
        generation += 1;
        return [{ ...original, attempts: generation }];
      }),
      markCompleted: vi.fn(async (input) => {
        attemptedCompletions.push(input);
        const claimGeneration = (input as unknown as { claimGeneration?: number }).claimGeneration;
        if (claimGeneration !== generation) return false;
        acceptedCompletions.push(claimGeneration);
        return true;
      }),
      markRetry: vi.fn(),
      markDeadLetter: vi.fn(),
    };
    let releaseFirst!: () => void;
    const firstMayFinish = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let firstStarted!: () => void;
    const firstDidStart = new Promise<void>((resolve) => {
      firstStarted = resolve;
    });
    const handler = vi.fn(async (job: JobEnvelope<"asset.cleanup">) => {
      if (job.attempts !== 1) return;
      firstStarted();
      await firstMayFinish;
    });
    const dispatcher = new PostgresJobDispatcher(store, { dispatcherId: "reused-dispatcher" });

    const staleDispatch = dispatcher.dispatchBatch({ "asset.cleanup": handler });
    await firstDidStart;
    await expect(dispatcher.dispatchBatch({ "asset.cleanup": handler })).resolves.toMatchObject({
      succeeded: 1,
    });
    releaseFirst();
    await expect(staleDispatch).resolves.toMatchObject({ succeeded: 0 });

    expect(acceptedCompletions).toEqual([2]);
    expect(attemptedCompletions).toEqual([
      expect.objectContaining({ claimGeneration: 2 }),
      expect.objectContaining({ claimGeneration: 1 }),
    ]);
  });

  it("retries with exact exponential backoff and dead-letters at persisted max attempts", async () => {
    const store = new MemoryJobStore();
    const now = Date.parse("2026-08-26T01:00:00.000Z");
    const dispatcher = new PostgresJobDispatcher(store, {
      dispatcherId: "dispatcher-test",
      clock: () => now,
      backoffBaseSeconds: 5,
      backoffCapSeconds: 300,
    });
    const failing = vi.fn().mockRejectedValue(new Error("provider secret=do-not-persist"));

    store.claimed = [storedAssetJob(1, 5)];
    await expect(dispatcher.dispatchBatch({ "asset.cleanup": failing })).resolves.toMatchObject({
      retried: 1,
      deadLettered: 0,
    });
    expect(store.retried[0]).toMatchObject({
      availableAt: new Date(now + 5_000),
      lastError: "JOB_FAILED",
      dispatcherId: "dispatcher-test",
    });

    store.claimed = [storedAssetJob(5, 5)];
    await expect(dispatcher.dispatchBatch({ "asset.cleanup": failing })).resolves.toMatchObject({
      retried: 0,
      deadLettered: 1,
    });
    expect(store.deadLettered[0]).toMatchObject({
      lastError: "JOB_FAILED",
      dispatcherId: "dispatcher-test",
    });
  });

  it("dead-letters a reclaimed exhausted job without invoking a handler again", async () => {
    const store = new MemoryJobStore();
    store.claimed = [storedAssetJob(6, 5)];
    const handler = vi.fn().mockResolvedValue(undefined);
    const dispatcher = new PostgresJobDispatcher(store, { dispatcherId: "dispatcher-test" });

    await expect(dispatcher.dispatchBatch({ "asset.cleanup": handler })).resolves.toEqual({
      claimed: 1,
      succeeded: 0,
      retried: 0,
      deadLettered: 1,
    });
    expect(handler).not.toHaveBeenCalled();
    expect(store.deadLettered[0]).toMatchObject({
      lastError: "JOB_FAILED",
      dispatcherId: "dispatcher-test",
    });
  });

  it("fails unregistered staged types closed without selecting a module", async () => {
    const store = new MemoryJobStore();
    store.claimed = [storedAssetJob(1, 5)];
    const dispatcher = new PostgresJobDispatcher(store, { dispatcherId: "dispatcher-test" });

    await expect(dispatcher.dispatchBatch({})).resolves.toMatchObject({ retried: 1 });
    expect(store.retried[0]).toMatchObject({ lastError: "JOB_INVALID" });
  });
});
