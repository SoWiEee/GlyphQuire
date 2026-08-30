import {
  decodeCursor,
  encodeCursor,
  jobPayloadSchemas,
  type JobEnvelope,
} from "@glyphquire/api-contract/jobs";
import { notes, noteVersions, type Database } from "@glyphquire/database";
import { PostgresJobDispatcher, type EnqueueJobInput, type JobHandler } from "@glyphquire/queue";
import { and, asc, eq, gt, isNotNull, lte, or } from "drizzle-orm";

const MILLISECONDS_PER_DAY = 86_400_000;
const MAX_RETENTION_DAYS = 3_650;

export interface VersionRetentionRow {
  id: string;
  noteId: string;
  workspaceId: string;
  createdAt: Date;
  noteDeletedAt: Date;
}

export interface VersionRetentionAuditEvent {
  event: "note_version_deleted";
  jobId: string;
  workspaceId: string;
  noteId: string;
  versionId: string;
}

export interface VersionRetentionAudit {
  record(event: VersionRetentionAuditEvent): Promise<void>;
}

export interface VersionRetentionRepository {
  listEligible(input: {
    workspaceId: string;
    noteId?: string;
    cutoff: Date;
    cursor?: { createdAt: string; id: string };
    limit: number;
  }): Promise<VersionRetentionRow[]>;
  deleteIfEligible(
    input: { versionId: string; noteId: string; workspaceId: string; cutoff: Date },
    recordAudit?: () => Promise<void>,
  ): Promise<boolean>;
}

export interface VersionRetentionDispatcher {
  enqueue(input: EnqueueJobInput<"version.retention">): Promise<{ id: string; duplicate: boolean }>;
}

export interface VersionRetentionHandlerDependencies {
  repository: VersionRetentionRepository;
  dispatcher: VersionRetentionDispatcher;
  audit: VersionRetentionAudit;
  retentionDays?: number;
  clock?: () => number;
}

const selectedVersion = {
  id: noteVersions.id,
  noteId: noteVersions.noteId,
  workspaceId: noteVersions.workspaceId,
  createdAt: noteVersions.createdAt,
  noteDeletedAt: notes.deletedAt,
};

export class PostgresVersionRetentionRepository implements VersionRetentionRepository {
  constructor(private readonly db: Database) {}

  async listEligible(input: {
    workspaceId: string;
    noteId?: string;
    cutoff: Date;
    cursor?: { createdAt: string; id: string };
    limit: number;
  }): Promise<VersionRetentionRow[]> {
    const cursorCondition = input.cursor
      ? or(
          gt(noteVersions.createdAt, new Date(input.cursor.createdAt)),
          and(
            eq(noteVersions.createdAt, new Date(input.cursor.createdAt)),
            gt(noteVersions.id, input.cursor.id),
          ),
        )
      : undefined;
    const rows = await this.db
      .select(selectedVersion)
      .from(noteVersions)
      .innerJoin(
        notes,
        and(eq(notes.id, noteVersions.noteId), eq(notes.workspaceId, noteVersions.workspaceId)),
      )
      .where(
        and(
          eq(noteVersions.workspaceId, input.workspaceId),
          input.noteId ? eq(noteVersions.noteId, input.noteId) : undefined,
          isNotNull(notes.deletedAt),
          lte(notes.deletedAt, input.cutoff),
          cursorCondition,
        ),
      )
      .orderBy(asc(noteVersions.createdAt), asc(noteVersions.id))
      .limit(input.limit);
    return rows.flatMap((row) =>
      row.noteDeletedAt ? [{ ...row, noteDeletedAt: row.noteDeletedAt }] : [],
    );
  }

  async deleteIfEligible(
    input: { versionId: string; noteId: string; workspaceId: string; cutoff: Date },
    recordAudit?: () => Promise<void>,
  ): Promise<boolean> {
    return this.db.transaction(async (transaction) => {
      // Locking the note serializes against restore/undelete. A version that
      // becomes a live restore source while this transaction waits is kept.
      const [note] = await transaction
        .select({ id: notes.id, deletedAt: notes.deletedAt })
        .from(notes)
        .where(and(eq(notes.id, input.noteId), eq(notes.workspaceId, input.workspaceId)))
        .limit(1)
        .for("update");
      if (!note || note.deletedAt === null || note.deletedAt.getTime() > input.cutoff.getTime()) {
        return false;
      }
      const [version] = await transaction
        .select({ id: noteVersions.id })
        .from(noteVersions)
        .where(
          and(
            eq(noteVersions.id, input.versionId),
            eq(noteVersions.noteId, input.noteId),
            eq(noteVersions.workspaceId, input.workspaceId),
          ),
        )
        .limit(1)
        .for("update");
      if (!version) return false;
      await recordAudit?.();
      const [deleted] = await transaction
        .delete(noteVersions)
        .where(
          and(
            eq(noteVersions.id, input.versionId),
            eq(noteVersions.noteId, input.noteId),
            eq(noteVersions.workspaceId, input.workspaceId),
          ),
        )
        .returning({ id: noteVersions.id });
      return deleted !== undefined;
    });
  }
}

function checkAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new Error("JOB_FAILED");
}

async function scrubbed<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("JOB_INVALID")) throw error;
    throw new Error("JOB_FAILED");
  }
}

export function createVersionRetentionHandler(
  dependencies: VersionRetentionHandlerDependencies,
): JobHandler<"version.retention"> {
  if (!dependencies.audit) throw new Error("JOB_FAILED: version retention audit is required");
  const retentionDays = dependencies.retentionDays ?? 30;
  if (!Number.isInteger(retentionDays) || retentionDays < 1 || retentionDays > MAX_RETENTION_DAYS) {
    throw new Error("Invalid version retention days");
  }
  const clock = dependencies.clock ?? Date.now;

  return async (job: JobEnvelope<"version.retention">, signal: AbortSignal) => {
    checkAborted(signal);
    const parsed = jobPayloadSchemas["version.retention"].safeParse(job.payload);
    if (!parsed.success || job.workspaceId !== parsed.data.workspaceId) {
      throw new Error("JOB_INVALID: invalid version.retention payload");
    }
    const now = clock();
    if (!Number.isSafeInteger(now) || now < 0) throw new Error("JOB_FAILED");
    const cutoff = new Date(now - retentionDays * MILLISECONDS_PER_DAY);
    let cursor: { createdAt: string; id: string } | undefined;
    if (parsed.data.scope === "workspace" && parsed.data.cursor) {
      try {
        cursor = decodeCursor(parsed.data.cursor);
      } catch {
        throw new Error("JOB_INVALID: invalid version.retention cursor");
      }
    }
    const rows = await scrubbed(() =>
      dependencies.repository.listEligible({
        workspaceId: parsed.data.workspaceId,
        noteId: parsed.data.scope === "note" ? parsed.data.noteId : undefined,
        cutoff,
        cursor,
        limit: parsed.data.batchSize,
      }),
    );
    for (const row of rows) {
      checkAborted(signal);
      if (
        row.workspaceId !== parsed.data.workspaceId ||
        (parsed.data.scope === "note" && row.noteId !== parsed.data.noteId)
      ) {
        throw new Error("JOB_INVALID: version.retention scan source mismatch");
      }
      let auditRecorded = false;
      const recordAudit = async () => {
        await dependencies.audit.record({
          event: "note_version_deleted",
          jobId: job.id,
          workspaceId: row.workspaceId,
          noteId: row.noteId,
          versionId: row.id,
        });
        auditRecorded = true;
      };
      const deleted = await scrubbed(() =>
        dependencies.repository.deleteIfEligible(
          {
            versionId: row.id,
            noteId: row.noteId,
            workspaceId: row.workspaceId,
            cutoff,
          },
          recordAudit,
        ),
      );
      if (deleted && !auditRecorded) await scrubbed(recordAudit);
    }

    if (rows.length === parsed.data.batchSize) {
      const last = rows[rows.length - 1]!;
      const payload =
        parsed.data.scope === "note"
          ? {
              workspaceId: parsed.data.workspaceId,
              scope: "note" as const,
              noteId: parsed.data.noteId,
              batchSize: 1 as const,
            }
          : {
              workspaceId: parsed.data.workspaceId,
              scope: "workspace" as const,
              batchSize: parsed.data.batchSize,
              cursor: encodeCursor({ createdAt: last.createdAt.toISOString(), id: last.id }),
            };
      await scrubbed(() =>
        dependencies.dispatcher.enqueue({
          workspaceId: parsed.data.workspaceId,
          type: "version.retention",
          payload,
          idempotencyKey: `version-retention-${parsed.data.workspaceId}-${last.createdAt.getTime()}-${last.id}`,
        }),
      );
    }
  };
}

export function createPostgresVersionRetentionHandler(input: {
  database: Database;
  audit: VersionRetentionAudit;
  retentionDays: number;
  clock?: () => number;
}): JobHandler<"version.retention"> {
  return createVersionRetentionHandler({
    repository: new PostgresVersionRetentionRepository(input.database),
    dispatcher: new PostgresJobDispatcher(input.database),
    audit: input.audit,
    retentionDays: input.retentionDays,
    clock: input.clock,
  });
}
