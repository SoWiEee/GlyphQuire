import { randomUUID } from "node:crypto";
import type { JobType } from "@glyphquire/api-contract/jobs";
import type { EnqueueJobInput } from "@glyphquire/queue";
import { describe, expect, it, vi } from "vitest";
import {
  FIFTEEN_MINUTES_MS,
  ONE_DAY_MS,
  ONE_HOUR_MS,
  createMaintenanceScheduler,
} from "./scheduler.js";

const now = Date.parse("2026-08-27T00:00:00.000Z");

function fakeDispatcher() {
  const enqueued: EnqueueJobInput<JobType>[] = [];
  return {
    enqueued,
    async enqueue<TType extends JobType>(input: EnqueueJobInput<TType>) {
      enqueued.push(input as EnqueueJobInput<JobType>);
      return { id: randomUUID(), duplicate: false };
    },
  };
}

function fakeRepository() {
  return {
    listWorkspaceIds: vi.fn().mockResolvedValue([randomUUID(), randomUUID()]),
    listDueWorkspaceDeletions: vi.fn().mockResolvedValue([]),
    listDueAccountDeletions: vi.fn().mockResolvedValue([]),
  };
}

const batchSizes = {
  importCleanup: 11,
  shareCleanup: 12,
  exportCleanup: 13,
  assetCleanup: 14,
  idempotencyCleanup: 15,
  versionCleanup: 16,
};

describe("maintenance scheduler", () => {
  it("uses one caller-driven tick and emits the exact 15-minute, hourly, and daily jobs", async () => {
    const repository = fakeRepository();
    const dispatcher = fakeDispatcher();
    const scheduler = createMaintenanceScheduler({
      repository,
      dispatcher,
      alert: { record: vi.fn().mockResolvedValue(undefined) },
      batchSizes,
      deletionDeadlineDays: 30,
    });
    const signal = new AbortController().signal;

    await scheduler.run(now, signal);
    const firstTypes = dispatcher.enqueued.map((entry) => entry.type);
    expect(firstTypes.filter((type) => type === "import.cleanup")).toHaveLength(2);
    expect(firstTypes.filter((type) => type === "share.cleanup")).toHaveLength(2);
    expect(firstTypes.filter((type) => type === "export.expire")).toHaveLength(2);
    expect(firstTypes.filter((type) => type === "asset.orphan_cleanup")).toHaveLength(2);
    expect(firstTypes.filter((type) => type === "idempotency.cleanup")).toHaveLength(2);
    expect(firstTypes.filter((type) => type === "version.retention")).toHaveLength(2);
    expect(dispatcher.enqueued).toContainEqual(
      expect.objectContaining({
        type: "import.cleanup",
        payload: expect.objectContaining({ scope: "staging", batchSize: 11 }),
      }),
    );

    const afterFirst = dispatcher.enqueued.length;
    await scheduler.run(now + 60_000, signal);
    expect(dispatcher.enqueued).toHaveLength(afterFirst);

    await scheduler.run(now + FIFTEEN_MINUTES_MS, signal);
    expect(dispatcher.enqueued.slice(afterFirst).map((entry) => entry.type)).toEqual([
      "import.cleanup",
      "import.cleanup",
    ]);

    const beforeHour = dispatcher.enqueued.length;
    await scheduler.run(now + ONE_HOUR_MS, signal);
    expect(
      dispatcher.enqueued
        .slice(beforeHour)
        .map((entry) => entry.type)
        .sort(),
    ).toEqual(
      [
        "asset.orphan_cleanup",
        "asset.orphan_cleanup",
        "export.expire",
        "export.expire",
        "idempotency.cleanup",
        "idempotency.cleanup",
        "import.cleanup",
        "import.cleanup",
        "share.cleanup",
        "share.cleanup",
      ].sort(),
    );

    const beforeDay = dispatcher.enqueued.length;
    await scheduler.run(now + ONE_DAY_MS, signal);
    expect(
      dispatcher.enqueued.slice(beforeDay).filter((entry) => entry.type === "version.retention"),
    ).toHaveLength(2);
  });

  it("re-enqueues and alerts failed or stranded purges through the exact 30-day deadline", async () => {
    const workspaceId = randomUUID();
    const deletionId = randomUUID();
    const confirmedAt = new Date(now - 30 * ONE_DAY_MS);
    const repository = fakeRepository();
    repository.listWorkspaceIds.mockResolvedValue([]);
    repository.listDueWorkspaceDeletions.mockResolvedValue([
      {
        deletionId,
        targetWorkspaceId: workspaceId,
        routingWorkspaceId: workspaceId,
        status: "failed",
        confirmedAt,
        executeAfter: new Date(now - ONE_DAY_MS),
        updatedAt: new Date(now - FIFTEEN_MINUTES_MS),
      },
    ]);
    const dispatcher = fakeDispatcher();
    const alert = { record: vi.fn().mockResolvedValue(undefined) };
    const scheduler = createMaintenanceScheduler({
      repository,
      dispatcher,
      alert,
      batchSizes,
      deletionDeadlineDays: 30,
    });

    await scheduler.run(now, new AbortController().signal);

    expect(dispatcher.enqueued).toContainEqual(
      expect.objectContaining({
        workspaceId,
        type: "workspace.purge",
        payload: { workspaceId, deletionId },
      }),
    );
    expect(alert.record).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "lifecycle_purge_attention",
        deletionType: "workspace",
        deletionId,
        deadlineBreached: false,
      }),
    );

    const breachedRepository = fakeRepository();
    breachedRepository.listWorkspaceIds.mockResolvedValue([]);
    breachedRepository.listDueWorkspaceDeletions.mockResolvedValue([
      {
        deletionId,
        targetWorkspaceId: workspaceId,
        routingWorkspaceId: null,
        status: "processing",
        confirmedAt: new Date(confirmedAt.getTime() - 1),
        executeAfter: new Date(now - ONE_DAY_MS),
        updatedAt: new Date(now - FIFTEEN_MINUTES_MS),
      },
    ]);
    const breachedDispatcher = fakeDispatcher();
    const breachedAlert = { record: vi.fn().mockResolvedValue(undefined) };
    await createMaintenanceScheduler({
      repository: breachedRepository,
      dispatcher: breachedDispatcher,
      alert: breachedAlert,
      batchSizes,
      deletionDeadlineDays: 30,
    }).run(now, new AbortController().signal);

    expect(breachedDispatcher.enqueued).toEqual([]);
    expect(breachedAlert.record).toHaveBeenCalledWith(
      expect.objectContaining({ deadlineBreached: true }),
    );
  });

  it("enqueues account purge only after every workspace coordinator is complete, including zero-workspace", async () => {
    const accountDeletionId = randomUUID();
    const repository = fakeRepository();
    repository.listWorkspaceIds.mockResolvedValue([]);
    repository.listDueAccountDeletions.mockResolvedValue([
      {
        accountDeletionId,
        accountId: "opaque-account",
        status: "pending",
        confirmedAt: new Date(now - ONE_DAY_MS),
        executeAfter: new Date(now),
        updatedAt: new Date(now - ONE_DAY_MS),
        workspaceDeletionIds: [randomUUID(), randomUUID()],
        allWorkspacePurgesComplete: false,
      },
      {
        accountDeletionId: randomUUID(),
        accountId: "zero-workspace-account",
        status: "pending",
        confirmedAt: new Date(now - ONE_DAY_MS),
        executeAfter: new Date(now),
        updatedAt: new Date(now - ONE_DAY_MS),
        workspaceDeletionIds: [],
        allWorkspacePurgesComplete: true,
      },
    ]);
    const dispatcher = fakeDispatcher();
    const scheduler = createMaintenanceScheduler({
      repository,
      dispatcher,
      alert: { record: vi.fn().mockResolvedValue(undefined) },
      batchSizes,
      deletionDeadlineDays: 30,
    });

    await scheduler.run(now, new AbortController().signal);

    expect(dispatcher.enqueued.filter((entry) => entry.type === "account.purge")).toEqual([
      expect.objectContaining({
        workspaceId: null,
        payload: expect.objectContaining({
          workspaceId: null,
          accountId: "zero-workspace-account",
        }),
      }),
    ]);
  });

  it("emits bounded operational alerts from the maintenance probe", async () => {
    const records: unknown[] = [];
    const metricUpdates: unknown[] = [];
    const jobId = randomUUID();
    const scheduler = createMaintenanceScheduler({
      repository: fakeRepository(),
      dispatcher: fakeDispatcher(),
      alert: {
        record: async (event) => {
          records.push(event);
        },
      },
      operationalConditions: async () => ({
        backupHealthy: false,
        deadLetterCount: 1,
        oldestQueueAgeSeconds: 301,
        oldestJobId: jobId,
      }),
      metrics: {
        increment: (name, value) => metricUpdates.push(["increment", name, value]),
        set: (name, value) => metricUpdates.push(["set", name, value]),
      },
      batchSizes,
      deletionDeadlineDays: 30,
    });

    await scheduler.run(now, new AbortController().signal);

    expect(records).toEqual([
      expect.objectContaining({ event: "backup_failure" }),
      expect.objectContaining({ event: "dead_letter", jobId }),
      expect.objectContaining({ event: "oldest_queue_age", jobId, ageSeconds: 301 }),
    ]);
    expect(metricUpdates).toEqual([
      ["set", "glyphquire_queue_oldest_job_age_seconds", 301],
      ["increment", "glyphquire_backup_failures_total", undefined],
      ["increment", "glyphquire_jobs_dead_lettered_total", 1],
    ]);
  });
});
