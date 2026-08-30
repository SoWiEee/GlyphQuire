import { jobPayloadSchemas, type JobEnvelope } from "@glyphquire/api-contract/jobs";
import {
  assets,
  exports,
  importResources,
  imports,
  jobs,
  workspaceDeletions,
  workspaceMembers,
  workspaces,
  type Database,
  type WorkspaceDeletionStatus,
} from "@glyphquire/database";
import type { JobHandler } from "@glyphquire/queue";
import type { ObjectStoragePort } from "@glyphquire/storage";
import { and, eq, gte, inArray, isNotNull, lte, ne } from "drizzle-orm";

export interface WorkspacePurgeInspection {
  deletionId: string;
  targetWorkspaceId: string;
  status: WorkspaceDeletionStatus;
  confirmedAt?: Date;
  executeAfter: Date;
  authorized?: boolean;
}

export interface WorkspacePurgeObjectTargets {
  assetIds: string[];
  thumbnailAssetIds: string[];
  importIds: string[];
  importResources: { importId: string; resourceId: string }[];
  exportIds: string[];
}

export interface WorkspacePurgeRepository {
  inspect(deletionId: string): Promise<WorkspacePurgeInspection | undefined>;
  purge(
    input: { deletionId: string; workspaceId: string; jobId: string; now: Date },
    deleteObjects: (targets: WorkspacePurgeObjectTargets) => Promise<void>,
  ): Promise<"completed">;
  markFailed(deletionId: string, sanitizedError: "JOB_FAILED"): Promise<void>;
}

export interface DestructiveBackupGate {
  assertReady(input?: { confirmedAt: Date; now: Date }): Promise<void>;
}

export interface WorkspacePurgeHandlerDependencies {
  repository: WorkspacePurgeRepository;
  storage: Pick<ObjectStoragePort, "delete">;
  backupGate: DestructiveBackupGate;
  clock?: () => number;
}

export class PostgresDestructiveBackupGate implements DestructiveBackupGate {
  constructor(private readonly db: Database) {}

  async assertReady(input?: { confirmedAt: Date; now: Date }): Promise<void> {
    if (!input) throw new Error("JOB_FAILED");
    const [verified] = await this.db
      .select({ id: jobs.id })
      .from(jobs)
      .where(
        and(
          eq(jobs.type, "backup.verify"),
          eq(jobs.status, "completed"),
          isNotNull(jobs.completedAt),
          gte(jobs.completedAt, input.confirmedAt),
          lte(jobs.completedAt, input.now),
        ),
      )
      .limit(1);
    if (!verified) throw new Error("JOB_FAILED");
  }
}

const selectedDeletion = {
  deletionId: workspaceDeletions.id,
  targetWorkspaceId: workspaceDeletions.workspaceId,
  requestedBy: workspaceDeletions.requestedBy,
  status: workspaceDeletions.status,
  confirmedAt: workspaceDeletions.confirmedAt,
  executeAfter: workspaceDeletions.executeAfter,
  manifest: workspaceDeletions.manifest,
};

export class PostgresWorkspacePurgeRepository implements WorkspacePurgeRepository {
  constructor(private readonly db: Database) {}

  async inspect(deletionId: string): Promise<WorkspacePurgeInspection | undefined> {
    const [row] = await this.db
      .select(selectedDeletion)
      .from(workspaceDeletions)
      .where(eq(workspaceDeletions.id, deletionId))
      .limit(1);
    if (!row) return undefined;
    if (row.status === "completed") {
      const durableTarget =
        typeof row.manifest.targetWorkspaceId === "string"
          ? row.manifest.targetWorkspaceId
          : undefined;
      return {
        deletionId: row.deletionId,
        targetWorkspaceId:
          row.targetWorkspaceId ?? durableTarget ?? "00000000-0000-0000-0000-000000000000",
        status: row.status,
        confirmedAt: row.confirmedAt,
        executeAfter: row.executeAfter,
        authorized: true,
      };
    }
    if (!row.targetWorkspaceId || !row.requestedBy) return undefined;
    const [member] = await this.db
      .select({ role: workspaceMembers.role })
      .from(workspaceMembers)
      .where(
        and(
          eq(workspaceMembers.workspaceId, row.targetWorkspaceId),
          eq(workspaceMembers.userId, row.requestedBy),
        ),
      )
      .limit(1);
    return {
      deletionId: row.deletionId,
      targetWorkspaceId: row.targetWorkspaceId,
      status: row.status,
      confirmedAt: row.confirmedAt,
      executeAfter: row.executeAfter,
      authorized: member?.role === "owner",
    };
  }

  async purge(
    input: { deletionId: string; workspaceId: string; jobId: string; now: Date },
    deleteObjects: (targets: WorkspacePurgeObjectTargets) => Promise<void>,
  ): Promise<"completed"> {
    return this.db.transaction(async (transaction) => {
      const [deletion] = await transaction
        .select(selectedDeletion)
        .from(workspaceDeletions)
        .where(eq(workspaceDeletions.id, input.deletionId))
        .limit(1)
        .for("update");
      if (!deletion) throw new Error("JOB_INVALID: workspace deletion not found");
      if (deletion.status === "completed") return "completed" as const;
      if (
        deletion.targetWorkspaceId !== input.workspaceId ||
        !deletion.requestedBy ||
        deletion.executeAfter.getTime() > input.now.getTime()
      ) {
        throw new Error("JOB_INVALID: workspace deletion state mismatch");
      }
      const [owner] = await transaction
        .select({ role: workspaceMembers.role })
        .from(workspaceMembers)
        .where(
          and(
            eq(workspaceMembers.workspaceId, input.workspaceId),
            eq(workspaceMembers.userId, deletion.requestedBy),
          ),
        )
        .limit(1)
        .for("update");
      if (owner?.role !== "owner") {
        throw new Error("JOB_INVALID: workspace deletion authorization revoked");
      }
      const [claimedJob] = await transaction
        .select({ id: jobs.id, type: jobs.type, status: jobs.status })
        .from(jobs)
        .where(
          and(
            eq(jobs.id, input.jobId),
            eq(jobs.type, "workspace.purge"),
            eq(jobs.status, "processing"),
          ),
        )
        .limit(1)
        .for("update");
      if (!claimedJob) throw new Error("JOB_FAILED");

      await transaction
        .update(workspaceDeletions)
        .set({ status: "processing", sanitizedError: null, updatedAt: input.now })
        .where(eq(workspaceDeletions.id, input.deletionId));

      const assetRows = await transaction
        .select({
          id: assets.id,
          objectKey: assets.objectKey,
          thumbnailObjectKey: assets.thumbnailObjectKey,
        })
        .from(assets)
        .where(eq(assets.workspaceId, input.workspaceId));
      const importRows = await transaction
        .select({ id: imports.id, sourceObjectKey: imports.sourceObjectKey })
        .from(imports)
        .where(eq(imports.workspaceId, input.workspaceId));
      const resourceRows = await transaction
        .select({
          id: importResources.id,
          importId: importResources.importId,
          objectKey: importResources.objectKey,
        })
        .from(importResources)
        .where(eq(importResources.workspaceId, input.workspaceId));
      const exportRows = await transaction
        .select({ id: exports.id, objectKey: exports.objectKey })
        .from(exports)
        .where(and(eq(exports.workspaceId, input.workspaceId), isNotNull(exports.objectKey)));

      for (const row of assetRows) {
        if (row.objectKey !== `workspace/${input.workspaceId}/assets/${row.id}/original`) {
          throw new Error("JOB_FAILED");
        }
        if (
          row.thumbnailObjectKey !== null &&
          row.thumbnailObjectKey !==
            `workspace/${input.workspaceId}/assets/${row.id}/thumbnail.webp`
        ) {
          throw new Error("JOB_FAILED");
        }
      }
      for (const row of importRows) {
        if (row.sourceObjectKey !== `workspace/${input.workspaceId}/imports/${row.id}/source`) {
          throw new Error("JOB_FAILED");
        }
      }
      for (const row of resourceRows) {
        if (
          row.objectKey !==
          `workspace/${input.workspaceId}/imports/${row.importId}/resources/${row.id}`
        ) {
          throw new Error("JOB_FAILED");
        }
      }
      for (const row of exportRows) {
        if (row.objectKey !== `workspace/${input.workspaceId}/exports/${row.id}/artifact`) {
          throw new Error("JOB_FAILED");
        }
      }

      const targets: WorkspacePurgeObjectTargets = {
        assetIds: assetRows.map((row) => row.id),
        thumbnailAssetIds: assetRows.flatMap((row) =>
          row.thumbnailObjectKey === null ? [] : [row.id],
        ),
        importIds: importRows.map((row) => row.id),
        importResources: resourceRows.map((row) => ({
          importId: row.importId,
          resourceId: row.id,
        })),
        exportIds: exportRows.map((row) => row.id),
      };
      await deleteObjects(targets);

      await transaction
        .delete(jobs)
        .where(and(eq(jobs.workspaceId, input.workspaceId), ne(jobs.id, input.jobId)));

      // The lifecycle FK may only be nulled once the coordinator is terminal;
      // the hardened schema enforces this invariant immediately.
      await transaction
        .update(workspaceDeletions)
        .set({
          status: "completed",
          manifest: {
            ...deletion.manifest,
            jobId: input.jobId,
            targetWorkspaceId: input.workspaceId,
            assets: targets.assetIds.length,
            imports: targets.importIds.length,
            importResources: targets.importResources.length,
            exports: targets.exportIds.length,
            completedAt: input.now.toISOString(),
          },
          sanitizedError: null,
          updatedAt: input.now,
        })
        .where(eq(workspaceDeletions.id, input.deletionId));
      const [deletedWorkspace] = await transaction
        .delete(workspaces)
        .where(eq(workspaces.id, input.workspaceId))
        .returning({ id: workspaces.id });
      if (!deletedWorkspace) throw new Error("JOB_FAILED");
      return "completed" as const;
    });
  }

  async markFailed(deletionId: string, sanitizedError: "JOB_FAILED"): Promise<void> {
    await this.db
      .update(workspaceDeletions)
      .set({ status: "failed", sanitizedError, updatedAt: new Date() })
      .where(
        and(
          eq(workspaceDeletions.id, deletionId),
          inArray(workspaceDeletions.status, ["pending", "processing", "failed"]),
        ),
      );
  }
}

function checkAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new Error("JOB_FAILED");
}

export function createWorkspacePurgeHandler(
  dependencies: WorkspacePurgeHandlerDependencies,
): JobHandler<"workspace.purge"> {
  const clock = dependencies.clock ?? Date.now;
  return async (job: JobEnvelope<"workspace.purge">, signal: AbortSignal) => {
    checkAborted(signal);
    const parsed = jobPayloadSchemas["workspace.purge"].safeParse(job.payload);
    if (
      !parsed.success ||
      (job.workspaceId !== null && job.workspaceId !== parsed.data.workspaceId)
    ) {
      throw new Error("JOB_INVALID: invalid workspace.purge payload");
    }
    let inspection: WorkspacePurgeInspection | undefined;
    try {
      inspection = await dependencies.repository.inspect(parsed.data.deletionId);
    } catch {
      throw new Error("JOB_FAILED");
    }
    if (!inspection || inspection.targetWorkspaceId !== parsed.data.workspaceId) {
      throw new Error("JOB_INVALID: workspace deletion source mismatch");
    }
    if (inspection.status === "completed") return;
    if (inspection.authorized === false) {
      throw new Error("JOB_INVALID: workspace deletion authorization revoked");
    }
    const nowMs = clock();
    if (!Number.isSafeInteger(nowMs) || nowMs < 0) throw new Error("JOB_FAILED");
    const now = new Date(nowMs);
    if (inspection.executeAfter.getTime() > nowMs) {
      throw new Error("JOB_FAILED");
    }

    try {
      await dependencies.backupGate.assertReady({
        confirmedAt: inspection.confirmedAt ?? inspection.executeAfter,
        now,
      });
      checkAborted(signal);
      await dependencies.repository.purge(
        {
          deletionId: parsed.data.deletionId,
          workspaceId: parsed.data.workspaceId,
          jobId: job.id,
          now,
        },
        async (targets) => {
          for (const assetId of targets.assetIds) {
            checkAborted(signal);
            await dependencies.storage.delete(
              `workspace/${parsed.data.workspaceId}/assets/${assetId}/original`,
            );
          }
          for (const assetId of targets.thumbnailAssetIds) {
            checkAborted(signal);
            await dependencies.storage.delete(
              `workspace/${parsed.data.workspaceId}/assets/${assetId}/thumbnail.webp`,
            );
          }
          for (const importId of targets.importIds) {
            checkAborted(signal);
            await dependencies.storage.delete(
              `workspace/${parsed.data.workspaceId}/imports/${importId}/source`,
            );
          }
          for (const resource of targets.importResources) {
            checkAborted(signal);
            await dependencies.storage.delete(
              `workspace/${parsed.data.workspaceId}/imports/${resource.importId}/resources/${resource.resourceId}`,
            );
          }
          for (const exportId of targets.exportIds) {
            checkAborted(signal);
            await dependencies.storage.delete(
              `workspace/${parsed.data.workspaceId}/exports/${exportId}/artifact`,
            );
          }
        },
      );
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("JOB_INVALID")) throw error;
      await dependencies.repository
        .markFailed(parsed.data.deletionId, "JOB_FAILED")
        .catch(() => undefined);
      throw new Error("JOB_FAILED");
    }
  };
}

export function createPostgresWorkspacePurgeHandler(input: {
  database: Database;
  storage: Pick<ObjectStoragePort, "delete">;
  backupGate?: DestructiveBackupGate;
  clock?: () => number;
}): JobHandler<"workspace.purge"> {
  return createWorkspacePurgeHandler({
    repository: new PostgresWorkspacePurgeRepository(input.database),
    storage: input.storage,
    backupGate: input.backupGate ?? new PostgresDestructiveBackupGate(input.database),
    clock: input.clock,
  });
}
