import { createHash, randomUUID } from "node:crypto";
import { exports, notes, workspaceMembers, type Database, type Export } from "@glyphquire/database";
import {
  canonicalUuidSchema,
  exportFormatSchema,
  exportResultSchema,
  type ExportFormat,
  type ExportResult,
} from "@glyphquire/api-contract";
import { idempotencyKeySchema, opaqueAuthIdSchema } from "@glyphquire/api-contract/jobs";
import type { JobDispatcher, TransactionalJobDispatcher } from "@glyphquire/queue";
import type { ObjectStoragePort } from "@glyphquire/storage";
import { and, eq, isNull, lte, ne } from "drizzle-orm";
import { PublicApiError } from "../../middleware/error-handler.js";

const DEFAULT_EXPORT_EXPIRY_SECONDS = 30 * 24 * 60 * 60;
const DEFAULT_DOWNLOAD_URL_EXPIRY_SECONDS = 5 * 60;
const MILLISECONDS_PER_SECOND = 1_000;

type DbTransaction = Parameters<Database["transaction"]>[0] extends (tx: infer Tx) => unknown
  ? Tx
  : never;

export type ExportStartScope =
  { workspaceId: string; noteId?: never } | { noteId: string; workspaceId?: never };

export interface ExportService {
  start(
    actorId: string,
    scope: ExportStartScope,
    format: ExportFormat,
    idempotencyKey: string,
  ): Promise<ExportResult>;
  getStatus(actorId: string, exportId: string): Promise<ExportResult>;
  getDownload(actorId: string, exportId: string): Promise<ExportResult>;
}

export interface ExportServiceOptions {
  expirySeconds?: number;
  downloadUrlExpirySeconds?: number;
  clock?: () => number;
}

interface ResolvedScope {
  workspaceId: string;
  noteId: string | null;
  scopeType: "workspace" | "note";
}

function invalidExport(status: 400 | 404 = 400): never {
  throw new PublicApiError("EXPORT_FAILED", status);
}

function isTransactionalDispatcher(
  dispatcher: JobDispatcher,
): dispatcher is TransactionalJobDispatcher {
  return (
    "withDatabaseExecutor" in dispatcher && typeof dispatcher.withDatabaseExecutor === "function"
  );
}

function isUniqueViolation(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { code?: string; cause?: { code?: string } };
  return candidate.code === "23505" || candidate.cause?.code === "23505";
}

function positiveBoundedSeconds(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 1 || value > 31_536_000) {
    throw new Error(`Invalid ${label}`);
  }
  return value;
}

function toResult(row: Export): ExportResult {
  return exportResultSchema.parse({
    id: row.id,
    workspaceId: row.workspaceId,
    status: row.status,
    format: row.format,
    scope:
      row.scopeType === "note"
        ? { type: "note", workspaceId: row.workspaceId, noteId: row.noteId }
        : { type: "workspace", workspaceId: row.workspaceId },
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    ...(row.status === "failed" || row.status === "expired"
      ? { errorCode: "EXPORT_FAILED" as const }
      : {}),
  });
}

function hashRequest(scope: ResolvedScope, format: ExportFormat): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        format,
        noteId: scope.noteId,
        scopeType: scope.scopeType,
        workspaceId: scope.workspaceId,
      }),
      "utf8",
    )
    .digest("hex");
}

export class ExportServiceImpl implements ExportService {
  private readonly expirySeconds: number;
  private readonly downloadUrlExpirySeconds: number;
  private readonly clock: () => number;

  constructor(
    private readonly db: Database,
    private readonly storage: ObjectStoragePort,
    private readonly dispatcher: JobDispatcher,
    options: ExportServiceOptions = {},
  ) {
    this.expirySeconds = positiveBoundedSeconds(
      options.expirySeconds ?? DEFAULT_EXPORT_EXPIRY_SECONDS,
      "export expiry",
    );
    this.downloadUrlExpirySeconds = positiveBoundedSeconds(
      options.downloadUrlExpirySeconds ?? DEFAULT_DOWNLOAD_URL_EXPIRY_SECONDS,
      "export download URL expiry",
    );
    if (this.downloadUrlExpirySeconds > 3_600) {
      throw new Error("Invalid export download URL expiry");
    }
    this.clock = options.clock ?? Date.now;
  }

  private transactionDispatcher(tx: DbTransaction): JobDispatcher {
    if (!isTransactionalDispatcher(this.dispatcher)) {
      throw new Error("JOB_FAILED: transactional enqueue unavailable");
    }
    return this.dispatcher.withDatabaseExecutor(tx);
  }

  private async resolveScope(actorId: string, scope: ExportStartScope): Promise<ResolvedScope> {
    if (scope.workspaceId !== undefined && scope.noteId === undefined) {
      if (!canonicalUuidSchema.safeParse(scope.workspaceId).success) invalidExport();
      const [member] = await this.db
        .select({ workspaceId: workspaceMembers.workspaceId })
        .from(workspaceMembers)
        .where(
          and(
            eq(workspaceMembers.workspaceId, scope.workspaceId),
            eq(workspaceMembers.userId, actorId),
          ),
        )
        .limit(1);
      if (!member) invalidExport(404);
      return { workspaceId: member.workspaceId, noteId: null, scopeType: "workspace" };
    }

    if (scope.noteId !== undefined && scope.workspaceId === undefined) {
      if (!canonicalUuidSchema.safeParse(scope.noteId).success) invalidExport();
      const rows = await this.db
        .select({ noteId: notes.id, workspaceId: notes.workspaceId })
        .from(notes)
        .innerJoin(
          workspaceMembers,
          and(
            eq(workspaceMembers.workspaceId, notes.workspaceId),
            eq(workspaceMembers.userId, actorId),
          ),
        )
        .where(and(eq(notes.id, scope.noteId), isNull(notes.deletedAt)))
        .limit(1);
      const row = rows[0];
      if (!row) invalidExport(404);
      return { workspaceId: row.workspaceId, noteId: row.noteId, scopeType: "note" };
    }

    invalidExport();
  }

  private async existingReplay(
    actorId: string,
    workspaceId: string,
    idempotencyKey: string,
    requestHash: string,
  ): Promise<ExportResult | undefined> {
    const [existing] = await this.db
      .select()
      .from(exports)
      .where(
        and(
          eq(exports.requesterId, actorId),
          eq(exports.workspaceId, workspaceId),
          eq(exports.idempotencyKey, idempotencyKey),
        ),
      )
      .limit(1);
    if (!existing) return undefined;
    if (existing.requestHash !== requestHash) {
      throw new PublicApiError("OPERATION_REUSED", 409);
    }
    return toResult(existing);
  }

  async start(
    actorId: string,
    scope: ExportStartScope,
    format: ExportFormat,
    idempotencyKey: string,
  ): Promise<ExportResult> {
    if (
      !opaqueAuthIdSchema.safeParse(actorId).success ||
      !scope ||
      typeof scope !== "object" ||
      Array.isArray(scope) ||
      Object.getPrototypeOf(scope) !== Object.prototype ||
      Object.keys(scope).some((key) => key !== "workspaceId" && key !== "noteId") ||
      !exportFormatSchema.safeParse(format).success ||
      !idempotencyKeySchema.safeParse(idempotencyKey).success
    ) {
      invalidExport();
    }

    const resolved = await this.resolveScope(actorId, scope);
    const requestHash = hashRequest(resolved, format);
    const replay = await this.existingReplay(
      actorId,
      resolved.workspaceId,
      idempotencyKey,
      requestHash,
    );
    if (replay) return replay;

    const exportId = randomUUID();
    const now = new Date(this.clock());
    if (!Number.isFinite(now.getTime())) throw new Error("Invalid export clock");
    const expiresAt = new Date(now.getTime() + this.expirySeconds * MILLISECONDS_PER_SECOND);
    const objectKey = `workspace/${resolved.workspaceId}/exports/${exportId}/artifact`;

    try {
      const row = await this.db.transaction(async (tx) => {
        const [inserted] = await tx
          .insert(exports)
          .values({
            id: exportId,
            workspaceId: resolved.workspaceId,
            requesterId: actorId,
            scopeType: resolved.scopeType,
            noteId: resolved.noteId,
            format,
            status: "pending",
            idempotencyKey,
            requestHash,
            objectKey,
            expiresAt,
            createdAt: now,
            updatedAt: now,
          })
          .returning();
        if (!inserted) throw new Error("Export insert returned no row");
        await this.transactionDispatcher(tx).enqueue({
          workspaceId: resolved.workspaceId,
          type: "export",
          payload: { workspaceId: resolved.workspaceId, exportId },
          idempotencyKey: `export-${exportId}`,
        });
        return inserted;
      });
      return toResult(row);
    } catch (error) {
      if (isUniqueViolation(error)) {
        const raced = await this.existingReplay(
          actorId,
          resolved.workspaceId,
          idempotencyKey,
          requestHash,
        );
        if (raced) return raced;
      }
      throw error;
    }
  }

  private async loadAuthorized(actorId: string, exportId: string): Promise<Export> {
    if (!opaqueAuthIdSchema.safeParse(actorId).success) invalidExport(404);
    if (!canonicalUuidSchema.safeParse(exportId).success) invalidExport();
    const rows = await this.db
      .select({ export: exports })
      .from(exports)
      .innerJoin(
        workspaceMembers,
        and(
          eq(workspaceMembers.workspaceId, exports.workspaceId),
          eq(workspaceMembers.userId, actorId),
        ),
      )
      .where(and(eq(exports.id, exportId), eq(exports.requesterId, actorId)))
      .limit(1);
    const row = rows[0]?.export;
    if (!row) invalidExport(404);
    const now = new Date(this.clock());
    if (!Number.isFinite(now.getTime())) throw new Error("Invalid export clock");
    if (row.status !== "expired" && row.expiresAt.getTime() <= now.getTime()) {
      const [expired] = await this.db
        .update(exports)
        .set({ status: "expired", lastError: null, updatedAt: now })
        .where(
          and(
            eq(exports.id, row.id),
            eq(exports.workspaceId, row.workspaceId),
            eq(exports.requesterId, actorId),
            ne(exports.status, "expired"),
            lte(exports.expiresAt, now),
          ),
        )
        .returning();
      if (expired) return expired;
    }
    return row;
  }

  async getStatus(actorId: string, exportId: string): Promise<ExportResult> {
    return toResult(await this.loadAuthorized(actorId, exportId));
  }

  async getDownload(actorId: string, exportId: string): Promise<ExportResult> {
    const row = await this.loadAuthorized(actorId, exportId);
    const now = this.clock();
    const expectedKey = `workspace/${row.workspaceId}/exports/${row.id}/artifact`;
    if (
      row.status !== "completed" ||
      row.expiresAt.getTime() <= now ||
      row.objectKey !== expectedKey
    ) {
      invalidExport(404);
    }
    const remainingSeconds = Math.max(
      1,
      Math.ceil((row.expiresAt.getTime() - now) / MILLISECONDS_PER_SECOND),
    );
    const downloadUrl = await this.storage.createDownloadUrl(
      expectedKey,
      Math.min(this.downloadUrlExpirySeconds, remainingSeconds),
    );
    return exportResultSchema.parse({ ...toResult(row), downloadUrl });
  }
}
