import type { JobType } from "@glyphquire/api-contract/jobs";
import {
  accountDeletions,
  workspaceDeletions,
  workspaces,
  type AccountDeletionStatus,
  type Database,
  type WorkspaceDeletionStatus,
} from "@glyphquire/database";
import type { EnqueueJobInput } from "@glyphquire/queue";
import { and, asc, eq, inArray, lte, or, sql } from "drizzle-orm";
import { createHash } from "node:crypto";

export const FIFTEEN_MINUTES_MS = 15 * 60 * 1_000;
export const ONE_HOUR_MS = 60 * 60 * 1_000;
export const ONE_DAY_MS = 24 * ONE_HOUR_MS;
const MAX_DELETION_DEADLINE_DAYS = 365;
const MAX_WORKSPACES = 1_000;
const MAX_DUE_DELETIONS = 100;

export interface DueWorkspaceDeletion {
  deletionId: string;
  targetWorkspaceId: string;
  routingWorkspaceId: string | null;
  status: WorkspaceDeletionStatus;
  confirmedAt: Date;
  executeAfter: Date;
  updatedAt: Date;
}

export interface DueAccountDeletion {
  accountDeletionId: string;
  accountId: string;
  status: AccountDeletionStatus;
  confirmedAt: Date;
  executeAfter: Date;
  updatedAt: Date;
  workspaceDeletionIds: string[];
  allWorkspacePurgesComplete: boolean;
}

export interface MaintenanceSchedulerRepository {
  listWorkspaceIds(limit?: number): Promise<string[]>;
  listDueWorkspaceDeletions(input?: {
    now: Date;
    strandedBefore: Date;
    limit: number;
  }): Promise<DueWorkspaceDeletion[]>;
  listDueAccountDeletions(input?: {
    now: Date;
    strandedBefore: Date;
    limit: number;
  }): Promise<DueAccountDeletion[]>;
}

export interface MaintenanceSchedulerDispatcher {
  enqueue<TType extends JobType>(
    input: EnqueueJobInput<TType>,
  ): Promise<{ id: string; duplicate: boolean }>;
}

export interface LifecyclePurgeAttentionEvent {
  event: "lifecycle_purge_attention";
  deletionType: "workspace" | "account";
  deletionId: string;
  status: WorkspaceDeletionStatus | AccountDeletionStatus;
  deadlineBreached: boolean;
  requestId: string;
  correlationId: string;
}

export interface WorkerOperationalAlertEvent {
  event: "backup_failure" | "dead_letter" | "oldest_queue_age";
  requestId: string;
  correlationId: string;
  jobId?: string;
  ageSeconds?: number;
}

export type MaintenanceAlertEvent = LifecyclePurgeAttentionEvent | WorkerOperationalAlertEvent;

export interface MaintenanceSchedulerAlert {
  record(event: MaintenanceAlertEvent): Promise<void>;
}

const canonicalUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

/** Stable UUID-shaped correlation identity for retries of the same job/event. */
export function stableCorrelationId(seed: string): string {
  const digest = createHash("sha256").update(seed).digest("hex");
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-5${digest.slice(13, 16)}-8${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
}

export function createWorkerAlertEvent(input: {
  event: WorkerOperationalAlertEvent["event"];
  jobId?: string;
  ageSeconds?: number;
  requestId?: string;
  correlationId?: string;
}): WorkerOperationalAlertEvent {
  const seed = `${input.event}:${input.jobId ?? "none"}`;
  const correlationId = canonicalUuid.test(input.correlationId ?? "")
    ? input.correlationId!
    : stableCorrelationId(seed);
  const requestId = canonicalUuid.test(input.requestId ?? "") ? input.requestId! : correlationId;
  const event: WorkerOperationalAlertEvent = {
    event: input.event,
    requestId,
    correlationId,
  };
  if (input.jobId !== undefined && canonicalUuid.test(input.jobId)) event.jobId = input.jobId;
  if (
    input.ageSeconds !== undefined &&
    Number.isFinite(input.ageSeconds) &&
    input.ageSeconds >= 0
  ) {
    event.ageSeconds = Math.min(Math.floor(input.ageSeconds), 31_536_000);
  }
  return event;
}

export async function recordWorkerAlert(
  alert: MaintenanceSchedulerAlert,
  input: Parameters<typeof createWorkerAlertEvent>[0],
): Promise<void> {
  await alert.record(createWorkerAlertEvent(input));
}

export interface MaintenanceBatchSizes {
  importCleanup: number;
  shareCleanup: number;
  exportCleanup: number;
  assetCleanup: number;
  idempotencyCleanup: number;
  versionCleanup: number;
}

export interface MaintenanceSchedulerDependencies {
  repository: MaintenanceSchedulerRepository;
  dispatcher: MaintenanceSchedulerDispatcher;
  alert: MaintenanceSchedulerAlert;
  batchSizes: MaintenanceBatchSizes;
  deletionDeadlineDays: number;
}

export interface MaintenanceScheduler {
  run(scheduledAt: number, signal: AbortSignal): Promise<void>;
}

export class PostgresMaintenanceSchedulerRepository implements MaintenanceSchedulerRepository {
  constructor(private readonly db: Database) {}

  async listWorkspaceIds(limit = MAX_WORKSPACES): Promise<string[]> {
    const rows = await this.db
      .select({ id: workspaces.id })
      .from(workspaces)
      .orderBy(asc(workspaces.id))
      .limit(limit);
    return rows.map((row) => row.id);
  }

  async listDueWorkspaceDeletions(
    input = {
      now: new Date(),
      strandedBefore: new Date(Date.now() - FIFTEEN_MINUTES_MS),
      limit: MAX_DUE_DELETIONS,
    },
  ): Promise<DueWorkspaceDeletion[]> {
    const rows = await this.db
      .select({
        deletionId: workspaceDeletions.id,
        targetWorkspaceId: workspaceDeletions.workspaceId,
        status: workspaceDeletions.status,
        confirmedAt: workspaceDeletions.confirmedAt,
        executeAfter: workspaceDeletions.executeAfter,
        updatedAt: workspaceDeletions.updatedAt,
      })
      .from(workspaceDeletions)
      .where(
        and(
          inArray(workspaceDeletions.status, ["pending", "processing", "failed"]),
          lte(workspaceDeletions.executeAfter, input.now),
          or(
            eq(workspaceDeletions.status, "pending"),
            lte(workspaceDeletions.updatedAt, input.strandedBefore),
          ),
        ),
      )
      .orderBy(asc(workspaceDeletions.createdAt), asc(workspaceDeletions.id))
      .limit(input.limit);
    return rows.flatMap((row) =>
      row.targetWorkspaceId
        ? [
            {
              ...row,
              targetWorkspaceId: row.targetWorkspaceId,
              routingWorkspaceId: row.targetWorkspaceId,
            },
          ]
        : [],
    );
  }

  async listDueAccountDeletions(
    input = {
      now: new Date(),
      strandedBefore: new Date(Date.now() - FIFTEEN_MINUTES_MS),
      limit: MAX_DUE_DELETIONS,
    },
  ): Promise<DueAccountDeletion[]> {
    const rows = await this.db
      .select({
        accountDeletionId: accountDeletions.id,
        accountId: accountDeletions.accountId,
        status: accountDeletions.status,
        confirmedAt: accountDeletions.confirmedAt,
        executeAfter: accountDeletions.executeAfter,
        updatedAt: accountDeletions.updatedAt,
        workspaceIds: accountDeletions.workspaceIds,
      })
      .from(accountDeletions)
      .where(
        and(
          inArray(accountDeletions.status, ["pending", "processing", "failed"]),
          lte(accountDeletions.executeAfter, input.now),
          or(
            eq(accountDeletions.status, "pending"),
            lte(accountDeletions.updatedAt, input.strandedBefore),
          ),
        ),
      )
      .orderBy(asc(accountDeletions.createdAt), asc(accountDeletions.id))
      .limit(input.limit);
    const results: DueAccountDeletion[] = [];
    for (const row of rows) {
      const linked = await this.db
        .select({ id: workspaceDeletions.id, status: workspaceDeletions.status })
        .from(workspaceDeletions)
        .where(
          sql`${workspaceDeletions.manifest} ->> 'accountDeletionId' = ${row.accountDeletionId}`,
        )
        .orderBy(asc(workspaceDeletions.createdAt), asc(workspaceDeletions.id));
      results.push({
        accountDeletionId: row.accountDeletionId,
        accountId: row.accountId,
        status: row.status,
        confirmedAt: row.confirmedAt,
        executeAfter: row.executeAfter,
        updatedAt: row.updatedAt,
        workspaceDeletionIds: linked.map((deletion) => deletion.id),
        allWorkspacePurgesComplete:
          linked.length === row.workspaceIds.length &&
          linked.every((deletion) => deletion.status === "completed"),
      });
    }
    return results;
  }
}

function checkAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new Error("JOB_FAILED");
}

function boundedBatchSize(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 1 || value > 100) {
    throw new Error(`Invalid ${label}`);
  }
  return value;
}

function deadlineBreached(confirmedAt: Date, now: number, deadlineDays: number): boolean {
  return now - confirmedAt.getTime() > deadlineDays * ONE_DAY_MS;
}

async function scrubbed<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch {
    throw new Error("JOB_FAILED");
  }
}

export function createMaintenanceScheduler(
  dependencies: MaintenanceSchedulerDependencies,
): MaintenanceScheduler {
  const batchSizes: MaintenanceBatchSizes = {
    importCleanup: boundedBatchSize(dependencies.batchSizes.importCleanup, "import batch size"),
    shareCleanup: boundedBatchSize(dependencies.batchSizes.shareCleanup, "share batch size"),
    exportCleanup: boundedBatchSize(dependencies.batchSizes.exportCleanup, "export batch size"),
    assetCleanup: boundedBatchSize(dependencies.batchSizes.assetCleanup, "asset batch size"),
    idempotencyCleanup: boundedBatchSize(
      dependencies.batchSizes.idempotencyCleanup,
      "idempotency batch size",
    ),
    versionCleanup: boundedBatchSize(dependencies.batchSizes.versionCleanup, "version batch size"),
  };
  if (
    !Number.isInteger(dependencies.deletionDeadlineDays) ||
    dependencies.deletionDeadlineDays < 1 ||
    dependencies.deletionDeadlineDays > MAX_DELETION_DEADLINE_DAYS
  ) {
    throw new Error("Invalid deletion deadline days");
  }

  let fifteenMinuteWindow: number | undefined;
  let hourlyWindow: number | undefined;
  let dailyWindow: number | undefined;

  async function enqueueWorkspaceMaintenance(
    workspaceId: string,
    window: number,
    type: "fifteen" | "hourly" | "daily",
  ): Promise<void> {
    if (type === "fifteen") {
      await dependencies.dispatcher.enqueue({
        workspaceId,
        type: "import.cleanup",
        payload: { workspaceId, scope: "staging", batchSize: batchSizes.importCleanup },
        idempotencyKey: `scheduler-import-cleanup-${window}`,
      });
      return;
    }
    if (type === "hourly") {
      await dependencies.dispatcher.enqueue({
        workspaceId,
        type: "share.cleanup",
        payload: { workspaceId, scope: "expired", batchSize: batchSizes.shareCleanup },
        idempotencyKey: `scheduler-share-cleanup-${window}`,
      });
      await dependencies.dispatcher.enqueue({
        workspaceId,
        type: "export.expire",
        payload: { workspaceId, batchSize: batchSizes.exportCleanup },
        idempotencyKey: `scheduler-export-expire-${window}`,
      });
      await dependencies.dispatcher.enqueue({
        workspaceId,
        type: "asset.orphan_cleanup",
        payload: { workspaceId, batchSize: batchSizes.assetCleanup },
        idempotencyKey: `scheduler-asset-orphan-cleanup-${window}`,
      });
      await dependencies.dispatcher.enqueue({
        workspaceId,
        type: "idempotency.cleanup",
        payload: { workspaceId, batchSize: batchSizes.idempotencyCleanup },
        idempotencyKey: `scheduler-idempotency-cleanup-${window}`,
      });
      return;
    }
    await dependencies.dispatcher.enqueue({
      workspaceId,
      type: "version.retention",
      payload: { workspaceId, scope: "workspace", batchSize: batchSizes.versionCleanup },
      idempotencyKey: `scheduler-version-retention-${window}`,
    });
  }

  async function schedulePurges(now: number, signal: AbortSignal, window: number): Promise<void> {
    const scanInput = {
      now: new Date(now),
      strandedBefore: new Date(now - FIFTEEN_MINUTES_MS),
      limit: MAX_DUE_DELETIONS,
    };
    const workspaceRows = await dependencies.repository.listDueWorkspaceDeletions(scanInput);
    for (const row of workspaceRows) {
      checkAborted(signal);
      const breached = deadlineBreached(row.confirmedAt, now, dependencies.deletionDeadlineDays);
      if (row.status !== "pending" || breached) {
        const correlationId = stableCorrelationId(`lifecycle:workspace:${row.deletionId}`);
        await dependencies.alert.record({
          event: "lifecycle_purge_attention",
          deletionType: "workspace",
          deletionId: row.deletionId,
          status: row.status,
          deadlineBreached: breached,
          requestId: correlationId,
          correlationId,
        });
      }
      if (breached) continue;
      await dependencies.dispatcher.enqueue({
        workspaceId: row.routingWorkspaceId,
        type: "workspace.purge",
        payload: { workspaceId: row.targetWorkspaceId, deletionId: row.deletionId },
        idempotencyKey: `scheduler-workspace-purge-${row.deletionId}-${window}`,
      });
    }

    const accountRows = await dependencies.repository.listDueAccountDeletions(scanInput);
    for (const row of accountRows) {
      checkAborted(signal);
      const breached = deadlineBreached(row.confirmedAt, now, dependencies.deletionDeadlineDays);
      if (row.status !== "pending" || breached) {
        const correlationId = stableCorrelationId(`lifecycle:account:${row.accountDeletionId}`);
        await dependencies.alert.record({
          event: "lifecycle_purge_attention",
          deletionType: "account",
          deletionId: row.accountDeletionId,
          status: row.status,
          deadlineBreached: breached,
          requestId: correlationId,
          correlationId,
        });
      }
      if (breached || !row.allWorkspacePurgesComplete) continue;
      await dependencies.dispatcher.enqueue({
        workspaceId: null,
        type: "account.purge",
        payload: {
          workspaceId: null,
          accountDeletionId: row.accountDeletionId,
          accountId: row.accountId,
        },
        idempotencyKey: `scheduler-account-purge-${row.accountDeletionId}-${window}`,
      });
    }
  }

  return {
    async run(scheduledAt: number, signal: AbortSignal): Promise<void> {
      if (!Number.isSafeInteger(scheduledAt) || scheduledAt < 0) throw new Error("JOB_FAILED");
      checkAborted(signal);
      const nextFifteenMinuteWindow = Math.floor(scheduledAt / FIFTEEN_MINUTES_MS);
      const nextHourlyWindow = Math.floor(scheduledAt / ONE_HOUR_MS);
      const nextDailyWindow = Math.floor(scheduledAt / ONE_DAY_MS);
      const runFifteen = fifteenMinuteWindow !== nextFifteenMinuteWindow;
      const runHourly = hourlyWindow !== nextHourlyWindow;
      const runDaily = dailyWindow !== nextDailyWindow;
      if (!runFifteen && !runHourly && !runDaily) return;

      await scrubbed(async () => {
        const workspaceIds = await dependencies.repository.listWorkspaceIds(MAX_WORKSPACES);
        if (workspaceIds.length > MAX_WORKSPACES) throw new Error("JOB_FAILED");
        if (runFifteen) {
          for (const workspaceId of workspaceIds) {
            checkAborted(signal);
            await enqueueWorkspaceMaintenance(workspaceId, nextFifteenMinuteWindow, "fifteen");
          }
          await schedulePurges(scheduledAt, signal, nextFifteenMinuteWindow);
          fifteenMinuteWindow = nextFifteenMinuteWindow;
        }
        if (runHourly) {
          for (const workspaceId of workspaceIds) {
            checkAborted(signal);
            await enqueueWorkspaceMaintenance(workspaceId, nextHourlyWindow, "hourly");
          }
          hourlyWindow = nextHourlyWindow;
        }
        if (runDaily) {
          for (const workspaceId of workspaceIds) {
            checkAborted(signal);
            await enqueueWorkspaceMaintenance(workspaceId, nextDailyWindow, "daily");
          }
          dailyWindow = nextDailyWindow;
        }
      });
    },
  };
}
