import type { ImportCleanupPayload, JobEnvelope } from "@glyphquire/api-contract/jobs";
import { decodeCursor, encodeCursor } from "@glyphquire/api-contract/jobs";
import {
  assets,
  importResources,
  imports,
  notes,
  type Database,
  type Import,
} from "@glyphquire/database";
import { PostgresJobDispatcher, type JobHandler } from "@glyphquire/queue";
import type { ObjectStoragePort } from "@glyphquire/storage";
import { and, asc, eq, gt, inArray, isNull, lte, ne, or, sql } from "drizzle-orm";
import { isOwnedImportResource } from "./import.js";
import {
  createImportLifecycleOwner,
  importLeaseSeconds,
  importLifecycleLeaseExpired,
  importLifecycleOwnerPredicate,
  importLifecycleUnownedPredicate,
  readImportLifecycleOwner,
  withImportLifecycleLock,
  withImportLifecycleOwner,
  withoutImportLifecycleOwner,
  type ImportLifecycleOwner,
} from "./import-lifecycle.js";

const DEFAULT_STAGING_GRACE_SECONDS = 3_600;
const MAX_STAGING_GRACE_SECONDS = 31_536_000;
const MILLISECONDS_PER_SECOND = 1_000;

export interface ImportCleanupHandlerDeps {
  database: Database;
  storage: ObjectStoragePort;
  graceSeconds?: number;
  leaseSeconds?: number;
  clock?: () => number;
}

function checkAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new Error("JOB_FAILED");
}

function graceSeconds(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > MAX_STAGING_GRACE_SECONDS) {
    throw new Error("Invalid import cleanup grace seconds");
  }
  return value;
}

function expectedSourceKey(row: Pick<Import, "id" | "workspaceId">): string {
  return `workspace/${row.workspaceId}/imports/${row.id}/source`;
}

async function loadOwnedImport(
  database: Database,
  workspaceId: string,
  importId: string,
): Promise<Import | undefined> {
  const [row] = await database.select().from(imports).where(eq(imports.id, importId)).limit(1);
  if (!row) return undefined;
  if (row.workspaceId !== workspaceId || row.sourceObjectKey !== expectedSourceKey(row)) {
    throw new Error("JOB_INVALID: import.cleanup source mismatch");
  }
  return row;
}

async function resourceIsLive(
  database: Database,
  row: { workspaceId: string; assetId: string | null; objectKey: string },
): Promise<boolean> {
  if (!row.assetId) return false;
  const [asset] = await database
    .select({ id: assets.id })
    .from(assets)
    .where(
      and(
        eq(assets.workspaceId, row.workspaceId),
        or(eq(assets.id, row.assetId), eq(assets.objectKey, row.objectKey)),
      ),
    )
    .limit(1);
  if (asset) return true;
  const reference = `asset://${row.assetId}`;
  const [note] = await database
    .select({ id: notes.id })
    .from(notes)
    .where(
      and(
        eq(notes.workspaceId, row.workspaceId),
        isNull(notes.deletedAt),
        sql`position(${reference} in ${notes.contentMarkdown}) > 0`,
      ),
    )
    .limit(1);
  return Boolean(note);
}

async function recordCleanupFailure(
  database: Database,
  row: Import,
  owner: ImportLifecycleOwner,
): Promise<void> {
  await database
    .update(imports)
    .set({ compensationStatus: "failed", status: "failed", lastError: "JOB_FAILED" })
    .where(
      and(
        eq(imports.id, row.id),
        eq(imports.workspaceId, row.workspaceId),
        ne(imports.status, "completed"),
        eq(imports.compensationStatus, "running"),
        importLifecycleOwnerPredicate(owner),
      ),
    )
    .catch(() => undefined);
}

async function requireCleanupOwnership(
  database: Database,
  row: Pick<Import, "id" | "workspaceId">,
  owner: ImportLifecycleOwner,
): Promise<void> {
  const [owned] = await database
    .select({ id: imports.id })
    .from(imports)
    .where(
      and(
        eq(imports.id, row.id),
        eq(imports.workspaceId, row.workspaceId),
        eq(imports.compensationStatus, "running"),
        importLifecycleOwnerPredicate(owner),
      ),
    )
    .limit(1);
  if (!owned) throw new Error("JOB_FAILED");
}

async function cleanupOne(
  deps: ImportCleanupHandlerDeps,
  row: Import,
  cutoff: Date,
  signal: AbortSignal,
  allowRunningRetry: boolean,
  job: JobEnvelope<"import.cleanup">,
  now: number,
  leaseSeconds: number,
): Promise<void> {
  return withImportLifecycleLock(deps.database, row.id, signal, async () => {
    const current = await loadOwnedImport(deps.database, row.workspaceId, row.id);
    if (!current || current.status === "completed" || current.compensationStatus === "completed") {
      return;
    }
    if (current.createdAt > cutoff) return;
    const previous = readImportLifecycleOwner(current.manifest);
    const owner = createImportLifecycleOwner("cleanup", job, now, leaseSeconds);
    const staleRunning =
      current.compensationStatus === "running" &&
      allowRunningRetry &&
      ((previous?.kind === "cleanup" &&
        importLifecycleLeaseExpired(previous, now) &&
        (previous.jobId !== owner.jobId || previous.attempt < owner.attempt)) ||
        (!previous && current.updatedAt.getTime() + leaseSeconds * MILLISECONDS_PER_SECOND <= now));
    const claimable =
      current.compensationStatus === "required" ||
      current.compensationStatus === "failed" ||
      staleRunning;
    if (!claimable) {
      if (current.compensationStatus === "running") throw new Error("JOB_FAILED");
      return;
    }

    try {
      const [claimed] = await deps.database
        .update(imports)
        .set({
          compensationStatus: "running",
          manifest: withImportLifecycleOwner(current.manifest, owner),
          lastError: null,
        })
        .where(
          and(
            eq(imports.id, current.id),
            eq(imports.workspaceId, current.workspaceId),
            inArray(imports.status, ["staging", "failed", "expired"]),
            eq(imports.compensationStatus, current.compensationStatus),
            previous ? importLifecycleOwnerPredicate(previous) : importLifecycleUnownedPredicate(),
          ),
        )
        .returning({ id: imports.id });
      if (!claimed) throw new Error("JOB_FAILED");

      const resources = await deps.database
        .select()
        .from(importResources)
        .where(
          and(
            eq(importResources.importId, current.id),
            eq(importResources.workspaceId, current.workspaceId),
          ),
        )
        .orderBy(asc(importResources.createdAt), asc(importResources.id));
      for (const resource of resources) {
        checkAborted(signal);
        await requireCleanupOwnership(deps.database, current, owner);
        if (!isOwnedImportResource(resource)) {
          throw new Error("JOB_INVALID: import.cleanup resource ownership mismatch");
        }
        if (resource.state === "cleaned" || resource.state === "promoted") continue;
        if (await resourceIsLive(deps.database, resource)) {
          const [promoted] = await deps.database
            .update(importResources)
            .set({ state: "promoted" })
            .where(
              and(
                eq(importResources.id, resource.id),
                eq(importResources.importId, current.id),
                eq(importResources.workspaceId, current.workspaceId),
                ne(importResources.state, "cleaned"),
                sql`exists (
                select 1 from ${imports}
                where ${and(
                  eq(imports.id, current.id),
                  eq(imports.workspaceId, current.workspaceId),
                  eq(imports.compensationStatus, "running"),
                  importLifecycleOwnerPredicate(owner),
                )}
              )`,
              ),
            )
            .returning({ id: importResources.id });
          if (!promoted) throw new Error("JOB_FAILED");
          continue;
        }
        await deps.storage.delete(resource.objectKey);
        const [cleaned] = await deps.database
          .update(importResources)
          .set({ state: "cleaned" })
          .where(
            and(
              eq(importResources.id, resource.id),
              eq(importResources.importId, current.id),
              eq(importResources.workspaceId, current.workspaceId),
              inArray(importResources.state, ["declared", "uploaded"]),
              sql`exists (
              select 1 from ${imports}
              where ${and(
                eq(imports.id, current.id),
                eq(imports.workspaceId, current.workspaceId),
                eq(imports.compensationStatus, "running"),
                importLifecycleOwnerPredicate(owner),
              )}
            )`,
            ),
          )
          .returning({ id: importResources.id });
        if (!cleaned) throw new Error("JOB_FAILED");
      }

      checkAborted(signal);
      await requireCleanupOwnership(deps.database, current, owner);
      await deps.storage.delete(current.sourceObjectKey);
      const [completed] = await deps.database
        .update(imports)
        .set({
          status: current.status === "failed" ? "failed" : "expired",
          compensationStatus: "completed",
          manifest: withoutImportLifecycleOwner(current.manifest),
          lastError:
            current.status === "failed"
              ? (current.lastError ?? "IMPORT_INVALID")
              : "IMPORT_INVALID",
        })
        .where(
          and(
            eq(imports.id, current.id),
            eq(imports.workspaceId, current.workspaceId),
            eq(imports.compensationStatus, "running"),
            importLifecycleOwnerPredicate(owner),
          ),
        )
        .returning({ id: imports.id });
      if (!completed) throw new Error("JOB_FAILED");
    } catch (error) {
      await recordCleanupFailure(deps.database, current, owner);
      if (error instanceof Error && error.message.startsWith("JOB_INVALID")) throw error;
      throw new Error("JOB_FAILED");
    }
  });
}

async function stagingRows(
  database: Database,
  payload: Extract<ImportCleanupPayload, { scope: "staging" }>,
  cutoff: Date,
): Promise<Import[]> {
  let cursor: { createdAt: string; id: string } | undefined;
  if (payload.cursor) {
    try {
      cursor = decodeCursor(payload.cursor);
    } catch {
      throw new Error("JOB_INVALID: invalid import.cleanup cursor");
    }
  }
  const cursorCondition = cursor
    ? or(
        gt(imports.createdAt, new Date(cursor.createdAt)),
        and(eq(imports.createdAt, new Date(cursor.createdAt)), gt(imports.id, cursor.id)),
      )
    : undefined;
  return database
    .select()
    .from(imports)
    .where(
      and(
        eq(imports.workspaceId, payload.workspaceId),
        lte(imports.createdAt, cutoff),
        inArray(imports.status, ["staging", "failed", "expired"]),
        inArray(imports.compensationStatus, ["required", "failed"]),
        cursorCondition,
      ),
    )
    .orderBy(asc(imports.createdAt), asc(imports.id))
    .limit(payload.batchSize);
}

export function createImportCleanupHandler(
  deps: ImportCleanupHandlerDeps,
): JobHandler<"import.cleanup"> {
  const cleanupGraceSeconds = graceSeconds(deps.graceSeconds ?? DEFAULT_STAGING_GRACE_SECONDS);
  const leaseSeconds = importLeaseSeconds(deps.leaseSeconds ?? 300);
  const clock = deps.clock ?? Date.now;

  return async (job: JobEnvelope<"import.cleanup">, signal: AbortSignal) => {
    const now = clock();
    if (!Number.isFinite(now)) throw new Error("JOB_FAILED");
    const cutoff = new Date(now - cleanupGraceSeconds * MILLISECONDS_PER_SECOND);
    const payload = job.payload;

    if (payload.scope === "one") {
      const row = await loadOwnedImport(deps.database, payload.workspaceId, payload.importId).catch(
        (error) => {
          if (error instanceof Error && error.message.startsWith("JOB_INVALID")) throw error;
          throw new Error("JOB_FAILED");
        },
      );
      if (!row) return;
      await cleanupOne(deps, row, cutoff, signal, true, job, now, leaseSeconds);
      return;
    }

    const rows = await stagingRows(deps.database, payload, cutoff);
    for (const row of rows) {
      checkAborted(signal);
      await cleanupOne(deps, row, cutoff, signal, false, job, now, leaseSeconds);
    }
    if (rows.length === payload.batchSize) {
      const last = rows[rows.length - 1]!;
      const cursor = encodeCursor({ createdAt: last.createdAt.toISOString(), id: last.id });
      await new PostgresJobDispatcher(deps.database).enqueue({
        workspaceId: payload.workspaceId,
        type: "import.cleanup",
        payload: {
          workspaceId: payload.workspaceId,
          scope: "staging",
          batchSize: payload.batchSize,
          cursor,
        },
        idempotencyKey: `import-cleanup-staging-${last.id}`,
      });
    }
  };
}
