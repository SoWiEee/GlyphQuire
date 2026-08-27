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

const DEFAULT_STAGING_GRACE_SECONDS = 3_600;
const MAX_STAGING_GRACE_SECONDS = 31_536_000;
const MILLISECONDS_PER_SECOND = 1_000;

export interface ImportCleanupHandlerDeps {
  database: Database;
  storage: ObjectStoragePort;
  graceSeconds?: number;
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

async function recordCleanupFailure(database: Database, row: Import): Promise<void> {
  await database
    .update(imports)
    .set({ compensationStatus: "failed", status: "failed", lastError: "JOB_FAILED" })
    .where(and(eq(imports.id, row.id), eq(imports.workspaceId, row.workspaceId)))
    .catch(() => undefined);
}

async function cleanupOne(
  deps: ImportCleanupHandlerDeps,
  row: Import,
  cutoff: Date,
  signal: AbortSignal,
  allowRunningRetry: boolean,
): Promise<void> {
  if (row.status === "completed" || row.compensationStatus === "completed") return;
  if (row.createdAt > cutoff) return;

  try {
    const [claimed] = await deps.database
      .update(imports)
      .set({ compensationStatus: "running", lastError: null })
      .where(
        and(
          eq(imports.id, row.id),
          eq(imports.workspaceId, row.workspaceId),
          inArray(imports.status, ["staging", "failed", "expired"]),
          inArray(
            imports.compensationStatus,
            allowRunningRetry ? ["required", "failed", "running"] : ["required", "failed"],
          ),
        ),
      )
      .returning({ id: imports.id });
    if (!claimed) return;

    const resources = await deps.database
      .select()
      .from(importResources)
      .where(
        and(eq(importResources.importId, row.id), eq(importResources.workspaceId, row.workspaceId)),
      )
      .orderBy(asc(importResources.createdAt), asc(importResources.id));
    for (const resource of resources) {
      checkAborted(signal);
      if (!isOwnedImportResource(resource)) {
        throw new Error("JOB_INVALID: import.cleanup resource ownership mismatch");
      }
      if (resource.state === "cleaned" || resource.state === "promoted") continue;
      if (await resourceIsLive(deps.database, resource)) {
        await deps.database
          .update(importResources)
          .set({ state: "promoted" })
          .where(
            and(
              eq(importResources.id, resource.id),
              eq(importResources.importId, row.id),
              eq(importResources.workspaceId, row.workspaceId),
              ne(importResources.state, "cleaned"),
            ),
          );
        continue;
      }
      await deps.storage.delete(resource.objectKey);
      await deps.database
        .update(importResources)
        .set({ state: "cleaned" })
        .where(
          and(
            eq(importResources.id, resource.id),
            eq(importResources.importId, row.id),
            eq(importResources.workspaceId, row.workspaceId),
            inArray(importResources.state, ["declared", "uploaded"]),
          ),
        );
    }

    checkAborted(signal);
    await deps.storage.delete(row.sourceObjectKey);
    await deps.database
      .update(imports)
      .set({
        status: row.status === "failed" ? "failed" : "expired",
        compensationStatus: "completed",
        lastError: row.status === "failed" ? (row.lastError ?? "IMPORT_INVALID") : "IMPORT_INVALID",
      })
      .where(and(eq(imports.id, row.id), eq(imports.workspaceId, row.workspaceId)));
  } catch (error) {
    await recordCleanupFailure(deps.database, row);
    if (error instanceof Error && error.message.startsWith("JOB_INVALID")) throw error;
    throw new Error("JOB_FAILED");
  }
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
      await cleanupOne(deps, row, cutoff, signal, true);
      return;
    }

    const rows = await stagingRows(deps.database, payload, cutoff);
    for (const row of rows) {
      checkAborted(signal);
      await cleanupOne(deps, row, cutoff, signal, false);
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
