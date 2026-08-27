import { createHash } from "node:crypto";
import {
  documentJobs,
  noteOperations,
  notes,
  noteVersions,
  user,
  workspaceMembers,
  type Database,
  type DocumentJobKind,
  type Note,
  type NoteOperation,
  type NoteOperationKind,
} from "@glyphquire/database";
import type {
  CheckpointNoteInput,
  CheckpointNoteResult,
  CreateNoteServiceInput,
  CursorPaginationQuery,
  DeleteNoteInput,
  ListNotesInput,
  NotePage,
  NoteResult,
  NoteSummary,
  NoteVersionPage,
  NoteVersionResult,
  RenameNoteInput,
  RestoreNoteInput,
  RestoreNoteVersionInput,
  SaveNoteInput,
} from "@glyphquire/api-contract";
import { PostgresJobDispatcher } from "@glyphquire/queue";
import { and, desc, eq, isNotNull, isNull, lt, or } from "drizzle-orm";
import { PublicApiError } from "../../middleware/error-handler.js";
import { authorize, type NoteAction } from "./authorization.js";
import { NoteWriter, type DocumentValidator, type NoteWriterHooks } from "./NoteWriter.js";

type DbTransaction = Parameters<Database["transaction"]>[0] extends (tx: infer Tx) => unknown
  ? Tx
  : never;

type DeletionState = "active" | "deleted";

/**
 * Fault-injection hooks for exercising transaction atomicity in tests.
 * Extends NoteWriterHooks so the exact same failing-hooks object exercises
 * every write path uniformly: create/rename/softDelete/restore's own
 * transactions here, and save/checkpoint/restoreVersion's transactions in
 * NoteWriter.
 */
export interface NoteServiceHooks extends NoteWriterHooks {
  beforeNoteChange?(): void | Promise<void>;
  afterNoteChange?(): void | Promise<void>;
  beforeOperationInsert?(): void | Promise<void>;
  afterOperationInsert?(): void | Promise<void>;
  beforeDocumentJobInsert?(): void | Promise<void>;
  afterDocumentJobInsert?(): void | Promise<void>;
}

export interface NoteService {
  list(actorId: string, input: ListNotesInput): Promise<NotePage>;
  create(actorId: string, input: CreateNoteServiceInput): Promise<NoteResult>;
  get(actorId: string, noteId: string): Promise<NoteResult>;
  rename(actorId: string, noteId: string, input: RenameNoteInput): Promise<NoteResult>;
  softDelete(actorId: string, noteId: string, input: DeleteNoteInput): Promise<NoteResult>;
  restore(actorId: string, noteId: string, input: RestoreNoteInput): Promise<NoteResult>;
  save(actorId: string, noteId: string, input: SaveNoteInput): Promise<NoteResult>;
  checkpoint(
    actorId: string,
    noteId: string,
    input: CheckpointNoteInput,
  ): Promise<CheckpointNoteResult>;
  listVersions(
    actorId: string,
    noteId: string,
    input: CursorPaginationQuery,
  ): Promise<NoteVersionPage>;
  getVersion(actorId: string, noteId: string, versionId: string): Promise<NoteVersionResult>;
  restoreVersion(
    actorId: string,
    noteId: string,
    versionId: string,
    input: RestoreNoteVersionInput,
  ): Promise<NoteResult>;
}

/** Signals that the unique-scoped operation insert lost a concurrent race. */
class OperationConflict extends Error {}

/** Signals that a compare-and-swap update matched zero rows. */
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

function toNoteSummary(row: Note): NoteSummary {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    title: row.title,
    revision: row.revision,
    visibility: row.visibility,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    deletedAt: row.deletedAt ? row.deletedAt.toISOString() : null,
  };
}

function toNoteResult(row: Note): NoteResult {
  return {
    ...toNoteSummary(row),
    contentMarkdown: row.contentMarkdown,
    schemaVersion: row.schemaVersion,
  };
}

function resolveOperationReplay(operation: NoteOperation, canonicalHash: string): NoteResult {
  if (operation.requestHash !== canonicalHash) {
    throw new PublicApiError("OPERATION_REUSED", 409);
  }
  return operation.recordedResponse as unknown as NoteResult;
}

const CURSOR_DELIMITER = "|";

function encodeCursor(updatedAt: Date, id: string): string {
  return Buffer.from(`${updatedAt.toISOString()}${CURSOR_DELIMITER}${id}`, "utf8").toString(
    "base64url",
  );
}

function decodeCursor(cursor: string): { updatedAt: Date; id: string } {
  try {
    const decoded = Buffer.from(cursor, "base64url").toString("utf8");
    const separatorIndex = decoded.indexOf(CURSOR_DELIMITER);
    if (separatorIndex === -1) throw new Error("malformed cursor");
    const iso = decoded.slice(0, separatorIndex);
    const id = decoded.slice(separatorIndex + 1);
    const updatedAt = new Date(iso);
    if (!id || Number.isNaN(updatedAt.getTime())) throw new Error("malformed cursor");
    return { updatedAt, id };
  } catch {
    throw new PublicApiError("DOCUMENT_INVALID", 400);
  }
}

const VERSION_CURSOR_DELIMITER = "|";

function encodeVersionCursor(revision: number, id: string): string {
  return Buffer.from(`${revision}${VERSION_CURSOR_DELIMITER}${id}`, "utf8").toString("base64url");
}

function decodeVersionCursor(cursor: string): { revision: number; id: string } {
  try {
    const decoded = Buffer.from(cursor, "base64url").toString("utf8");
    const separatorIndex = decoded.indexOf(VERSION_CURSOR_DELIMITER);
    if (separatorIndex === -1) throw new Error("malformed cursor");
    const revision = Number(decoded.slice(0, separatorIndex));
    const id = decoded.slice(separatorIndex + 1);
    if (!id || !Number.isInteger(revision) || revision <= 0) throw new Error("malformed cursor");
    return { revision, id };
  } catch {
    throw new PublicApiError("DOCUMENT_INVALID", 400);
  }
}

function toNoteVersionSummary(row: {
  id: string;
  noteId: string;
  revision: number;
  reason: NoteVersionResult["reason"];
  createdAt: Date;
  createdByName: string;
}) {
  return {
    id: row.id,
    noteId: row.noteId,
    revision: row.revision,
    reason: row.reason,
    createdBy: { displayName: row.createdByName },
    createdAt: row.createdAt.toISOString(),
  };
}

export class NoteServiceImpl implements NoteService {
  private readonly noteWriter: NoteWriter;

  constructor(
    private readonly db: Database,
    private readonly hooks: NoteServiceHooks = {},
    documentValidator?: DocumentValidator,
  ) {
    this.noteWriter = new NoteWriter(db, documentValidator, hooks);
  }

  async save(actorId: string, noteId: string, input: SaveNoteInput): Promise<NoteResult> {
    return this.noteWriter.save(actorId, noteId, input);
  }

  async checkpoint(
    actorId: string,
    noteId: string,
    input: CheckpointNoteInput,
  ): Promise<CheckpointNoteResult> {
    return this.noteWriter.checkpoint(actorId, noteId, input);
  }

  async restoreVersion(
    actorId: string,
    noteId: string,
    versionId: string,
    input: RestoreNoteVersionInput,
  ): Promise<NoteResult> {
    return this.noteWriter.restoreVersion(actorId, noteId, versionId, input);
  }

  async listVersions(
    actorId: string,
    noteId: string,
    input: CursorPaginationQuery,
  ): Promise<NoteVersionPage> {
    const { workspaceId } = await this.loadAuthorizedNote(actorId, noteId, "listVersions");
    const cursor = input.cursor ? decodeVersionCursor(input.cursor) : undefined;
    const conditions = [eq(noteVersions.noteId, noteId), eq(noteVersions.workspaceId, workspaceId)];
    if (cursor) {
      conditions.push(
        or(
          lt(noteVersions.revision, cursor.revision),
          and(eq(noteVersions.revision, cursor.revision), lt(noteVersions.id, cursor.id)),
        )!,
      );
    }

    const rows = await this.db
      .select({
        id: noteVersions.id,
        noteId: noteVersions.noteId,
        revision: noteVersions.revision,
        reason: noteVersions.reason,
        createdAt: noteVersions.createdAt,
        createdByName: user.name,
      })
      .from(noteVersions)
      .innerJoin(user, eq(user.id, noteVersions.createdById))
      .where(and(...conditions))
      .orderBy(desc(noteVersions.revision), desc(noteVersions.id))
      .limit(input.pageSize + 1);

    const hasMore = rows.length > input.pageSize;
    const page = hasMore ? rows.slice(0, input.pageSize) : rows;
    const last = page[page.length - 1];

    return {
      items: page.map((row) => toNoteVersionSummary(row)),
      nextCursor: hasMore && last ? encodeVersionCursor(last.revision, last.id) : null,
    };
  }

  async getVersion(actorId: string, noteId: string, versionId: string): Promise<NoteVersionResult> {
    const { workspaceId } = await this.loadAuthorizedNote(actorId, noteId, "getVersion");
    const rows = await this.db
      .select({
        id: noteVersions.id,
        noteId: noteVersions.noteId,
        revision: noteVersions.revision,
        reason: noteVersions.reason,
        createdAt: noteVersions.createdAt,
        createdByName: user.name,
        contentMarkdown: noteVersions.contentMarkdown,
        schemaVersion: noteVersions.schemaVersion,
      })
      .from(noteVersions)
      .innerJoin(user, eq(user.id, noteVersions.createdById))
      .where(
        and(
          eq(noteVersions.id, versionId),
          eq(noteVersions.noteId, noteId),
          eq(noteVersions.workspaceId, workspaceId),
        ),
      )
      .limit(1);

    const found = rows[0];
    if (!found) throw new PublicApiError("NOTE_NOT_FOUND", 404);
    return {
      ...toNoteVersionSummary(found),
      contentMarkdown: found.contentMarkdown,
      schemaVersion: found.schemaVersion,
    };
  }

  async list(actorId: string, input: ListNotesInput): Promise<NotePage> {
    const membership = await this.membershipFor(actorId, input.workspaceId);
    authorize(actorId, "list", membership);

    const cursor = input.cursor ? decodeCursor(input.cursor) : undefined;
    const conditions = [eq(notes.workspaceId, input.workspaceId), isNull(notes.deletedAt)];
    if (cursor) {
      conditions.push(
        or(
          lt(notes.updatedAt, cursor.updatedAt),
          and(eq(notes.updatedAt, cursor.updatedAt), lt(notes.id, cursor.id)),
        )!,
      );
    }

    const rows = await this.db
      .select({
        id: notes.id,
        workspaceId: notes.workspaceId,
        title: notes.title,
        revision: notes.revision,
        visibility: notes.visibility,
        createdAt: notes.createdAt,
        updatedAt: notes.updatedAt,
        deletedAt: notes.deletedAt,
      })
      .from(notes)
      .innerJoin(
        workspaceMembers,
        and(
          eq(workspaceMembers.workspaceId, notes.workspaceId),
          eq(workspaceMembers.userId, actorId),
        ),
      )
      .where(and(...conditions))
      .orderBy(desc(notes.updatedAt), desc(notes.id))
      .limit(input.pageSize + 1);

    const hasMore = rows.length > input.pageSize;
    const page = hasMore ? rows.slice(0, input.pageSize) : rows;
    const last = page[page.length - 1];

    return {
      items: page.map((row) => ({
        id: row.id,
        workspaceId: row.workspaceId,
        title: row.title,
        revision: row.revision,
        visibility: row.visibility,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
        deletedAt: row.deletedAt ? row.deletedAt.toISOString() : null,
      })),
      nextCursor: hasMore && last ? encodeCursor(last.updatedAt, last.id) : null,
    };
  }

  async create(actorId: string, input: CreateNoteServiceInput): Promise<NoteResult> {
    const membership = await this.membershipFor(actorId, input.workspaceId);
    authorize(actorId, "create", membership);

    const canonicalHash = canonicalRequestHash({
      title: input.title,
      contentMarkdown: input.contentMarkdown,
      visibility: input.visibility,
    });

    const existingOperation = await this.findCreateOperation(
      actorId,
      input.workspaceId,
      input.operationId,
    );
    if (existingOperation) {
      return resolveOperationReplay(existingOperation, canonicalHash);
    }

    try {
      return await this.db.transaction(async (tx) => {
        await this.hooks.beforeNoteChange?.();
        const [note] = await tx
          .insert(notes)
          .values({
            workspaceId: input.workspaceId,
            title: input.title,
            contentMarkdown: input.contentMarkdown,
            contentHash: contentHashOf(input.contentMarkdown),
            ownerId: actorId,
            visibility: input.visibility,
          })
          .returning();
        if (!note) throw new Error("Note insert returned no row");
        await this.hooks.afterNoteChange?.();

        const response = toNoteResult(note);

        await this.hooks.beforeOperationInsert?.();
        let operation: NoteOperation | undefined;
        try {
          [operation] = await tx
            .insert(noteOperations)
            .values({
              workspaceId: input.workspaceId,
              noteId: note.id,
              actorId,
              operationId: input.operationId,
              operationKind: "create",
              baseRevision: null,
              requestHash: canonicalHash,
              recordedResponse: response as unknown as Record<string, unknown>,
            })
            .returning();
        } catch (error) {
          if (isUniqueViolation(error)) throw new OperationConflict();
          throw error;
        }
        if (!operation) throw new Error("Note operation insert returned no row");
        await this.hooks.afterOperationInsert?.();

        await this.hooks.beforeDocumentJobInsert?.();
        await tx.insert(documentJobs).values({
          workspaceId: input.workspaceId,
          noteId: note.id,
          noteOperationId: operation.id,
          operationId: input.operationId,
          revision: note.revision,
          kind: "upsert",
        });
        await this.insertDerivedSearchJob(tx, {
          workspaceId: input.workspaceId,
          noteId: note.id,
          operationId: input.operationId,
          revision: note.revision,
          kind: "upsert",
        });
        await this.hooks.afterDocumentJobInsert?.();

        return response;
      });
    } catch (error) {
      if (error instanceof OperationConflict) {
        const raced = await this.findCreateOperation(actorId, input.workspaceId, input.operationId);
        if (raced) return resolveOperationReplay(raced, canonicalHash);
      }
      throw error;
    }
  }

  async get(actorId: string, noteId: string): Promise<NoteResult> {
    const { note } = await this.loadAuthorizedNote(actorId, noteId, "get");
    return toNoteResult(note);
  }

  async rename(actorId: string, noteId: string, input: RenameNoteInput): Promise<NoteResult> {
    return this.performExistingMutation({
      actorId,
      noteId,
      action: "rename",
      operationKind: "rename",
      operationId: input.operationId,
      baseRevision: input.baseRevision,
      hashPayload: { title: input.title, baseRevision: input.baseRevision },
      requiredDeletedState: "active",
      jobKind: "upsert",
      applyChanges: () => ({ title: input.title }),
    });
  }

  async softDelete(actorId: string, noteId: string, input: DeleteNoteInput): Promise<NoteResult> {
    return this.performExistingMutation({
      actorId,
      noteId,
      action: "softDelete",
      operationKind: "delete",
      operationId: input.operationId,
      baseRevision: input.baseRevision,
      hashPayload: { baseRevision: input.baseRevision },
      requiredDeletedState: "active",
      jobKind: "delete",
      applyChanges: () => ({ deletedAt: new Date() }),
    });
  }

  async restore(actorId: string, noteId: string, input: RestoreNoteInput): Promise<NoteResult> {
    return this.performExistingMutation({
      actorId,
      noteId,
      action: "restore",
      operationKind: "restore",
      operationId: input.operationId,
      baseRevision: input.baseRevision,
      hashPayload: { baseRevision: input.baseRevision },
      requiredDeletedState: "deleted",
      jobKind: "upsert",
      applyChanges: () => ({ deletedAt: null }),
    });
  }

  private async membershipFor(actorId: string, workspaceId: string) {
    return this.db.query.workspaceMembers.findFirst({
      columns: { role: true },
      where: (table, { and: whereAnd, eq: whereEq }) =>
        whereAnd(whereEq(table.workspaceId, workspaceId), whereEq(table.userId, actorId)),
    });
  }

  private async loadAuthorizedNote(actorId: string, noteId: string, action: NoteAction) {
    const requiredDeletedState: DeletionState = action === "restore" ? "deleted" : "active";
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
      .where(
        and(
          eq(notes.id, noteId),
          requiredDeletedState === "active" ? isNull(notes.deletedAt) : isNotNull(notes.deletedAt),
        ),
      )
      .limit(1);

    const row = rows[0];
    if (!row) throw new PublicApiError("NOTE_NOT_FOUND", 404);
    authorize(actorId, action, { role: row.role });
    return { note: row.note, role: row.role, workspaceId: row.note.workspaceId };
  }

  private async findOperation(
    actorId: string,
    workspaceId: string,
    noteId: string,
    operationKind: NoteOperationKind,
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

  private async findCreateOperation(actorId: string, workspaceId: string, operationId: string) {
    return this.db.query.noteOperations.findFirst({
      where: (table, { and: whereAnd, eq: whereEq }) =>
        whereAnd(
          whereEq(table.actorId, actorId),
          whereEq(table.workspaceId, workspaceId),
          whereEq(table.operationKind, "create"),
          whereEq(table.operationId, operationId),
        ),
    });
  }

  private async resolveMutationConflict(
    actorId: string,
    workspaceId: string,
    noteId: string,
    requiredDeletedState: DeletionState,
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
      .where(
        and(
          eq(notes.workspaceId, workspaceId),
          eq(notes.id, noteId),
          requiredDeletedState === "active" ? isNull(notes.deletedAt) : isNotNull(notes.deletedAt),
        ),
      )
      .limit(1);

    if (rows.length === 0) throw new PublicApiError("NOTE_NOT_FOUND", 404);
    throw new PublicApiError("REVISION_CONFLICT", 409);
  }

  private async performExistingMutation(params: {
    actorId: string;
    noteId: string;
    action: NoteAction;
    operationKind: NoteOperationKind;
    operationId: string;
    baseRevision: number;
    hashPayload: Record<string, unknown>;
    requiredDeletedState: DeletionState;
    jobKind: DocumentJobKind;
    applyChanges: () => Partial<{ title: string; deletedAt: Date | null }>;
  }): Promise<NoteResult> {
    const {
      actorId,
      noteId,
      action,
      operationKind,
      operationId,
      baseRevision,
      hashPayload,
      requiredDeletedState,
      jobKind,
      applyChanges,
    } = params;

    const { workspaceId } = await this.loadAuthorizedNote(actorId, noteId, action);
    const canonicalHash = canonicalRequestHash(hashPayload);

    const existingOperation = await this.findOperation(
      actorId,
      workspaceId,
      noteId,
      operationKind,
      operationId,
    );
    if (existingOperation) {
      return resolveOperationReplay(existingOperation, canonicalHash);
    }

    try {
      return await this.db.transaction(async (tx: DbTransaction) => {
        await this.hooks.beforeNoteChange?.();
        const [updated] = await tx
          .update(notes)
          .set({ ...applyChanges(), revision: baseRevision + 1 })
          .where(
            and(
              eq(notes.id, noteId),
              eq(notes.workspaceId, workspaceId),
              eq(notes.revision, baseRevision),
              requiredDeletedState === "active"
                ? isNull(notes.deletedAt)
                : isNotNull(notes.deletedAt),
            ),
          )
          .returning();
        if (!updated) throw new CasMiss();
        await this.hooks.afterNoteChange?.();

        const response = toNoteResult(updated);

        await this.hooks.beforeOperationInsert?.();
        const [operation] = await tx
          .insert(noteOperations)
          .values({
            workspaceId,
            noteId,
            actorId,
            operationId,
            operationKind,
            baseRevision,
            requestHash: canonicalHash,
            recordedResponse: response as unknown as Record<string, unknown>,
          })
          .returning();
        if (!operation) throw new Error("Note operation insert returned no row");
        await this.hooks.afterOperationInsert?.();

        await this.hooks.beforeDocumentJobInsert?.();
        await tx.insert(documentJobs).values({
          workspaceId,
          noteId,
          noteOperationId: operation.id,
          operationId,
          revision: updated.revision,
          kind: jobKind,
        });
        await this.insertDerivedSearchJob(tx, {
          workspaceId,
          noteId,
          operationId,
          revision: updated.revision,
          kind: jobKind,
        });
        await this.hooks.afterDocumentJobInsert?.();

        return response;
      });
    } catch (error) {
      if (error instanceof CasMiss) {
        const raced = await this.findOperation(
          actorId,
          workspaceId,
          noteId,
          operationKind,
          operationId,
        );
        if (raced) return resolveOperationReplay(raced, canonicalHash);
        return this.resolveMutationConflict(actorId, workspaceId, noteId, requiredDeletedState);
      }
      throw error;
    }
  }

  private async insertDerivedSearchJob(
    tx: DbTransaction,
    params: {
      workspaceId: string;
      noteId: string;
      operationId: string;
      revision: number;
      kind: DocumentJobKind;
    },
  ): Promise<void> {
    const type = params.kind === "delete" ? "search.remove" : "search.index";
    await new PostgresJobDispatcher(tx).enqueue({
      workspaceId: params.workspaceId,
      type,
      payload: {
        workspaceId: params.workspaceId,
        noteId: params.noteId,
        revision: params.revision,
        operationId: params.operationId,
      },
      idempotencyKey: `note-${params.noteId}-revision-${params.revision}-operation-${params.operationId}`,
    });
  }
}
