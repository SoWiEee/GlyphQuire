import { createHash, randomUUID } from "node:crypto";
import {
  imports,
  notes,
  workspaceMembers,
  type Database,
  type Import,
  type ImportManifest,
} from "@glyphquire/database";
import {
  canonicalUuidSchema,
  importJobResultSchema,
  transferProgressSchema,
  type ImportJobResult,
  type TransferProgress,
} from "@glyphquire/api-contract";
import { opaqueAuthIdSchema } from "@glyphquire/api-contract/jobs";
import type { JobDispatcher } from "@glyphquire/queue";
import type { ObjectStoragePort } from "@glyphquire/storage";
import { and, eq, isNull } from "drizzle-orm";
import { PublicApiError } from "../../middleware/error-handler.js";
import { MAX_ARCHIVE_BYTES } from "./ArchiveLimits.js";
import { ArchiveReader } from "./ArchiveReader.js";
import { TransferCoordinator } from "./TransferCoordinator.js";

const DEFAULT_IMPORT_EXPIRY_SECONDS = 24 * 60 * 60;
const DEFAULT_IMPORT_STAGING_GRACE_SECONDS = 3_600;
const MAX_MARKDOWN_BYTES = 2 * 1024 * 1024;
const MAX_IMPORT_BASE_REVISION = 2_147_483_646;
const EMPTY_PROGRESS: TransferProgress = Object.freeze({
  completedItems: 0,
  totalItems: 0,
  processedBytes: 0,
  totalBytes: 0,
});

interface SourceManifest extends Record<string, unknown> {
  version: 1;
  source: {
    sizeBytes: number;
    sha256: string;
    contentType: "application/zip" | "text/markdown";
    kind: "zip" | "markdown";
  };
  progress: TransferProgress;
  resources: unknown[];
}

export interface ImportStartInput {
  upload: Blob;
  noteId?: string;
  baseRevision?: number;
}

export interface ImportService {
  start(
    actorId: string,
    workspaceId: string,
    input: ImportStartInput,
    idempotencyKey: string,
  ): Promise<ImportJobResult>;
  getStatus(actorId: string, importId: string): Promise<ImportJobResult>;
}

export interface ImportServiceOptions {
  expirySeconds?: number;
  stagingGraceSeconds?: number;
  clock?: () => number;
  archiveReader?: Pick<ArchiveReader, "readZip">;
}

/** Fault seams used only to prove the source/row/job crash ordering. */
export interface ImportServiceHooks {
  afterStagingInsert?(): void | Promise<void>;
  afterSourcePut?(): void | Promise<void>;
  afterPendingJobInsert?(): void | Promise<void>;
}

function invalidImport(status: 400 | 404 = 400): never {
  throw new PublicApiError("IMPORT_INVALID", status);
}

function isZip(bytes: Buffer): boolean {
  if (bytes.byteLength < 4) return false;
  const signature = bytes.readUInt32LE(0);
  return signature === 0x04034b50 || signature === 0x06054b50 || signature === 0x08074b50;
}

function requestHash(input: {
  sha256: string;
  sizeBytes: number;
  noteId?: string;
  baseRevision?: number;
}): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        baseRevision: input.baseRevision ?? null,
        noteId: input.noteId ?? null,
        sha256: input.sha256,
        sizeBytes: input.sizeBytes,
      }),
      "utf8",
    )
    .digest("hex");
}

function manifestProgress(manifest: ImportManifest): TransferProgress {
  const candidate = (manifest as { progress?: unknown }).progress;
  const parsed = transferProgressSchema.safeParse(candidate);
  return parsed.success ? parsed.data : { ...EMPTY_PROGRESS };
}

function resultNoteId(row: Import): string | undefined {
  const result = (row.manifest as { result?: { noteId?: unknown } }).result;
  if (typeof result?.noteId === "string") return result.noteId;
  return row.targetNoteId ?? undefined;
}

function toResult(row: Import): ImportJobResult {
  const result: ImportJobResult = {
    id: row.id,
    workspaceId: row.workspaceId,
    status: row.status,
    progress: manifestProgress(row.manifest),
  };
  const noteId = resultNoteId(row);
  if (noteId) result.noteId = noteId;
  if (row.status === "failed" || row.status === "expired") result.errorCode = "IMPORT_INVALID";
  return importJobResultSchema.parse(result);
}

export class ImportServiceImpl implements ImportService {
  private readonly expirySeconds: number;
  private readonly stagingGraceSeconds: number;
  private readonly clock: () => number;
  private readonly archiveReader: Pick<ArchiveReader, "readZip">;
  private readonly coordinator: TransferCoordinator;

  constructor(
    private readonly db: Database,
    private readonly storage: ObjectStoragePort,
    private readonly dispatcher: JobDispatcher,
    options: ImportServiceOptions = {},
    private readonly hooks: ImportServiceHooks = {},
  ) {
    this.coordinator = new TransferCoordinator(this.db, this.dispatcher);
    this.expirySeconds = this.coordinator.validateSeconds(
      options.expirySeconds ?? DEFAULT_IMPORT_EXPIRY_SECONDS,
      "import expiry",
    );
    this.stagingGraceSeconds = this.coordinator.validateSeconds(
      options.stagingGraceSeconds ?? DEFAULT_IMPORT_STAGING_GRACE_SECONDS,
      "import staging grace",
    );
    this.clock = options.clock ?? Date.now;
    this.archiveReader = options.archiveReader ?? new ArchiveReader();
  }

  private async requireMutableMembership(actorId: string, workspaceId: string): Promise<void> {
    const [member] = await this.db
      .select({ role: workspaceMembers.role })
      .from(workspaceMembers)
      .where(
        and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, actorId)),
      )
      .limit(1);
    if (!member || (member.role !== "owner" && member.role !== "editor")) invalidImport(404);
  }

  private async existingReplay(
    actorId: string,
    workspaceId: string,
    idempotencyKey: string,
    hash: string,
  ): Promise<ImportJobResult | undefined> {
    const [existing] = await this.db
      .select()
      .from(imports)
      .where(
        and(
          eq(imports.actorId, actorId),
          eq(imports.workspaceId, workspaceId),
          eq(imports.idempotencyKey, idempotencyKey),
        ),
      )
      .limit(1);
    if (!existing) return undefined;
    if (existing.requestHash !== hash) throw new PublicApiError("OPERATION_REUSED", 409);
    return toResult(existing);
  }

  private async assertTarget(
    workspaceId: string,
    noteId: string | undefined,
    baseRevision: number | undefined,
  ): Promise<void> {
    if ((noteId === undefined) !== (baseRevision === undefined)) invalidImport();
    if (noteId === undefined) return;
    if (!Number.isInteger(baseRevision) || baseRevision! < 1) invalidImport();

    const [target] = await this.db
      .select({ revision: notes.revision })
      .from(notes)
      .where(and(eq(notes.id, noteId), eq(notes.workspaceId, workspaceId), isNull(notes.deletedAt)))
      .limit(1);
    if (!target) invalidImport(404);
    if (target.revision !== baseRevision) throw new PublicApiError("REVISION_CONFLICT", 409);
  }

  private async markFailedAndScheduleCleanup(importId: string, workspaceId: string): Promise<void> {
    const now = new Date(this.clock());
    await this.db.transaction(async (tx) => {
      const [row] = await tx
        .update(imports)
        .set({
          status: "failed",
          compensationStatus: "required",
          lastError: "JOB_FAILED",
          updatedAt: now,
        })
        .where(and(eq(imports.id, importId), eq(imports.workspaceId, workspaceId)))
        .returning({ createdAt: imports.createdAt });
      if (!row) return;
      const graceAt = this.coordinator.expiryAt(
        row.createdAt,
        this.stagingGraceSeconds,
        "import staging grace",
      );
      await this.coordinator.transactionalDispatcher(tx).enqueue({
        workspaceId,
        type: "import.cleanup",
        payload: { workspaceId, scope: "one", importId },
        idempotencyKey: `import-cleanup-${importId}`,
        runAt: graceAt > now ? graceAt : now,
      });
    });
  }

  async start(
    actorId: string,
    workspaceId: string,
    input: ImportStartInput,
    idempotencyKey: string,
  ): Promise<ImportJobResult> {
    this.coordinator.validateIdentity(actorId, idempotencyKey, invalidImport);
    if (
      !canonicalUuidSchema.safeParse(workspaceId).success ||
      !(input.upload instanceof Blob) ||
      !Number.isSafeInteger(input.upload.size) ||
      input.upload.size < 1 ||
      input.upload.size > MAX_ARCHIVE_BYTES ||
      (input.noteId !== undefined && !canonicalUuidSchema.safeParse(input.noteId).success) ||
      (input.noteId === undefined) !== (input.baseRevision === undefined) ||
      (input.baseRevision !== undefined &&
        (!Number.isSafeInteger(input.baseRevision) ||
          input.baseRevision < 1 ||
          input.baseRevision > MAX_IMPORT_BASE_REVISION))
    ) {
      invalidImport();
    }
    await this.requireMutableMembership(actorId, workspaceId);

    let bytes: Buffer;
    try {
      bytes = Buffer.from(await input.upload.arrayBuffer());
    } catch {
      return invalidImport();
    }
    if (bytes.byteLength !== input.upload.size) invalidImport();
    const zip = isZip(bytes);
    const maximum = zip ? MAX_ARCHIVE_BYTES : MAX_MARKDOWN_BYTES;
    if (bytes.byteLength < 1 || bytes.byteLength > maximum) invalidImport();
    if (!zip) {
      try {
        new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch {
        invalidImport();
      }
    } else {
      const archive = await this.archiveReader.readZip(bytes);
      await archive.cleanup();
    }

    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const hash = requestHash({
      sha256,
      sizeBytes: bytes.byteLength,
      noteId: input.noteId,
      baseRevision: input.baseRevision,
    });
    const replay = await this.existingReplay(actorId, workspaceId, idempotencyKey, hash);
    if (replay) return replay;
    await this.assertTarget(workspaceId, input.noteId, input.baseRevision);

    const importId = randomUUID();
    const sourceObjectKey = `workspace/${workspaceId}/imports/${importId}/source`;
    const now = new Date(this.clock());
    if (!Number.isFinite(now.getTime())) throw new Error("Invalid import clock");
    const expiresAt = this.coordinator.expiryAt(now, this.expirySeconds, "import expiry");
    const sourceManifest: SourceManifest = {
      version: 1,
      source: {
        sizeBytes: bytes.byteLength,
        sha256,
        contentType: zip ? "application/zip" : "text/markdown",
        kind: zip ? "zip" : "markdown",
      },
      progress: { ...EMPTY_PROGRESS },
      resources: [],
    };

    const stagedReplay = await this.coordinator.stage({
      replay: () => this.existingReplay(actorId, workspaceId, idempotencyKey, hash),
      insert: async () => {
        await this.db.insert(imports).values({
          id: importId,
          workspaceId,
          actorId,
          targetNoteId: input.noteId,
          baseRevision: input.baseRevision,
          sourceObjectKey,
          status: "staging",
          compensationStatus: "required",
          expiresAt,
          idempotencyKey,
          requestHash: hash,
          manifest: sourceManifest,
          createdAt: now,
          updatedAt: now,
        });
      },
    });
    if (stagedReplay) return stagedReplay;

    return this.coordinator.withFailureBoundary(
      async () => {
        await this.hooks.afterStagingInsert?.();
        await this.storage.put({
          key: sourceObjectKey,
          body: bytes,
          contentType: sourceManifest.source.contentType,
          contentLength: bytes.byteLength,
          sha256,
        });
        await this.hooks.afterSourcePut?.();

        const row = await this.coordinator.run({
          replay: () => this.existingReplay(actorId, workspaceId, idempotencyKey, hash),
          transaction: async (tx, dispatcher) => {
            const [updated] = await tx
              .update(imports)
              .set({
                status: "pending",
                compensationStatus: "none",
                lastError: null,
                updatedAt: new Date(this.clock()),
              })
              .where(
                and(
                  eq(imports.id, importId),
                  eq(imports.workspaceId, workspaceId),
                  eq(imports.status, "staging"),
                ),
              )
              .returning();
            if (!updated) throw new Error("JOB_FAILED: import staging transition lost ownership");
            await dispatcher.enqueue({
              workspaceId,
              type: "import",
              payload: {
                workspaceId,
                importId,
                actorId,
                ...(input.noteId ? { noteId: input.noteId, baseRevision: input.baseRevision } : {}),
              },
              idempotencyKey: `import-${importId}`,
            });
            await this.hooks.afterPendingJobInsert?.();
            return toResult(updated);
          },
        });
        return row;
      },
      () => this.markFailedAndScheduleCleanup(importId, workspaceId),
    );
  }

  async getStatus(actorId: string, importId: string): Promise<ImportJobResult> {
    if (!opaqueAuthIdSchema.safeParse(actorId).success) invalidImport(404);
    if (!canonicalUuidSchema.safeParse(importId).success) invalidImport();
    const rows = await this.db
      .select({ import: imports })
      .from(imports)
      .innerJoin(
        workspaceMembers,
        and(
          eq(workspaceMembers.workspaceId, imports.workspaceId),
          eq(workspaceMembers.userId, actorId),
        ),
      )
      .where(and(eq(imports.id, importId), eq(imports.actorId, actorId)))
      .limit(1);
    const row = rows[0]?.import;
    if (!row) invalidImport(404);
    return toResult(row);
  }
}
