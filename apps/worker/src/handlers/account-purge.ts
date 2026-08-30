import { jobPayloadSchemas, type JobEnvelope } from "@glyphquire/api-contract/jobs";
import {
  account,
  accountDeletions,
  idempotencyRecords,
  jobs,
  session,
  user,
  workspaceDeletions,
  workspaces,
  type AccountDeletionStatus,
  type Database,
} from "@glyphquire/database";
import type { JobHandler } from "@glyphquire/queue";
import { and, eq, inArray, ne, sql } from "drizzle-orm";
import { PostgresDestructiveBackupGate, type DestructiveBackupGate } from "./workspace-purge.js";

export interface AccountPurgeInspection {
  accountDeletionId: string;
  accountId: string;
  status: AccountDeletionStatus;
  confirmedAt?: Date;
  executeAfter: Date;
  workspaceDeletionIds: string[];
  allWorkspacePurgesComplete?: boolean;
}

export interface AccountPurgeRepository {
  inspect(accountDeletionId: string): Promise<AccountPurgeInspection | undefined>;
  purge(input: {
    accountDeletionId: string;
    accountId: string;
    jobId: string;
    now: Date;
  }): Promise<"completed">;
  markFailed(accountDeletionId: string, sanitizedError: "JOB_FAILED"): Promise<void>;
}

export interface AccountPurgeHandlerDependencies {
  repository: AccountPurgeRepository;
  backupGate: DestructiveBackupGate;
  clock?: () => number;
}

const selectedAccountDeletion = {
  accountDeletionId: accountDeletions.id,
  accountId: accountDeletions.accountId,
  status: accountDeletions.status,
  confirmedAt: accountDeletions.confirmedAt,
  executeAfter: accountDeletions.executeAfter,
  workspaceIds: accountDeletions.workspaceIds,
  manifest: accountDeletions.manifest,
};

export class PostgresAccountPurgeRepository implements AccountPurgeRepository {
  constructor(private readonly db: Database) {}

  private async linkedWorkspaceDeletions(
    executor: Pick<Database, "select">,
    accountDeletionId: string,
  ) {
    return executor
      .select({ id: workspaceDeletions.id, status: workspaceDeletions.status })
      .from(workspaceDeletions)
      .where(sql`${workspaceDeletions.manifest} ->> 'accountDeletionId' = ${accountDeletionId}`);
  }

  async inspect(accountDeletionId: string): Promise<AccountPurgeInspection | undefined> {
    const [row] = await this.db
      .select(selectedAccountDeletion)
      .from(accountDeletions)
      .where(eq(accountDeletions.id, accountDeletionId))
      .limit(1);
    if (!row) return undefined;
    const linked = await this.linkedWorkspaceDeletions(this.db, accountDeletionId);
    return {
      accountDeletionId: row.accountDeletionId,
      accountId: row.accountId,
      status: row.status,
      confirmedAt: row.confirmedAt,
      executeAfter: row.executeAfter,
      workspaceDeletionIds: linked.map((deletion) => deletion.id),
      allWorkspacePurgesComplete:
        linked.length === row.workspaceIds.length &&
        linked.every((deletion) => deletion.status === "completed"),
    };
  }

  async purge(input: {
    accountDeletionId: string;
    accountId: string;
    jobId: string;
    now: Date;
  }): Promise<"completed"> {
    return this.db.transaction(async (transaction) => {
      const [coordinator] = await transaction
        .select(selectedAccountDeletion)
        .from(accountDeletions)
        .where(eq(accountDeletions.id, input.accountDeletionId))
        .limit(1)
        .for("update");
      if (!coordinator) throw new Error("JOB_INVALID: account deletion not found");
      if (coordinator.status === "completed") return "completed" as const;
      if (
        coordinator.accountId !== input.accountId ||
        coordinator.executeAfter.getTime() > input.now.getTime()
      ) {
        throw new Error("JOB_INVALID: account deletion state mismatch");
      }
      const linked = await transaction
        .select({ id: workspaceDeletions.id, status: workspaceDeletions.status })
        .from(workspaceDeletions)
        .where(
          sql`${workspaceDeletions.manifest} ->> 'accountDeletionId' = ${input.accountDeletionId}`,
        )
        .for("update");
      if (
        linked.length !== coordinator.workspaceIds.length ||
        linked.some((deletion) => deletion.status !== "completed")
      ) {
        throw new Error("JOB_FAILED");
      }
      const remainingWorkspaceConditions = [eq(workspaces.personalOwnerId, input.accountId)];
      if (coordinator.workspaceIds.length > 0) {
        remainingWorkspaceConditions.push(inArray(workspaces.id, coordinator.workspaceIds));
      }
      const [remainingWorkspace] = await transaction
        .select({ id: workspaces.id })
        .from(workspaces)
        .where(sql.join(remainingWorkspaceConditions, sql` or `))
        .limit(1)
        .for("update");
      if (remainingWorkspace) throw new Error("JOB_FAILED");
      const [claimedJob] = await transaction
        .select({ id: jobs.id })
        .from(jobs)
        .where(
          and(
            eq(jobs.id, input.jobId),
            eq(jobs.type, "account.purge"),
            eq(jobs.status, "processing"),
          ),
        )
        .limit(1)
        .for("update");
      if (!claimedJob) throw new Error("JOB_FAILED");

      await transaction
        .update(accountDeletions)
        .set({ status: "processing", sanitizedError: null, updatedAt: input.now })
        .where(eq(accountDeletions.id, input.accountDeletionId));

      await transaction
        .delete(idempotencyRecords)
        .where(eq(idempotencyRecords.actorId, input.accountId));
      await transaction.delete(jobs).where(
        and(
          ne(jobs.id, input.jobId),
          sql`(
              ${jobs.payload} ->> 'accountId' = ${input.accountId}
              or ${jobs.payload} ->> 'workspaceId' in (
                select jsonb_array_elements_text(${accountDeletions.workspaceIds})
                from ${accountDeletions}
                where ${accountDeletions.id} = ${input.accountDeletionId}
              )
            )`,
        ),
      );

      await transaction.delete(session).where(eq(session.userId, input.accountId));
      await transaction.delete(account).where(eq(account.userId, input.accountId));
      await transaction.delete(user).where(eq(user.id, input.accountId));

      await transaction
        .update(accountDeletions)
        .set({
          status: "completed",
          manifest: {
            ...coordinator.manifest,
            jobId: input.jobId,
            workspaceCount: coordinator.workspaceIds.length,
            completedAt: input.now.toISOString(),
          },
          sanitizedError: null,
          updatedAt: input.now,
        })
        .where(eq(accountDeletions.id, input.accountDeletionId));
      return "completed" as const;
    });
  }

  async markFailed(accountDeletionId: string, sanitizedError: "JOB_FAILED"): Promise<void> {
    await this.db
      .update(accountDeletions)
      .set({ status: "failed", sanitizedError, updatedAt: new Date() })
      .where(
        and(
          eq(accountDeletions.id, accountDeletionId),
          inArray(accountDeletions.status, ["pending", "processing", "failed"]),
        ),
      );
  }
}

function checkAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new Error("JOB_FAILED");
}

export function createAccountPurgeHandler(
  dependencies: AccountPurgeHandlerDependencies,
): JobHandler<"account.purge"> {
  const clock = dependencies.clock ?? Date.now;
  return async (job: JobEnvelope<"account.purge">, signal: AbortSignal) => {
    checkAborted(signal);
    const parsed = jobPayloadSchemas["account.purge"].safeParse(job.payload);
    if (!parsed.success || job.workspaceId !== parsed.data.workspaceId) {
      throw new Error("JOB_INVALID: invalid account.purge payload");
    }
    let inspection: AccountPurgeInspection | undefined;
    try {
      inspection = await dependencies.repository.inspect(parsed.data.accountDeletionId);
    } catch {
      throw new Error("JOB_FAILED");
    }
    if (!inspection || inspection.accountId !== parsed.data.accountId) {
      throw new Error("JOB_INVALID: account deletion source mismatch");
    }
    if (inspection.status === "completed") return;
    const nowMs = clock();
    if (!Number.isSafeInteger(nowMs) || nowMs < 0) throw new Error("JOB_FAILED");
    const now = new Date(nowMs);
    if (
      inspection.executeAfter.getTime() > nowMs ||
      inspection.allWorkspacePurgesComplete === false
    ) {
      throw new Error("JOB_FAILED");
    }

    try {
      await dependencies.backupGate.assertReady({
        confirmedAt: inspection.confirmedAt ?? inspection.executeAfter,
        now,
      });
      checkAborted(signal);
      await dependencies.repository.purge({
        accountDeletionId: parsed.data.accountDeletionId,
        accountId: parsed.data.accountId,
        jobId: job.id,
        now,
      });
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("JOB_INVALID")) throw error;
      await dependencies.repository
        .markFailed(parsed.data.accountDeletionId, "JOB_FAILED")
        .catch(() => undefined);
      throw new Error("JOB_FAILED");
    }
  };
}

export function createPostgresAccountPurgeHandler(input: {
  database: Database;
  backupGate?: DestructiveBackupGate;
  clock?: () => number;
}): JobHandler<"account.purge"> {
  return createAccountPurgeHandler({
    repository: new PostgresAccountPurgeRepository(input.database),
    backupGate: input.backupGate ?? new PostgresDestructiveBackupGate(input.database),
    clock: input.clock,
  });
}
