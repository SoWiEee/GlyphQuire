import { createHash } from "node:crypto";
import {
  documentJobs,
  noteOperations,
  notes,
  noteVersions,
  workspaceMembers,
  type Database,
  type Note,
  type NoteOperation,
  type NoteVersion,
} from "@glyphquire/database";
import type {
  CheckpointNoteInput,
  CheckpointNoteResult,
  NoteResult,
  NoteVersionResult,
  RestoreNoteVersionInput,
  SaveNoteInput,
} from "@glyphquire/api-contract";
import { MAX_MARKDOWN_BYTES } from "@glyphquire/api-contract";
import { createDocumentEngine } from "@glyphquire/document-engine";
import { PostgresJobDispatcher } from "@glyphquire/queue";
import { and, eq, isNull } from "drizzle-orm";
import { PublicApiError } from "../../middleware/error-handler.js";
import { authorize, type NoteAction } from "./authorization.js";
import { decideSnapshot, utf8ByteLength } from "./snapshot-policy.js";

type DbTransaction = Parameters<Database["transaction"]>[0] extends (tx: infer Tx) => unknown
  ? Tx
  : never;

/**
 * Fault-injection hooks shared with NoteServiceHooks. NoteWriter reuses the
 * exact same hook object NoteServiceImpl already threads through its other
 * mutations, so a single failing-hooks configuration exercises every write
 * path uniformly in tests.
 */
export interface NoteWriterHooks {
  afterAuthorization?(): void | Promise<void>;
  afterValidation?(): void | Promise<void>;
  beforeNoteChange?(): void | Promise<void>;
  afterNoteChange?(): void | Promise<void>;
  beforeSnapshotInsert?(): void | Promise<void>;
  afterSnapshotInsert?(): void | Promise<void>;
  beforeOperationInsert?(): void | Promise<void>;
  afterOperationInsert?(): void | Promise<void>;
  beforeDocumentJobInsert?(): void | Promise<void>;
  afterDocumentJobInsert?(): void | Promise<void>;
}

/** Narrow seam over the document engine so NoteWriter only depends on parsing. */
export interface DocumentValidator {
  parse(markdown: string): { ok: boolean; diagnostics: { severity: string }[] };
}

function defaultDocumentValidator(): DocumentValidator {
  const engine = createDocumentEngine();
  return { parse: (markdown) => engine.parse(markdown) };
}

/** Signals that the unique-scoped operation insert lost a concurrent race. */
class OperationConflict extends Error {}

/** Signals that a compare-and-swap read or update matched zero rows. */
class CasMiss extends Error {}

function isUniqueViolation(error: unknown): boolean {
  const cause =
    error instanceof Error ? (error as Error & { cause?: { code?: string } }).cause : undefined;
  return cause?.code === "23505";
}

function contentHashOf(markdown: string): string {
  return createHash("sha256").update(markdown, "utf8").digest("hex");
}

function canonicalRequestHash(payload: Record<string, unknown>): string {
  const keys = Object.keys(payload).sort();
  return createHash("sha256").update(JSON.stringify(payload, keys), "utf8").digest("hex");
}

function resolveOperationReplay<T>(operation: NoteOperation, canonicalHash: string): T {
  if (operation.requestHash !== canonicalHash) {
    throw new PublicApiError("OPERATION_REUSED", 409);
  }
  return operation.recordedResponse as unknown as T;
}

function toNoteResult(row: Note): NoteResult {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    title: row.title,
    revision: row.revision,
    visibility: row.visibility,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    deletedAt: row.deletedAt ? row.deletedAt.toISOString() : null,
    contentMarkdown: row.contentMarkdown,
    schemaVersion: row.schemaVersion,
  };
}

function toNoteVersionResult(version: NoteVersion, displayName: string): NoteVersionResult {
  return {
    id: version.id,
    noteId: version.noteId,
    revision: version.revision,
    reason: version.reason,
    createdBy: { displayName },
    createdAt: version.createdAt.toISOString(),
    contentMarkdown: version.contentMarkdown,
    schemaVersion: version.schemaVersion,
  };
}

/** Rich conflict payload for a stale `save`: enough for the client to reconcile locally. */
export interface NoteSaveConflictData {
  readonly code: "REVISION_CONFLICT";
  readonly noteId: string;
  readonly serverRevision: number;
  readonly serverMarkdown: string;
  readonly serverUpdatedAt: string;
  readonly lastEditedBy: { readonly displayName: string } | null;
}

/**
 * Thrown only for a genuine (non-replayable) `save` conflict. Carries the
 * data needed to build the API's rich conflict envelope. Deliberately not a
 * PublicApiError: the route layer attaches the request-scoped requestId and
 * serializes this against `noteConflictSchema` instead of the generic error
 * envelope.
 */
export class NoteSaveConflictError extends Error {
  constructor(readonly conflict: NoteSaveConflictData) {
    super("REVISION_CONFLICT");
    this.name = "NoteSaveConflictError";
  }
}

/**
 * Owns the transactional core of every write that can produce note history:
 * autosave, checkpoint, and version restore. Each method performs replay
 * lookup, authorization, CAS, the note mutation, the immutable snapshot
 * decision, operation recording, and the in-transaction `document_jobs`
 * ("outbox") insert and generic derived-search enqueue as one Drizzle
 * transaction. The queue adapter participates only as a transaction-bound
 * row inserter here; workers claim and process those rows independently after
 * commit, so handler failures cannot alter the committed source mutation.
 */
export class NoteWriter {
  constructor(
    private readonly db: Database,
    private readonly documentValidator: DocumentValidator = defaultDocumentValidator(),
    private readonly hooks: NoteWriterHooks = {},
  ) {}

  async save(actorId: string, noteId: string, input: SaveNoteInput): Promise<NoteResult> {
    const { workspaceId } = await this.loadAuthorizedNote(actorId, noteId, "save");
    await this.hooks.afterAuthorization?.();

    this.assertValidContent(input.contentMarkdown);
    await this.hooks.afterValidation?.();

    const canonicalHash = canonicalRequestHash({
      contentMarkdown: input.contentMarkdown,
      baseRevision: input.baseRevision,
    });

    const existingOperation = await this.findOperation(
      actorId,
      workspaceId,
      noteId,
      "save",
      input.operationId,
    );
    if (existingOperation) {
      return resolveOperationReplay<NoteResult>(existingOperation, canonicalHash);
    }

    try {
      return await this.db.transaction(async (tx) => {
        await this.hooks.beforeNoteChange?.();
        const newHash = contentHashOf(input.contentMarkdown);
        const [updated] = await tx
          .update(notes)
          .set({
            contentMarkdown: input.contentMarkdown,
            contentHash: newHash,
            revision: input.baseRevision + 1,
          })
          .where(
            and(
              eq(notes.id, noteId),
              eq(notes.workspaceId, workspaceId),
              eq(notes.revision, input.baseRevision),
              isNull(notes.deletedAt),
            ),
          )
          .returning();
        if (!updated) throw new CasMiss();
        await this.hooks.afterNoteChange?.();

        await this.maybeSnapshot(tx, {
          workspaceId,
          noteId,
          actorId,
          reason: "autosave",
          revision: updated.revision,
          schemaVersion: updated.schemaVersion,
          contentMarkdown: updated.contentMarkdown,
          contentHash: updated.contentHash,
        });

        const response = toNoteResult(updated);
        const operation = await this.insertOperation(tx, {
          workspaceId,
          noteId,
          actorId,
          operationId: input.operationId,
          operationKind: "save",
          baseRevision: input.baseRevision,
          requestHash: canonicalHash,
          recordedResponse: response as unknown as Record<string, unknown>,
        });

        await this.insertDocumentJob(tx, {
          workspaceId,
          noteId,
          noteOperationId: operation.id,
          operationId: input.operationId,
          revision: updated.revision,
        });

        return response;
      });
    } catch (error) {
      if (error instanceof OperationConflict) {
        const raced = await this.findOperation(
          actorId,
          workspaceId,
          noteId,
          "save",
          input.operationId,
        );
        if (raced) return resolveOperationReplay<NoteResult>(raced, canonicalHash);
        throw error;
      }
      if (error instanceof CasMiss) {
        const raced = await this.findOperation(
          actorId,
          workspaceId,
          noteId,
          "save",
          input.operationId,
        );
        if (raced) return resolveOperationReplay<NoteResult>(raced, canonicalHash);
        throw await this.buildSaveConflict(actorId, workspaceId, noteId);
      }
      throw error;
    }
  }

  async checkpoint(
    actorId: string,
    noteId: string,
    input: CheckpointNoteInput,
  ): Promise<CheckpointNoteResult> {
    const { workspaceId } = await this.loadAuthorizedNote(actorId, noteId, "checkpoint");
    await this.hooks.afterAuthorization?.();
    await this.hooks.afterValidation?.();

    const canonicalHash = canonicalRequestHash({ baseRevision: input.baseRevision });
    const existingOperation = await this.findOperation(
      actorId,
      workspaceId,
      noteId,
      "checkpoint",
      input.operationId,
    );
    if (existingOperation) {
      return resolveOperationReplay<CheckpointNoteResult>(existingOperation, canonicalHash);
    }

    const actorDisplayName = await this.displayNameFor(actorId);

    try {
      return await this.db.transaction(async (tx) => {
        await this.hooks.beforeNoteChange?.();
        // Checkpoint changes no content; it only advances the CAS token so
        // concurrent checkpoints and other mutations serialize the same way
        // every other existing-note mutation does.
        const [updated] = await tx
          .update(notes)
          .set({ revision: input.baseRevision + 1 })
          .where(
            and(
              eq(notes.id, noteId),
              eq(notes.workspaceId, workspaceId),
              eq(notes.revision, input.baseRevision),
              isNull(notes.deletedAt),
            ),
          )
          .returning();
        if (!updated) throw new CasMiss();
        await this.hooks.afterNoteChange?.();

        const version = await this.maybeSnapshot(tx, {
          workspaceId,
          noteId,
          actorId,
          reason: "checkpoint",
          revision: updated.revision,
          schemaVersion: updated.schemaVersion,
          contentMarkdown: updated.contentMarkdown,
          contentHash: updated.contentHash,
        });
        if (!version) throw new Error("checkpoint must always produce a version row");

        const response: CheckpointNoteResult = {
          note: toNoteResult(updated),
          version: toNoteVersionResult(version, actorDisplayName),
        };

        const operation = await this.insertOperation(tx, {
          workspaceId,
          noteId,
          actorId,
          operationId: input.operationId,
          operationKind: "checkpoint",
          baseRevision: input.baseRevision,
          requestHash: canonicalHash,
          recordedResponse: response as unknown as Record<string, unknown>,
        });

        await this.insertDocumentJob(tx, {
          workspaceId,
          noteId,
          noteOperationId: operation.id,
          operationId: input.operationId,
          revision: updated.revision,
        });

        return response;
      });
    } catch (error) {
      if (error instanceof OperationConflict) {
        const raced = await this.findOperation(
          actorId,
          workspaceId,
          noteId,
          "checkpoint",
          input.operationId,
        );
        if (raced) return resolveOperationReplay<CheckpointNoteResult>(raced, canonicalHash);
        throw error;
      }
      if (error instanceof CasMiss) {
        const raced = await this.findOperation(
          actorId,
          workspaceId,
          noteId,
          "checkpoint",
          input.operationId,
        );
        if (raced) return resolveOperationReplay<CheckpointNoteResult>(raced, canonicalHash);
        return this.resolveGenericConflict(actorId, workspaceId, noteId);
      }
      throw error;
    }
  }

  async restoreVersion(
    actorId: string,
    noteId: string,
    versionId: string,
    input: RestoreNoteVersionInput,
  ): Promise<NoteResult> {
    const { workspaceId } = await this.loadAuthorizedNote(actorId, noteId, "restoreVersion");
    await this.hooks.afterAuthorization?.();

    const targetVersion = await this.db.query.noteVersions.findFirst({
      where: (table, { and: whereAnd, eq: whereEq }) =>
        whereAnd(
          whereEq(table.id, versionId),
          whereEq(table.noteId, noteId),
          whereEq(table.workspaceId, workspaceId),
        ),
    });
    // A missing or cross-scope version is indistinguishable from a missing
    // note, for the same reason authorize() hides cross-workspace notes.
    if (!targetVersion) throw new PublicApiError("NOTE_NOT_FOUND", 404);

    this.assertValidContent(targetVersion.contentMarkdown);
    await this.hooks.afterValidation?.();

    const canonicalHash = canonicalRequestHash({ versionId, baseRevision: input.baseRevision });
    const existingOperation = await this.findOperation(
      actorId,
      workspaceId,
      noteId,
      "restore_version",
      input.operationId,
    );
    if (existingOperation) {
      return resolveOperationReplay<NoteResult>(existingOperation, canonicalHash);
    }

    try {
      return await this.db.transaction(async (tx) => {
        await this.hooks.beforeNoteChange?.();
        const [current] = await tx
          .select()
          .from(notes)
          .where(
            and(
              eq(notes.id, noteId),
              eq(notes.workspaceId, workspaceId),
              eq(notes.revision, input.baseRevision),
              isNull(notes.deletedAt),
            ),
          )
          .limit(1);
        if (!current) throw new CasMiss();

        // Restore snapshots the current source first, so overwriting it
        // below never loses un-snapshotted content. If the current revision
        // was already snapshotted (e.g. by a prior autosave trigger), this
        // is a harmless no-op: the content at that revision cannot differ.
        await this.maybeSnapshot(tx, {
          workspaceId,
          noteId,
          actorId,
          reason: "autosave",
          revision: current.revision,
          schemaVersion: current.schemaVersion,
          contentMarkdown: current.contentMarkdown,
          contentHash: current.contentHash,
          force: true,
        });

        // The restore itself always advances the revision counter; it never
        // rewinds to the historical version's original revision number.
        const [updated] = await tx
          .update(notes)
          .set({
            contentMarkdown: targetVersion.contentMarkdown,
            contentHash: targetVersion.contentHash,
            schemaVersion: targetVersion.schemaVersion,
            revision: current.revision + 1,
          })
          .where(
            and(
              eq(notes.id, noteId),
              eq(notes.workspaceId, workspaceId),
              eq(notes.revision, current.revision),
              isNull(notes.deletedAt),
            ),
          )
          .returning();
        if (!updated) throw new CasMiss();
        await this.hooks.afterNoteChange?.();

        await this.maybeSnapshot(tx, {
          workspaceId,
          noteId,
          actorId,
          reason: "restore",
          revision: updated.revision,
          schemaVersion: updated.schemaVersion,
          contentMarkdown: updated.contentMarkdown,
          contentHash: updated.contentHash,
        });

        const response = toNoteResult(updated);
        const operation = await this.insertOperation(tx, {
          workspaceId,
          noteId,
          actorId,
          operationId: input.operationId,
          operationKind: "restore_version",
          baseRevision: input.baseRevision,
          requestHash: canonicalHash,
          recordedResponse: response as unknown as Record<string, unknown>,
        });

        await this.insertDocumentJob(tx, {
          workspaceId,
          noteId,
          noteOperationId: operation.id,
          operationId: input.operationId,
          revision: updated.revision,
        });

        return response;
      });
    } catch (error) {
      if (error instanceof OperationConflict) {
        const raced = await this.findOperation(
          actorId,
          workspaceId,
          noteId,
          "restore_version",
          input.operationId,
        );
        if (raced) return resolveOperationReplay<NoteResult>(raced, canonicalHash);
        throw error;
      }
      if (error instanceof CasMiss) {
        const raced = await this.findOperation(
          actorId,
          workspaceId,
          noteId,
          "restore_version",
          input.operationId,
        );
        if (raced) return resolveOperationReplay<NoteResult>(raced, canonicalHash);
        return this.resolveGenericConflict(actorId, workspaceId, noteId);
      }
      throw error;
    }
  }

  /**
   * Validates exact UTF-8 size and the Document Engine's structural result
   * before anything is persisted. Only error-severity diagnostics reject the
   * write (e.g. malformed directive syntax, an unsupported spec version, or
   * a structural rule violation like an empty `tabs` block) — a warning
   * (such as a missing spec-version marker on content that predates this
   * validation) does not, since `create` does not run content through the
   * Document Engine at all and must remain saveable afterward.
   */
  private assertValidContent(markdown: string): void {
    if (utf8ByteLength(markdown) > MAX_MARKDOWN_BYTES) {
      throw new PublicApiError("DOCUMENT_INVALID", 400);
    }
    const parsed = this.documentValidator.parse(markdown);
    const hasErrorDiagnostic = parsed.diagnostics.some(
      (diagnostic) => diagnostic.severity === "error",
    );
    if (hasErrorDiagnostic) {
      throw new PublicApiError("DOCUMENT_INVALID", 400);
    }
  }

  /**
   * Inserts a version row when the snapshot policy triggers or when `force`
   * is true. `force: true` bypasses the size/time policy entirely and always
   * creates a snapshot — used by restoreVersion's pre-overwrite safety
   * snapshot so current content is never silently discarded. When `force` is
   * omitted or false, the normal policy applies: reasons in
   * `FORCED_SNAPSHOT_REASONS` (checkpoint, restore) always snapshot; autosave
   * snapshots only when the size or time trigger fires.
   */
  private async maybeSnapshot(
    tx: DbTransaction,
    params: {
      workspaceId: string;
      noteId: string;
      actorId: string;
      reason: "autosave" | "checkpoint" | "restore";
      revision: number;
      schemaVersion: number;
      contentMarkdown: string;
      contentHash: string;
      force?: boolean;
    },
  ): Promise<NoteVersion | undefined> {
    const latest = await tx.query.noteVersions.findFirst({
      where: (table, { eq: whereEq }) => whereEq(table.noteId, params.noteId),
      orderBy: (table, { desc: whereDesc }) => [whereDesc(table.revision)],
    });

    if (!params.force) {
      const decision = decideSnapshot({
        reason: params.reason,
        currentBytes: utf8ByteLength(params.contentMarkdown),
        snapshotBytes: latest ? utf8ByteLength(latest.contentMarkdown) : 0,
        lastSnapshotAt: latest ? latest.createdAt : null,
        now: new Date(),
      });

      if (!decision.shouldSnapshot) return undefined;
    }

    await this.hooks.beforeSnapshotInsert?.();
    const [version] = await tx
      .insert(noteVersions)
      .values({
        workspaceId: params.workspaceId,
        noteId: params.noteId,
        revision: params.revision,
        schemaVersion: params.schemaVersion,
        contentMarkdown: params.contentMarkdown,
        contentHash: params.contentHash,
        reason: params.reason,
        createdById: params.actorId,
      })
      .onConflictDoNothing()
      .returning();
    await this.hooks.afterSnapshotInsert?.();

    if (version) return version;
    // A concurrent writer already snapshotted this exact (noteId, revision)
    // pair; the content at a fixed revision cannot differ, so read it back.
    return tx.query.noteVersions.findFirst({
      where: (table, { and: whereAnd, eq: whereEq }) =>
        whereAnd(whereEq(table.noteId, params.noteId), whereEq(table.revision, params.revision)),
    });
  }

  private async insertOperation(
    tx: DbTransaction,
    params: {
      workspaceId: string;
      noteId: string;
      actorId: string;
      operationId: string;
      operationKind: "save" | "checkpoint" | "restore_version";
      baseRevision: number;
      requestHash: string;
      recordedResponse: Record<string, unknown>;
    },
  ): Promise<NoteOperation> {
    await this.hooks.beforeOperationInsert?.();
    let operation: NoteOperation | undefined;
    try {
      [operation] = await tx
        .insert(noteOperations)
        .values({
          workspaceId: params.workspaceId,
          noteId: params.noteId,
          actorId: params.actorId,
          operationId: params.operationId,
          operationKind: params.operationKind,
          baseRevision: params.baseRevision,
          requestHash: params.requestHash,
          recordedResponse: params.recordedResponse,
        })
        .returning();
    } catch (error) {
      if (isUniqueViolation(error)) throw new OperationConflict();
      throw error;
    }
    if (!operation) throw new Error("Note operation insert returned no row");
    await this.hooks.afterOperationInsert?.();
    return operation;
  }

  private async insertDocumentJob(
    tx: DbTransaction,
    params: {
      workspaceId: string;
      noteId: string;
      noteOperationId: string;
      operationId: string;
      revision: number;
    },
  ): Promise<void> {
    await this.hooks.beforeDocumentJobInsert?.();
    await tx.insert(documentJobs).values({
      workspaceId: params.workspaceId,
      noteId: params.noteId,
      noteOperationId: params.noteOperationId,
      operationId: params.operationId,
      revision: params.revision,
      kind: "upsert",
    });
    await new PostgresJobDispatcher(tx).enqueue({
      workspaceId: params.workspaceId,
      type: "search.index",
      payload: {
        workspaceId: params.workspaceId,
        noteId: params.noteId,
        revision: params.revision,
        operationId: params.operationId,
      },
      idempotencyKey: `note-${params.noteId}-revision-${params.revision}-operation-${params.operationId}`,
    });
    await this.hooks.afterDocumentJobInsert?.();
  }

  private async loadAuthorizedNote(actorId: string, noteId: string, action: NoteAction) {
    const rows = await this.db
      .select({ note: notes, role: workspaceMembers.role })
      .from(notes)
      .innerJoin(
        workspaceMembers,
        and(
          eq(workspaceMembers.workspaceId, notes.workspaceId),
          eq(workspaceMembers.userId, actorId),
        ),
      )
      .where(and(eq(notes.id, noteId), isNull(notes.deletedAt)))
      .limit(1);

    const row = rows[0];
    if (!row) throw new PublicApiError("NOTE_NOT_FOUND", 404);
    authorize(actorId, action, { role: row.role });
    return { note: row.note, workspaceId: row.note.workspaceId };
  }

  private async findOperation(
    actorId: string,
    workspaceId: string,
    noteId: string,
    operationKind: "save" | "checkpoint" | "restore_version",
    operationId: string,
  ) {
    return this.db.query.noteOperations.findFirst({
      where: (table, { and: whereAnd, eq: whereEq }) =>
        whereAnd(
          whereEq(table.actorId, actorId),
          whereEq(table.workspaceId, workspaceId),
          whereEq(table.noteId, noteId),
          whereEq(table.operationKind, operationKind),
          whereEq(table.operationId, operationId),
        ),
    });
  }

  private async displayNameFor(actorId: string): Promise<string> {
    const row = await this.db.query.user.findFirst({
      columns: { name: true },
      where: (table, { eq: whereEq }) => whereEq(table.id, actorId),
    });
    if (!row) throw new Error("actor user row is missing despite an authenticated session");
    return row.name;
  }

  /** Generic REVISION_CONFLICT for checkpoint/restoreVersion (no rich body). */
  private async resolveGenericConflict(
    actorId: string,
    workspaceId: string,
    noteId: string,
  ): Promise<never> {
    const rows = await this.db
      .select({ id: notes.id })
      .from(notes)
      .innerJoin(
        workspaceMembers,
        and(
          eq(workspaceMembers.workspaceId, notes.workspaceId),
          eq(workspaceMembers.userId, actorId),
        ),
      )
      .where(and(eq(notes.workspaceId, workspaceId), eq(notes.id, noteId), isNull(notes.deletedAt)))
      .limit(1);
    if (rows.length === 0) throw new PublicApiError("NOTE_NOT_FOUND", 404);
    throw new PublicApiError("REVISION_CONFLICT", 409);
  }

  /** Rich REVISION_CONFLICT body for `save`, built only after tenant authorization. */
  private async buildSaveConflict(
    actorId: string,
    workspaceId: string,
    noteId: string,
  ): Promise<never> {
    const rows = await this.db
      .select({ note: notes })
      .from(notes)
      .innerJoin(
        workspaceMembers,
        and(
          eq(workspaceMembers.workspaceId, notes.workspaceId),
          eq(workspaceMembers.userId, actorId),
        ),
      )
      .where(and(eq(notes.workspaceId, workspaceId), eq(notes.id, noteId), isNull(notes.deletedAt)))
      .limit(1);
    const row = rows[0];
    if (!row) throw new PublicApiError("NOTE_NOT_FOUND", 404);

    const lastOperation = await this.db.query.noteOperations.findFirst({
      where: (table, { eq: whereEq }) => whereEq(table.noteId, noteId),
      orderBy: (table, { desc: whereDesc }) => [whereDesc(table.createdAt)],
    });

    let lastEditedBy: { displayName: string } | null = null;
    if (lastOperation) {
      const editor = await this.db.query.user.findFirst({
        columns: { name: true },
        where: (table, { eq: whereEq }) => whereEq(table.id, lastOperation.actorId),
      });
      lastEditedBy = editor ? { displayName: editor.name } : null;
    }

    throw new NoteSaveConflictError({
      code: "REVISION_CONFLICT",
      noteId: row.note.id,
      serverRevision: row.note.revision,
      serverMarkdown: row.note.contentMarkdown,
      serverUpdatedAt: row.note.updatedAt.toISOString(),
      lastEditedBy,
    });
  }
}
