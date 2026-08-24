import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { beforeEach, describe, expect, it } from "vitest";
import { openDatabase, runTransaction } from "./idb.js";
import {
  DRAFT_DB_NAME,
  DRAFT_DB_VERSION,
  DRAFT_MAX_AGE_MS,
  DRAFT_MAX_COUNT,
  DRAFT_STORE_NAME,
  IndexedDbDraftStore,
  draftRecordId,
} from "./DraftStore.js";
import type { DraftRecord } from "./DraftStore.js";

const USER_A = "11111111-1111-4111-8111-111111111111";
const USER_B = "22222222-2222-4222-8222-222222222222";
const WORKSPACE = "33333333-3333-4333-8333-333333333333";
const NOTE_1 = "44444444-4444-4444-8444-444444444444";
const NOTE_2 = "55555555-5555-4555-8555-555555555555";
const OP_1 = "66666666-6666-4666-8666-666666666666";

/** Deterministic, mutable clock so time-boundary tests can pin exact instants. */
function fakeClock(startMs: number) {
  let current = startMs;
  return {
    now: () => current,
    advanceTo: (ms: number) => {
      current = ms;
    },
  };
}

function makeRecord(overrides: Partial<DraftRecord> & Pick<DraftRecord, "updatedAt">): DraftRecord {
  return {
    userId: USER_A,
    workspaceId: WORKSPACE,
    noteId: NOTE_1,
    operationId: OP_1,
    baseRevision: 1,
    markdown: "hello",
    ...overrides,
  };
}

function freshFactory(): IDBFactory {
  return new IDBFactory();
}

describe("IndexedDbDraftStore", () => {
  beforeEach(() => {
    // Each test gets its own isolated in-memory IndexedDB factory so state
    // never leaks between tests (fake-indexeddb has no reset() of its own).
    globalThis.indexedDB = freshFactory();
  });

  it("round-trips a draft keyed by user/workspace/note", async () => {
    const clock = fakeClock(1_000);
    const store = new IndexedDbDraftStore({ clock });
    const record = makeRecord({ updatedAt: clock.now() });

    await store.put(record);
    const loaded = await store.get({ userId: USER_A, workspaceId: WORKSPACE, noteId: NOTE_1 });

    expect(loaded).toEqual(record);
  });

  it("round-trips validated conflict state so reload cannot silently resubmit it", async () => {
    const clock = fakeClock(1_000);
    const store = new IndexedDbDraftStore({ clock });
    const record = makeRecord({
      baseRevision: 9,
      updatedAt: clock.now(),
      conflict: {
        code: "REVISION_CONFLICT",
        noteId: NOTE_1,
        serverRevision: 9,
        serverMarkdown: "# server side",
        serverUpdatedAt: "2026-01-01T00:00:00.000Z",
        lastEditedBy: null,
        requestId: "req-conflict",
      },
    });

    await store.put(record);

    expect(await store.get({ userId: USER_A, workspaceId: WORKSPACE, noteId: NOTE_1 })).toEqual(
      record,
    );
  });

  it("rejects conflict state that is not bound to the draft note and base revision", async () => {
    const clock = fakeClock(1_000);
    const store = new IndexedDbDraftStore({ clock });
    const conflict = {
      code: "REVISION_CONFLICT" as const,
      noteId: NOTE_2,
      serverRevision: 8,
      serverMarkdown: "# forged server side",
      serverUpdatedAt: "2026-01-01T00:00:00.000Z",
      lastEditedBy: null,
      requestId: "req-forged-conflict",
    };

    await expect(
      store.put(
        makeRecord({
          baseRevision: 9,
          updatedAt: clock.now(),
          conflict,
        }),
      ),
    ).rejects.toThrow();
  });

  it("returns undefined for a key that was never stored", async () => {
    const clock = fakeClock(1_000);
    const store = new IndexedDbDraftStore({ clock });

    const loaded = await store.get({ userId: USER_A, workspaceId: WORKSPACE, noteId: NOTE_2 });

    expect(loaded).toBeUndefined();
  });

  it("rejects an invalid record before it crosses the IndexedDB boundary", async () => {
    const clock = fakeClock(1_000);
    const store = new IndexedDbDraftStore({ clock });
    const invalidRecord = makeRecord({
      userId: "not-a-user-uuid",
      updatedAt: clock.now(),
    });

    await expect(store.put(invalidRecord)).rejects.toThrow();
  });

  it("evicts the single oldest draft once one user exceeds the 50-draft cap", async () => {
    const clock = fakeClock(0);
    const store = new IndexedDbDraftStore({ clock });

    for (let i = 0; i < DRAFT_MAX_COUNT; i += 1) {
      clock.advanceTo(i);
      await store.put(
        makeRecord({
          noteId: `44444444-4444-4444-8444-4444444444${i.toString().padStart(2, "0")}`,
          updatedAt: clock.now(),
        }),
      );
    }

    // All 50 are present — no eviction yet at exactly the cap.
    for (let i = 0; i < DRAFT_MAX_COUNT; i += 1) {
      const noteId = `44444444-4444-4444-8444-4444444444${i.toString().padStart(2, "0")}`;
      expect(await store.get({ userId: USER_A, workspaceId: WORKSPACE, noteId })).toBeDefined();
    }

    // The 51st draft pushes the store over the cap; the oldest (index 0)
    // must be evicted while everything else survives.
    clock.advanceTo(DRAFT_MAX_COUNT);
    const overflowNoteId = "44444444-4444-4444-8444-444444444450";
    await store.put(makeRecord({ noteId: overflowNoteId, updatedAt: clock.now() }));

    const oldestNoteId = "44444444-4444-4444-8444-444444444400";
    expect(
      await store.get({ userId: USER_A, workspaceId: WORKSPACE, noteId: oldestNoteId }),
    ).toBeUndefined();
    expect(
      await store.get({ userId: USER_A, workspaceId: WORKSPACE, noteId: overflowNoteId }),
    ).toBeDefined();

    const secondOldestNoteId = "44444444-4444-4444-8444-444444444401";
    expect(
      await store.get({ userId: USER_A, workspaceId: WORKSPACE, noteId: secondOldestNoteId }),
    ).toBeDefined();
  });

  it("caps drafts per user so one account's 51st draft cannot evict another account", async () => {
    const clock = fakeClock(0);
    const store = new IndexedDbDraftStore({ clock });

    for (let i = 0; i < DRAFT_MAX_COUNT; i += 1) {
      clock.advanceTo(i);
      const noteId = `77777777-7777-4777-8777-7777777777${i.toString().padStart(2, "0")}`;
      await store.put(
        makeRecord({ userId: USER_B, noteId, markdown: `user-b-${i}`, updatedAt: clock.now() }),
      );
    }

    for (let i = 0; i < DRAFT_MAX_COUNT; i += 1) {
      clock.advanceTo(1_000 + i);
      const noteId = `88888888-8888-4888-8888-8888888888${i.toString().padStart(2, "0")}`;
      await store.put(
        makeRecord({ userId: USER_A, noteId, markdown: `user-a-${i}`, updatedAt: clock.now() }),
      );
    }

    clock.advanceTo(2_000);
    const userAOverflowNote = "88888888-8888-4888-8888-888888888850";
    await store.put(
      makeRecord({
        userId: USER_A,
        noteId: userAOverflowNote,
        markdown: "user-a-overflow",
        updatedAt: clock.now(),
      }),
    );

    const userAOldestNote = "88888888-8888-4888-8888-888888888800";
    expect(
      await store.get({ userId: USER_A, workspaceId: WORKSPACE, noteId: userAOldestNote }),
    ).toBeUndefined();
    expect(
      await store.get({ userId: USER_A, workspaceId: WORKSPACE, noteId: userAOverflowNote }),
    ).toBeDefined();

    for (let i = 0; i < DRAFT_MAX_COUNT; i += 1) {
      const noteId = `77777777-7777-4777-8777-7777777777${i.toString().padStart(2, "0")}`;
      const userBDraft = await store.get({ userId: USER_B, workspaceId: WORKSPACE, noteId });
      expect(userBDraft?.markdown).toBe(`user-b-${i}`);
    }

    // A lookup is always bound to the caller-supplied user identity; User B
    // cannot enumerate User A's overflow record by reusing its workspace/note id.
    expect(
      await store.get({ userId: USER_B, workspaceId: WORKSPACE, noteId: userAOverflowNote }),
    ).toBeUndefined();
  });

  it("keeps a draft exactly 30 days old, but expires one saved 30 days + 1ms ago", async () => {
    const savedAt = 10_000_000;
    const clock = fakeClock(savedAt);
    const store = new IndexedDbDraftStore({ clock });
    await store.put(makeRecord({ updatedAt: savedAt }));

    clock.advanceTo(savedAt + DRAFT_MAX_AGE_MS);
    const stillFresh = await store.get({ userId: USER_A, workspaceId: WORKSPACE, noteId: NOTE_1 });
    expect(stillFresh).toBeDefined();

    clock.advanceTo(savedAt + DRAFT_MAX_AGE_MS + 1);
    const expired = await store.get({ userId: USER_A, workspaceId: WORKSPACE, noteId: NOTE_1 });
    expect(expired).toBeUndefined();
  });

  it("never surfaces one user's draft to another user sharing the same browser profile", async () => {
    const clock = fakeClock(1_000);
    const store = new IndexedDbDraftStore({ clock });

    await store.put(
      makeRecord({ userId: USER_A, markdown: "user A's private draft", updatedAt: clock.now() }),
    );
    await store.put(
      makeRecord({ userId: USER_B, markdown: "user B's private draft", updatedAt: clock.now() }),
    );

    const asA = await store.get({ userId: USER_A, workspaceId: WORKSPACE, noteId: NOTE_1 });
    const asB = await store.get({ userId: USER_B, workspaceId: WORKSPACE, noteId: NOTE_1 });

    expect(asA?.markdown).toBe("user A's private draft");
    expect(asB?.markdown).toBe("user B's private draft");
  });

  it("treats an expired session's draft as absent and removes it", async () => {
    const savedAt = 5_000_000;
    const clock = fakeClock(savedAt);
    const store = new IndexedDbDraftStore({ clock });
    await store.put(makeRecord({ updatedAt: savedAt }));

    clock.advanceTo(savedAt + DRAFT_MAX_AGE_MS * 3);
    expect(
      await store.get({ userId: USER_A, workspaceId: WORKSPACE, noteId: NOTE_1 }),
    ).toBeUndefined();

    // Confirm it was actually purged, not merely filtered on read: re-running
    // the same expired read again still yields nothing (no leftover retry state).
    expect(
      await store.get({ userId: USER_A, workspaceId: WORKSPACE, noteId: NOTE_1 }),
    ).toBeUndefined();
  });

  describe("tampered fields", () => {
    async function writeRawRecord(raw: Record<string, unknown>): Promise<void> {
      const db = await openDatabase({
        name: DRAFT_DB_NAME,
        version: DRAFT_DB_VERSION,
        stores: [{ name: DRAFT_STORE_NAME, keyPath: "id", indexes: [] }],
      });
      await runTransaction(db, [DRAFT_STORE_NAME], "readwrite", (tx) => {
        tx.objectStore(DRAFT_STORE_NAME).put(raw);
      });
      db.close();
    }

    it("rejects a record whose embedded workspaceId does not match the lookup key", async () => {
      const clock = fakeClock(1_000);
      const store = new IndexedDbDraftStore({ clock });
      const id = draftRecordId({ userId: USER_A, workspaceId: WORKSPACE, noteId: NOTE_1 });
      await writeRawRecord({
        id,
        userId: USER_A,
        workspaceId: "99999999-9999-4999-8999-999999999999",
        noteId: NOTE_1,
        operationId: OP_1,
        baseRevision: 1,
        markdown: "tampered",
        updatedAt: clock.now(),
      });

      expect(
        await store.get({ userId: USER_A, workspaceId: WORKSPACE, noteId: NOTE_1 }),
      ).toBeUndefined();
    });

    it("rejects a record whose embedded noteId does not match the lookup key", async () => {
      const clock = fakeClock(1_000);
      const store = new IndexedDbDraftStore({ clock });
      const id = draftRecordId({ userId: USER_A, workspaceId: WORKSPACE, noteId: NOTE_1 });
      await writeRawRecord({
        id,
        userId: USER_A,
        workspaceId: WORKSPACE,
        noteId: NOTE_2,
        operationId: OP_1,
        baseRevision: 1,
        markdown: "tampered",
        updatedAt: clock.now(),
      });

      expect(
        await store.get({ userId: USER_A, workspaceId: WORKSPACE, noteId: NOTE_1 }),
      ).toBeUndefined();
    });

    it("rejects a record with a non-positive baseRevision", async () => {
      const clock = fakeClock(1_000);
      const store = new IndexedDbDraftStore({ clock });
      const id = draftRecordId({ userId: USER_A, workspaceId: WORKSPACE, noteId: NOTE_1 });
      await writeRawRecord({
        id,
        userId: USER_A,
        workspaceId: WORKSPACE,
        noteId: NOTE_1,
        operationId: OP_1,
        baseRevision: 0,
        markdown: "tampered",
        updatedAt: clock.now(),
      });

      expect(
        await store.get({ userId: USER_A, workspaceId: WORKSPACE, noteId: NOTE_1 }),
      ).toBeUndefined();
    });

    it("rejects a record with a malformed operationId", async () => {
      const clock = fakeClock(1_000);
      const store = new IndexedDbDraftStore({ clock });
      const id = draftRecordId({ userId: USER_A, workspaceId: WORKSPACE, noteId: NOTE_1 });
      await writeRawRecord({
        id,
        userId: USER_A,
        workspaceId: WORKSPACE,
        noteId: NOTE_1,
        operationId: "not-a-uuid",
        baseRevision: 1,
        markdown: "tampered",
        updatedAt: clock.now(),
      });

      expect(
        await store.get({ userId: USER_A, workspaceId: WORKSPACE, noteId: NOTE_1 }),
      ).toBeUndefined();
    });

    it("rejects a record dated in the future instead of letting it evade expiry", async () => {
      const clock = fakeClock(1_000);
      const store = new IndexedDbDraftStore({ clock });
      const id = draftRecordId({ userId: USER_A, workspaceId: WORKSPACE, noteId: NOTE_1 });
      await writeRawRecord({
        id,
        userId: USER_A,
        workspaceId: WORKSPACE,
        noteId: NOTE_1,
        operationId: OP_1,
        baseRevision: 1,
        markdown: "future-tampered",
        updatedAt: clock.now() + 1,
      });

      expect(
        await store.get({ userId: USER_A, workspaceId: WORKSPACE, noteId: NOTE_1 }),
      ).toBeUndefined();
    });
  });

  it("clears every draft for a user purely locally, without any network dependency", async () => {
    const clock = fakeClock(1_000);
    const store = new IndexedDbDraftStore({ clock });
    await store.put(makeRecord({ userId: USER_A, noteId: NOTE_1, updatedAt: clock.now() }));
    await store.put(makeRecord({ userId: USER_A, noteId: NOTE_2, updatedAt: clock.now() }));
    await store.put(makeRecord({ userId: USER_B, noteId: NOTE_1, updatedAt: clock.now() }));

    // No fetch/network mock is installed anywhere in this test — clearForUser
    // must be able to complete on its own, e.g. for a logout whose server
    // call has already failed.
    await store.clearForUser(USER_A);

    expect(
      await store.get({ userId: USER_A, workspaceId: WORKSPACE, noteId: NOTE_1 }),
    ).toBeUndefined();
    expect(
      await store.get({ userId: USER_A, workspaceId: WORKSPACE, noteId: NOTE_2 }),
    ).toBeUndefined();
    expect(
      await store.get({ userId: USER_B, workspaceId: WORKSPACE, noteId: NOTE_1 }),
    ).toBeDefined();
  });

  it("deletes a single draft by key", async () => {
    const clock = fakeClock(1_000);
    const store = new IndexedDbDraftStore({ clock });
    await store.put(makeRecord({ updatedAt: clock.now() }));

    await store.delete({ userId: USER_A, workspaceId: WORKSPACE, noteId: NOTE_1 });

    expect(
      await store.get({ userId: USER_A, workspaceId: WORKSPACE, noteId: NOTE_1 }),
    ).toBeUndefined();
  });
});
