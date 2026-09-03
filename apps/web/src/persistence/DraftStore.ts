import {
  canonicalUuidSchema,
  markdownSchema,
  noteConflictSchema,
  revisionSchema,
} from "@glyphquire/api-contract";
import { z } from "zod";
import { coordinationUserIdSchema } from "../coordination/userIdSchema.js";
import { openDatabase, requestToPromise, runTransaction } from "./idb.js";
import type { NoteConflict } from "@glyphquire/api-contract";
import type { DatabaseConfig } from "./idb.js";

/** Identifies one note's local draft, scoped to the signed-in user and workspace. */
export interface DraftKey {
  readonly userId: string;
  readonly workspaceId: string;
  readonly noteId: string;
}

/**
 * A locally-buffered edit for a note that has not yet been (or failed to be)
 * acknowledged by the server. `baseRevision` and `operationId` mirror the
 * same fields the save API expects, so a recovered draft can be resubmitted
 * exactly as originally intended — replay-safe, no new operation minted.
 */
export interface DraftRecord extends DraftKey {
  readonly operationId: string;
  readonly baseRevision: number;
  readonly markdown: string;
  /** Absent only for records written before conflict persistence was introduced. */
  readonly conflict?: NoteConflict | null;
  /** Epoch milliseconds, from the injected clock — never `Date.now()` directly. */
  readonly updatedAt: number;
}

export interface DraftClock {
  now(): number;
}

const systemClock: DraftClock = { now: () => Date.now() };

export const DRAFT_DB_NAME = "glyphquire-drafts";
export const DRAFT_DB_VERSION = 2;
export const DRAFT_STORE_NAME = "drafts";
const USER_ID_INDEX = "byUserId";
const USER_UPDATED_AT_INDEX = "byUserUpdatedAt";

/** Drafts survive at most this long unresolved before they are treated as gone. */
export const DRAFT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
/** Hard cap on the number of drafts kept for each user sharing this browser profile. */
export const DRAFT_MAX_COUNT = 50;

const draftKeySchema = z
  .object({
    userId: coordinationUserIdSchema,
    workspaceId: canonicalUuidSchema,
    noteId: canonicalUuidSchema,
  })
  .strict();

/**
 * Validates a value recovered from IndexedDB before it is ever handed back
 * to a caller. IndexedDB enforces nothing about a record's shape beyond its
 * key — every other field must be treated the same as any other untrusted
 * input crossing a system boundary.
 */
const draftRecordFieldsSchema = draftKeySchema.extend({
  operationId: canonicalUuidSchema,
  baseRevision: revisionSchema,
  markdown: markdownSchema,
  conflict: noteConflictSchema.nullable().optional(),
  updatedAt: z.number().int().safe().nonnegative(),
});

function validateConflictBinding(
  value: { noteId: string; baseRevision: number; conflict?: NoteConflict | null },
  context: z.RefinementCtx,
): void {
  if (
    value.conflict &&
    (value.conflict.noteId !== value.noteId || value.conflict.serverRevision !== value.baseRevision)
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["conflict"],
      message: "Conflict identity and revision must match the draft",
    });
  }
}

const draftRecordInputSchema = draftRecordFieldsSchema.superRefine(validateConflictBinding);
const draftRecordSchema = draftRecordFieldsSchema
  .extend({ id: z.string().min(1) })
  .superRefine(validateConflictBinding);

const SEPARATOR = "::";

/**
 * The IndexedDB primary key for a draft. Deliberately encodes the same three
 * fields the record body also carries (see `draftRecordSchema`) — the two
 * are cross-checked on every read so a record whose body was altered without
 * going through `put` (a corrupted write, a manually poked IndexedDB entry)
 * is rejected rather than silently trusted.
 */
export function draftRecordId(key: DraftKey): string {
  const validated = draftKeySchema.parse(key);
  return [validated.userId, validated.workspaceId, validated.noteId].join(SEPARATOR);
}

function databaseConfig(): DatabaseConfig {
  return {
    name: DRAFT_DB_NAME,
    version: DRAFT_DB_VERSION,
    stores: [
      {
        name: DRAFT_STORE_NAME,
        keyPath: "id",
        indexes: [
          { name: USER_ID_INDEX, keyPath: "userId" },
          { name: USER_UPDATED_AT_INDEX, keyPath: ["userId", "updatedAt"] },
        ],
      },
    ],
  };
}

export interface DraftStore {
  put(record: DraftRecord): Promise<void>;
  get(key: DraftKey): Promise<DraftRecord | undefined>;
  delete(key: DraftKey): Promise<void>;
  clearForUser(userId: string): Promise<void>;
}

export interface IndexedDbDraftStoreOptions {
  clock?: DraftClock;
  indexedDbFactory?: IDBFactory;
}

/**
 * The sole place browser-side code persists unsaved note edits. Every read
 * revalidates the recovered record (shape, and that its embedded key fields
 * agree with the IndexedDB key it was stored under) and enforces the 30-day
 * expiry and 50-draft cap, so callers never need to re-derive those rules.
 */
export class IndexedDbDraftStore implements DraftStore {
  private readonly clock: DraftClock;
  private readonly indexedDbFactory: IDBFactory | undefined;
  private dbPromise: Promise<IDBDatabase> | undefined;

  constructor(options: IndexedDbDraftStoreOptions = {}) {
    this.clock = options.clock ?? systemClock;
    this.indexedDbFactory = options.indexedDbFactory;
  }

  async put(record: DraftRecord): Promise<void> {
    const validatedRecord = draftRecordInputSchema.parse(record);
    if (validatedRecord.updatedAt > this.clock.now()) {
      throw new Error("Draft updatedAt cannot be in the future");
    }
    const db = await this.openDb();
    const id = draftRecordId({
      userId: validatedRecord.userId,
      workspaceId: validatedRecord.workspaceId,
      noteId: validatedRecord.noteId,
    });
    await runTransaction(db, [DRAFT_STORE_NAME], "readwrite", async (tx) => {
      const store = tx.objectStore(DRAFT_STORE_NAME);
      await requestToPromise(store.put({ ...validatedRecord, id }));
      await this.evictOverflow(store, validatedRecord.userId);
    });
  }

  async get(key: DraftKey): Promise<DraftRecord | undefined> {
    const validatedKey = draftKeySchema.parse(key);
    const db = await this.openDb();
    const id = draftRecordId(validatedKey);
    const raw = await runTransaction(db, [DRAFT_STORE_NAME], "readwrite", async (tx) => {
      const store = tx.objectStore(DRAFT_STORE_NAME);
      const found = await requestToPromise<unknown>(store.get(id));
      if (found === undefined) return undefined;

      const parsed = draftRecordSchema.safeParse(found);
      if (!parsed.success) {
        await requestToPromise(store.delete(id));
        return undefined;
      }
      const value = parsed.data;
      const keyMatches =
        value.userId === validatedKey.userId &&
        value.workspaceId === validatedKey.workspaceId &&
        value.noteId === validatedKey.noteId &&
        (!value.conflict ||
          (value.conflict.noteId === validatedKey.noteId &&
            value.conflict.serverRevision === value.baseRevision));
      if (!keyMatches) {
        await requestToPromise(store.delete(id));
        return undefined;
      }
      const age = this.clock.now() - value.updatedAt;
      if (age < 0 || age > DRAFT_MAX_AGE_MS) {
        await requestToPromise(store.delete(id));
        return undefined;
      }
      return value;
    });

    if (!raw) return undefined;
    const { id: _discardStorageId, ...record } = raw;
    return record;
  }

  async delete(key: DraftKey): Promise<void> {
    const validatedKey = draftKeySchema.parse(key);
    const db = await this.openDb();
    const id = draftRecordId(validatedKey);
    await runTransaction(db, [DRAFT_STORE_NAME], "readwrite", (tx) => {
      tx.objectStore(DRAFT_STORE_NAME).delete(id);
    });
  }

  async clearForUser(userId: string): Promise<void> {
    const validatedUserId = coordinationUserIdSchema.parse(userId);
    const db = await this.openDb();
    await runTransaction(db, [DRAFT_STORE_NAME], "readwrite", async (tx) => {
      const index = tx.objectStore(DRAFT_STORE_NAME).index(USER_ID_INDEX);
      await this.deleteAllMatching(index, IDBKeyRange.only(validatedUserId));
    });
  }

  /** Deletes only this user's oldest drafts while that user exceeds the cap. */
  private async evictOverflow(store: IDBObjectStore, userId: string): Promise<void> {
    const userRange = IDBKeyRange.only(userId);
    const count = await requestToPromise(store.index(USER_ID_INDEX).count(userRange));
    let remaining = count - DRAFT_MAX_COUNT;
    if (remaining <= 0) return;

    const index = store.index(USER_UPDATED_AT_INDEX);
    const oldestFirst = IDBKeyRange.bound([userId, 0], [userId, Number.MAX_SAFE_INTEGER]);
    await new Promise<void>((resolve, reject) => {
      const cursorRequest = index.openCursor(oldestFirst);
      cursorRequest.onsuccess = () => {
        const cursor = cursorRequest.result;
        if (!cursor || remaining <= 0) {
          resolve();
          return;
        }
        cursor.delete();
        remaining -= 1;
        cursor.continue();
      };
      cursorRequest.onerror = () =>
        reject(cursorRequest.error ?? new Error("Eviction cursor failed"));
    });
  }

  private async deleteAllMatching(index: IDBIndex, range: IDBKeyRange): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const cursorRequest = index.openCursor(range);
      cursorRequest.onsuccess = () => {
        const cursor = cursorRequest.result;
        if (!cursor) {
          resolve();
          return;
        }
        cursor.delete();
        cursor.continue();
      };
      cursorRequest.onerror = () =>
        reject(cursorRequest.error ?? new Error("Deletion cursor failed"));
    });
  }

  private openDb(): Promise<IDBDatabase> {
    if (!this.dbPromise) {
      this.dbPromise = openDatabase(databaseConfig(), this.indexedDbFactory);
    }
    return this.dbPromise;
  }
}
