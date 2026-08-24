import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NoteConflictError, NoteOfflineError } from "../api/NoteClient.js";
import {
  BrowserSessionLifecycleCoordinator,
  SessionAuthorizationError,
} from "../coordination/SessionLifecycleCoordinator.js";
import { openEditorSession as openEditorSessionImpl } from "./EditorSession.js";
import type {
  DraftKey,
  DraftRecord,
  DraftStore,
  EditorSessionDeps,
  NoteLockLike,
  NoteRemote,
} from "./editor-session.types.js";
import type { EditorSessionLifecycle } from "../coordination/SessionLifecycleCoordinator.js";
import type { NoteScope, TabChannel, TabEnvelope } from "../coordination/TabChannel.js";
import type { EditorLifecycleAdapter } from "./EditorLifecycleController.js";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const WORKSPACE_ID = "33333333-3333-4333-8333-333333333333";
const NOTE_ID = "44444444-4444-4444-8444-444444444444";

function operationIdSequence(): () => string {
  let n = 0;
  return () => `00000000-0000-4000-8000-${(n += 1).toString().padStart(12, "0")}`;
}

/** In-memory DraftStore double — same contract as IndexedDbDraftStore, no IndexedDB involved. */
class FakeDraftStore implements DraftStore {
  private readonly records = new Map<string, DraftRecord>();
  getCalls = 0;
  clearCalls: string[] = [];

  private keyOf(key: DraftKey): string {
    return `${key.userId}::${key.workspaceId}::${key.noteId}`;
  }

  async put(record: DraftRecord): Promise<void> {
    this.records.set(this.keyOf(record), record);
  }

  async get(key: DraftKey): Promise<DraftRecord | undefined> {
    this.getCalls += 1;
    return this.records.get(this.keyOf(key));
  }

  async delete(key: DraftKey): Promise<void> {
    this.records.delete(this.keyOf(key));
  }

  async clearForUser(userId: string): Promise<void> {
    this.clearCalls.push(userId);
    for (const [k, record] of this.records) {
      if (record.userId === userId) this.records.delete(k);
    }
  }

  has(key: DraftKey): boolean {
    return this.records.has(this.keyOf(key));
  }

  peek(key: DraftKey): DraftRecord | undefined {
    return this.records.get(this.keyOf(key));
  }
}

/** A NoteLockLike double whose acquire()/requestTakeover() outcomes are set up per test. */
class FakeNoteLock implements NoteLockLike {
  readonly scope: NoteScope = {
    userId: USER_ID,
    workspaceId: WORKSPACE_ID,
    noteId: NOTE_ID,
  };
  private owned = false;
  private readonly listeners = new Set<(owned: boolean) => void>();
  releaseCalls = 0;
  acquireCalls = 0;

  constructor(
    private readonly acquireResult: boolean,
    private readonly takeoverResult: boolean = true,
  ) {}

  async acquire(): Promise<boolean> {
    this.acquireCalls += 1;
    this.owned = this.acquireResult;
    if (this.owned) this.notify(true);
    return this.acquireResult;
  }

  isOwner(): boolean {
    return this.owned;
  }

  release(): void {
    const wasOwned = this.owned;
    this.owned = false;
    this.releaseCalls += 1;
    if (wasOwned) this.notify(false);
  }

  async requestTakeover(): Promise<boolean> {
    if (this.takeoverResult) this.owned = true;
    if (this.takeoverResult) this.notify(true);
    return this.takeoverResult;
  }

  subscribeOwnership(listener: (owned: boolean) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  loseOwnership(): void {
    if (!this.owned) return;
    this.owned = false;
    this.notify(false);
  }

  private notify(owned: boolean): void {
    for (const listener of this.listeners) listener(owned);
  }
}

class FakeSessionLifecycle implements EditorSessionLifecycle {
  private lockAndClear: (() => Promise<void>) | undefined;

  async authorizeEditor(): Promise<void> {}

  registerEditor(_scope: NoteScope, lockAndClear: () => Promise<void>): () => void {
    this.lockAndClear = lockAndClear;
    return () => {
      this.lockAndClear = undefined;
    };
  }

  async endSession(): Promise<void> {
    await this.lockAndClear?.();
  }
}

class FakeEditorLifecycleAdapter implements EditorLifecycleAdapter {
  private readonly online = new Set<() => void>();
  private readonly blur = new Set<() => void>();
  private readonly navigation = new Set<() => void>();

  onOnline(listener: () => void): () => void {
    this.online.add(listener);
    return () => this.online.delete(listener);
  }

  onBlur(listener: () => void): () => void {
    this.blur.add(listener);
    return () => this.blur.delete(listener);
  }

  onNavigation(listener: () => void): () => void {
    this.navigation.add(listener);
    return () => this.navigation.delete(listener);
  }

  emitOnline(): void {
    for (const listener of this.online) listener();
  }

  emitBlur(): void {
    for (const listener of this.blur) listener();
  }

  emitNavigation(): void {
    for (const listener of this.navigation) listener();
  }
}

class NoopTabChannel implements TabChannel {
  readonly tabId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

  constructor(readonly scope: NoteScope) {}

  postOwnerQuery(): void {}
  postLockAcquired(): void {}
  postTakeoverRequest(): void {}
  postLockReleased(): void {}
  postLogout(): void {}
  subscribe(_listener: (envelope: TabEnvelope) => void): () => void {
    return () => undefined;
  }
  close(): void {}
}

/** A controllable NoteRemote double, mirroring AutosaveController.test.ts's deferredSaveFn shape. */
function deferredNoteRemote() {
  const calls: {
    noteId: string;
    operationId: string;
    baseRevision: number;
    contentMarkdown: string;
  }[] = [];
  const pending: {
    input: { operationId: string; baseRevision: number; contentMarkdown: string };
    resolve: (v: {
      revision: number;
      contentMarkdown: string;
      id?: string;
      workspaceId?: string;
    }) => void;
    reject: (e: unknown) => void;
  }[] = [];
  const remote: NoteRemote = {
    save: (noteId, input) =>
      new Promise((resolve, reject) => {
        calls.push({ noteId, ...input });
        pending.push({ input, resolve, reject });
      }) as ReturnType<NoteRemote["save"]>,
  };
  return {
    remote,
    calls,
    resolveNext(
      revision: number,
      overrides: { contentMarkdown?: string; id?: string; workspaceId?: string } = {},
    ): void {
      const next = pending.shift();
      if (!next) throw new Error("No pending save to resolve");
      next.resolve({
        id: overrides.id ?? NOTE_ID,
        workspaceId: overrides.workspaceId ?? WORKSPACE_ID,
        title: "t",
        revision,
        visibility: "private" as const,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        deletedAt: null,
        contentMarkdown: overrides.contentMarkdown ?? next.input.contentMarkdown,
        schemaVersion: 1,
      });
    },
    rejectNext(error: unknown): void {
      const next = pending.shift();
      if (!next) throw new Error("No pending save to reject");
      next.reject(error);
    },
  };
}

const baseKey: DraftKey = { userId: USER_ID, workspaceId: WORKSPACE_ID, noteId: NOTE_ID };

function authorizedLifecycle(): FakeSessionLifecycle {
  return new FakeSessionLifecycle();
}

function openEditorSession(
  deps: Omit<EditorSessionDeps, "sessionLifecycle"> & {
    sessionLifecycle?: EditorSessionLifecycle;
  },
) {
  return openEditorSessionImpl({
    ...deps,
    sessionLifecycle: deps.sessionLifecycle ?? authorizedLifecycle(),
  });
}

describe("EditorSession", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("moves clean -> dirty -> saving -> saved and persists/clears the local draft in step", async () => {
    const remote = deferredNoteRemote();
    const draftStore = new FakeDraftStore();
    const session = await openEditorSession({
      userId: USER_ID,
      workspaceId: WORKSPACE_ID,
      noteId: NOTE_ID,
      initialRevision: 1,
      initialMarkdown: "",
      noteClient: remote.remote,
      draftStore,
      noteLock: new FakeNoteLock(true),
      generateOperationId: operationIdSequence(),
    });
    const statuses: string[] = [];
    session.subscribe((state) => statuses.push(state.autosave.status));

    expect(session.snapshot().autosave.status).toBe("clean");
    expect(session.snapshot().isReadOnly).toBe(false);
    expect(session.snapshot()).toMatchObject({
      markdown: "",
      baseRevision: 1,
      dirty: false,
      saveStatus: "clean",
      conflict: null,
      readOnly: false,
      mode: "source",
    });

    session.edit("# hello");
    expect(session.snapshot().autosave.status).toBe("dirty");
    expect(session.snapshot()).toMatchObject({
      markdown: "# hello",
      baseRevision: 1,
      dirty: true,
      saveStatus: "dirty",
    });
    await vi.waitFor(() => expect(draftStore.has(baseKey)).toBe(true));

    await vi.advanceTimersByTimeAsync(1500);
    expect(session.snapshot().autosave.status).toBe("saving");

    remote.resolveNext(2);
    await vi.waitFor(() => expect(session.snapshot().autosave.status).toBe("saved"));
    expect(session.snapshot().autosave.revision).toBe(2);
    expect(session.snapshot()).toMatchObject({
      markdown: "# hello",
      baseRevision: 2,
      dirty: false,
      saveStatus: "saved",
    });
    expect(draftStore.has(baseKey)).toBe(false); // acknowledged content is no longer a "recoverable" draft

    expect(statuses).toEqual(["dirty", "saving", "saved"]);
  });

  it("debounces edits for exactly 1.5 seconds", async () => {
    const remote = deferredNoteRemote();
    const session = await openEditorSession({
      userId: USER_ID,
      workspaceId: WORKSPACE_ID,
      noteId: NOTE_ID,
      initialRevision: 1,
      initialMarkdown: "",
      noteClient: remote.remote,
      draftStore: new FakeDraftStore(),
      noteLock: new FakeNoteLock(true),
      generateOperationId: operationIdSequence(),
    });

    session.edit("# hello");
    await vi.advanceTimersByTimeAsync(1499);
    expect(session.snapshot().autosave.status).toBe("dirty");

    await vi.advanceTimersByTimeAsync(1);
    expect(session.snapshot().autosave.status).toBe("saving");
  });

  it("saveNow is an immediate trigger that bypasses the debounce window", async () => {
    const remote = deferredNoteRemote();
    const session = await openEditorSession({
      userId: USER_ID,
      workspaceId: WORKSPACE_ID,
      noteId: NOTE_ID,
      initialRevision: 1,
      initialMarkdown: "",
      noteClient: remote.remote,
      draftStore: new FakeDraftStore(),
      noteLock: new FakeNoteLock(true),
      generateOperationId: operationIdSequence(),
    });

    session.edit("# hello");
    await session.saveNow();
    expect(session.snapshot().autosave.status).toBe("saving");
    expect(remote.calls).toHaveLength(1);
  });

  it("keeps exactly one save in flight and folds a mid-flight edit into one automatic follow-up", async () => {
    const remote = deferredNoteRemote();
    const session = await openEditorSession({
      userId: USER_ID,
      workspaceId: WORKSPACE_ID,
      noteId: NOTE_ID,
      initialRevision: 1,
      initialMarkdown: "",
      noteClient: remote.remote,
      draftStore: new FakeDraftStore(),
      noteLock: new FakeNoteLock(true),
      generateOperationId: operationIdSequence(),
    });

    session.edit("v1");
    await session.saveNow();
    session.edit("v2");
    expect(remote.calls).toHaveLength(1);

    remote.resolveNext(2);
    await vi.waitFor(() => expect(remote.calls).toHaveLength(2));
    expect(remote.calls[1]?.contentMarkdown).toBe("v2");
    expect(remote.calls[1]?.baseRevision).toBe(2);
  });

  it("reuses the same operation id across automatic retries after an offline failure", async () => {
    const remote = deferredNoteRemote();
    const session = await openEditorSession({
      userId: USER_ID,
      workspaceId: WORKSPACE_ID,
      noteId: NOTE_ID,
      initialRevision: 1,
      initialMarkdown: "",
      noteClient: remote.remote,
      draftStore: new FakeDraftStore(),
      noteLock: new FakeNoteLock(true),
      generateOperationId: operationIdSequence(),
      retryBaseMs: 1000,
    });

    session.edit("# hello");
    await session.saveNow();
    remote.rejectNext(new NoteOfflineError());
    await vi.waitFor(() => expect(session.snapshot().autosave.status).toBe("offline"));

    await vi.advanceTimersByTimeAsync(1000);
    await vi.waitFor(() => expect(remote.calls).toHaveLength(2));
    expect(remote.calls[0]?.operationId).toBe(remote.calls[1]?.operationId);
  });

  it("keeps the original edit time across save attempts so retries cannot defeat draft expiry", async () => {
    const remote = deferredNoteRemote();
    const draftStore = new FakeDraftStore();
    let now = 1_000;
    const session = await openEditorSession({
      userId: USER_ID,
      workspaceId: WORKSPACE_ID,
      noteId: NOTE_ID,
      initialRevision: 1,
      initialMarkdown: "",
      noteClient: remote.remote,
      draftStore,
      noteLock: new FakeNoteLock(true),
      generateOperationId: operationIdSequence(),
      clock: {
        now: () => now,
        setTimeout: (handler, ms) => setTimeout(handler, ms) as unknown as number,
        clearTimeout: (id) => clearTimeout(id),
      },
    });

    session.edit("long-lived offline draft");
    await vi.waitFor(() => expect(draftStore.peek(baseKey)?.updatedAt).toBe(1_000));

    now = 9_000;
    await session.saveNow();
    await vi.waitFor(() => expect(session.snapshot().saveStatus).toBe("saving"));
    await vi.waitFor(() => expect(draftStore.peek(baseKey)?.updatedAt).toBe(1_000));

    remote.rejectNext(new NoteOfflineError());
    await vi.waitFor(() => expect(session.snapshot().saveStatus).toBe("offline"));
    expect(draftStore.peek(baseKey)?.updatedAt).toBe(1_000);
  });

  it("moves to conflict on a 409 and surfaces the server's state without retrying", async () => {
    const remote = deferredNoteRemote();
    const session = await openEditorSession({
      userId: USER_ID,
      workspaceId: WORKSPACE_ID,
      noteId: NOTE_ID,
      initialRevision: 1,
      initialMarkdown: "",
      noteClient: remote.remote,
      draftStore: new FakeDraftStore(),
      noteLock: new FakeNoteLock(true),
      generateOperationId: operationIdSequence(),
      retryBaseMs: 100,
    });

    session.edit("# mine");
    await session.saveNow();
    remote.rejectNext(
      new NoteConflictError({
        code: "REVISION_CONFLICT",
        noteId: NOTE_ID,
        serverRevision: 9,
        serverMarkdown: "# theirs",
        serverUpdatedAt: "2026-01-01T00:00:00.000Z",
        lastEditedBy: null,
        requestId: "req-1",
      }),
    );

    await vi.waitFor(() => expect(session.snapshot().autosave.status).toBe("conflict"));
    expect(session.snapshot().autosave.conflict?.serverRevision).toBe(9);

    await vi.advanceTimersByTimeAsync(30_000);
    expect(remote.calls).toHaveLength(1); // never auto-retried
  });

  it("opens read-only when another tab already holds the note's write lock", async () => {
    const remote = deferredNoteRemote();
    const session = await openEditorSession({
      userId: USER_ID,
      workspaceId: WORKSPACE_ID,
      noteId: NOTE_ID,
      initialRevision: 1,
      initialMarkdown: "",
      noteClient: remote.remote,
      draftStore: new FakeDraftStore(),
      noteLock: new FakeNoteLock(false),
      generateOperationId: operationIdSequence(),
    });

    expect(session.snapshot().isReadOnly).toBe(true);

    session.edit("should be ignored");
    expect(session.snapshot().autosave.status).toBe("clean");
    expect(remote.calls).toHaveLength(0);

    await session.saveNow();
    expect(remote.calls).toHaveLength(0);
  });

  it("becomes writable after an explicit takeover", async () => {
    const remote = deferredNoteRemote();
    const lock = new FakeNoteLock(false, true);
    const session = await openEditorSession({
      userId: USER_ID,
      workspaceId: WORKSPACE_ID,
      noteId: NOTE_ID,
      initialRevision: 1,
      initialMarkdown: "",
      noteClient: remote.remote,
      draftStore: new FakeDraftStore(),
      noteLock: lock,
      generateOperationId: operationIdSequence(),
    });
    expect(session.snapshot().isReadOnly).toBe(true);

    const won = await session.requestTakeover();

    expect(won).toBe(true);
    expect(session.snapshot().isReadOnly).toBe(false);

    session.edit("now I can write");
    expect(session.snapshot().autosave.status).toBe("dirty");
  });

  it("recovers a matching local draft on open and sends it under its original operation id", async () => {
    const remote = deferredNoteRemote();
    const draftStore = new FakeDraftStore();
    await draftStore.put({
      ...baseKey,
      operationId: "77777777-7777-4777-8777-777777777777",
      baseRevision: 5,
      markdown: "unsent from last time",
      updatedAt: 1000,
    });

    const session = await openEditorSession({
      userId: USER_ID,
      workspaceId: WORKSPACE_ID,
      noteId: NOTE_ID,
      initialRevision: 5,
      initialMarkdown: "unsent from last time",
      noteClient: remote.remote,
      draftStore,
      noteLock: new FakeNoteLock(true),
      generateOperationId: operationIdSequence(),
    });

    expect(session.snapshot().autosave.status).toBe("saving");
    expect(remote.calls).toEqual([
      {
        noteId: NOTE_ID,
        operationId: "77777777-7777-4777-8777-777777777777",
        baseRevision: 5,
        contentMarkdown: "unsent from last time",
      },
    ]);
  });

  it("does not send recovered content if lifecycle registration rejects a completed account transition", async () => {
    const remote = deferredNoteRemote();
    const draftStore = new FakeDraftStore();
    const lock = new FakeNoteLock(true);
    await draftStore.put({
      ...baseKey,
      operationId: "77777777-7777-4777-8777-777777777777",
      baseRevision: 5,
      markdown: "prior account draft",
      updatedAt: 1000,
    });
    const transitionedLifecycle: EditorSessionLifecycle = {
      async authorizeEditor() {},
      registerEditor() {
        throw new SessionAuthorizationError();
      },
    };

    await expect(
      openEditorSession({
        userId: USER_ID,
        workspaceId: WORKSPACE_ID,
        noteId: NOTE_ID,
        initialRevision: 5,
        initialMarkdown: "server markdown",
        noteClient: remote.remote,
        draftStore,
        noteLock: lock,
        sessionLifecycle: transitionedLifecycle,
        generateOperationId: operationIdSequence(),
      }),
    ).rejects.toBeInstanceOf(SessionAuthorizationError);

    expect(remote.calls).toHaveLength(0);
    expect(lock.releaseCalls).toBe(1);
  });

  it("recovers a durable conflict without silently resubmitting the local side", async () => {
    const remote = deferredNoteRemote();
    const draftStore = new FakeDraftStore();
    const conflict = {
      code: "REVISION_CONFLICT" as const,
      noteId: NOTE_ID,
      serverRevision: 9,
      serverMarkdown: "# server side",
      serverUpdatedAt: "2026-01-01T00:00:00.000Z",
      lastEditedBy: { displayName: "Ada" },
      requestId: "req-recovered-conflict",
    };
    await draftStore.put({
      ...baseKey,
      operationId: "88888888-8888-4888-8888-888888888888",
      baseRevision: conflict.serverRevision,
      markdown: "# local side",
      updatedAt: 1000,
      conflict,
    });

    const session = await openEditorSession({
      userId: USER_ID,
      workspaceId: WORKSPACE_ID,
      noteId: NOTE_ID,
      initialRevision: conflict.serverRevision,
      initialMarkdown: conflict.serverMarkdown,
      noteClient: remote.remote,
      draftStore,
      noteLock: new FakeNoteLock(true),
      generateOperationId: operationIdSequence(),
    });

    expect(session.snapshot()).toMatchObject({
      markdown: "# local side",
      baseRevision: conflict.serverRevision,
      dirty: true,
      saveStatus: "conflict",
      conflict,
    });
    expect(remote.calls).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(remote.calls).toHaveLength(0);
  });

  it("ignores a recovered draft whose base revision no longer matches the server", async () => {
    const remote = deferredNoteRemote();
    const draftStore = new FakeDraftStore();
    await draftStore.put({
      ...baseKey,
      operationId: "88888888-8888-4888-8888-888888888888",
      baseRevision: 2,
      markdown: "stale draft",
      updatedAt: 1000,
    });

    const session = await openEditorSession({
      userId: USER_ID,
      workspaceId: WORKSPACE_ID,
      noteId: NOTE_ID,
      initialRevision: 5, // server has moved on
      initialMarkdown: "current server content",
      noteClient: remote.remote,
      draftStore,
      noteLock: new FakeNoteLock(true),
      generateOperationId: operationIdSequence(),
    });

    expect(session.snapshot().autosave.status).toBe("clean");
    expect(remote.calls).toHaveLength(0);
  });

  it("never recovers a draft into a read-only session (another tab already owns the note)", async () => {
    const remote = deferredNoteRemote();
    const draftStore = new FakeDraftStore();
    await draftStore.put({
      ...baseKey,
      operationId: "77777777-7777-4777-8777-777777777777",
      baseRevision: 1,
      markdown: "unsent",
      updatedAt: 1000,
    });

    const session = await openEditorSession({
      userId: USER_ID,
      workspaceId: WORKSPACE_ID,
      noteId: NOTE_ID,
      initialRevision: 1,
      initialMarkdown: "",
      noteClient: remote.remote,
      draftStore,
      noteLock: new FakeNoteLock(false),
      generateOperationId: operationIdSequence(),
    });

    expect(session.snapshot().isReadOnly).toBe(true);
    expect(session.snapshot().autosave.status).toBe("clean");
    expect(remote.calls).toHaveLength(0);
  });

  it("releases the write lock and flushes the final draft on dispose", async () => {
    const remote = deferredNoteRemote();
    const draftStore = new FakeDraftStore();
    const lock = new FakeNoteLock(true);
    const session = await openEditorSession({
      userId: USER_ID,
      workspaceId: WORKSPACE_ID,
      noteId: NOTE_ID,
      initialRevision: 1,
      initialMarkdown: "",
      noteClient: remote.remote,
      draftStore,
      noteLock: lock,
      generateOperationId: operationIdSequence(),
    });

    session.edit("never got to send this");
    await session.dispose();

    expect(lock.releaseCalls).toBe(1);
    expect(draftStore.has(baseKey)).toBe(true); // the unsent edit survives the tab closing
  });

  it("switchMode flushes pending edits immediately before switching", async () => {
    const remote = deferredNoteRemote();
    const session = await openEditorSession({
      userId: USER_ID,
      workspaceId: WORKSPACE_ID,
      noteId: NOTE_ID,
      initialRevision: 1,
      initialMarkdown: "",
      noteClient: remote.remote,
      draftStore: new FakeDraftStore(),
      noteLock: new FakeNoteLock(true),
      generateOperationId: operationIdSequence(),
    });

    session.edit("# hello");
    const result = await session.switchMode("source");

    expect(result).toEqual({ success: true, mode: "source" });
    expect(remote.calls).toHaveLength(1); // flushed immediately, not after a 1.5s debounce
  });

  it.each(["visual", "split"] as const)(
    "reports %s mode as unsupported until a later task injects its adapters",
    async (unsupportedMode) => {
      const remote = deferredNoteRemote();
      const session = await openEditorSession({
        userId: USER_ID,
        workspaceId: WORKSPACE_ID,
        noteId: NOTE_ID,
        initialRevision: 1,
        initialMarkdown: "",
        noteClient: remote.remote,
        draftStore: new FakeDraftStore(),
        noteLock: new FakeNoteLock(true),
        generateOperationId: operationIdSequence(),
      });

      const result = await session.switchMode(unsupportedMode);

      expect(result).toEqual({ success: false, mode: "source", reason: "unsupported" });
      expect(session.snapshot().mode).toBe("source");
    },
  );

  it.each([
    {
      name: "expired",
      session: {
        userId: USER_ID,
        expiresAt: 1_000,
        workspaceIds: [WORKSPACE_ID],
      },
    },
    {
      name: "mismatched user",
      session: {
        userId: "22222222-2222-4222-8222-222222222222",
        expiresAt: 10_000,
        workspaceIds: [WORKSPACE_ID],
      },
    },
    {
      name: "unauthorized workspace",
      session: {
        userId: USER_ID,
        expiresAt: 10_000,
        workspaceIds: ["99999999-9999-4999-8999-999999999999"],
      },
    },
  ])("does not enumerate drafts for a $name session", async ({ session: rawSession }) => {
    const draftStore = new FakeDraftStore();
    const lock = new FakeNoteLock(true);
    const lifecycle = new BrowserSessionLifecycleCoordinator({
      initialSession: rawSession,
      draftStore,
      clock: { now: () => 1_000 },
      channelFactory: (channelScope) => new NoopTabChannel(channelScope),
    });

    await expect(
      openEditorSession({
        userId: USER_ID,
        workspaceId: WORKSPACE_ID,
        noteId: NOTE_ID,
        initialRevision: 1,
        initialMarkdown: "",
        noteClient: deferredNoteRemote().remote,
        draftStore,
        noteLock: lock,
        sessionLifecycle: lifecycle,
        generateOperationId: operationIdSequence(),
      }),
    ).rejects.toBeInstanceOf(SessionAuthorizationError);

    expect(draftStore.getCalls).toBe(0);
    expect(lock.acquireCalls).toBe(0);
    lifecycle.dispose();
  });

  it("scrubs and locks the in-memory editor when the matching browser session ends", async () => {
    const remote = deferredNoteRemote();
    const lifecycle = authorizedLifecycle();
    const lock = new FakeNoteLock(true);
    const session = await openEditorSession({
      userId: USER_ID,
      workspaceId: WORKSPACE_ID,
      noteId: NOTE_ID,
      initialRevision: 1,
      initialMarkdown: "server markdown",
      noteClient: remote.remote,
      draftStore: new FakeDraftStore(),
      noteLock: lock,
      sessionLifecycle: lifecycle,
      generateOperationId: operationIdSequence(),
    });

    session.edit("private unsaved markdown");
    await lifecycle.endSession();

    expect(session.snapshot()).toMatchObject({
      markdown: "",
      dirty: false,
      conflict: null,
      readOnly: true,
      isReadOnly: true,
      saveStatus: "clean",
    });
    expect(session.snapshot().autosave.pending).toBeNull();
    expect(lock.releaseCalls).toBe(1);
  });

  it("becomes read-only and stops writes when a targeted takeover releases its lock", async () => {
    const remote = deferredNoteRemote();
    const lock = new FakeNoteLock(true);
    const session = await openEditorSession({
      userId: USER_ID,
      workspaceId: WORKSPACE_ID,
      noteId: NOTE_ID,
      initialRevision: 1,
      initialMarkdown: "",
      noteClient: remote.remote,
      draftStore: new FakeDraftStore(),
      noteLock: lock,
      generateOperationId: operationIdSequence(),
    });

    lock.loseOwnership();
    expect(session.snapshot().readOnly).toBe(true);

    session.edit("forged former-writer edit");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(remote.calls).toHaveLength(0);
    expect(session.snapshot().markdown).toBe("");
  });

  it("routes blur/navigation/online hooks through the same single-flight save state machine", async () => {
    const remote = deferredNoteRemote();
    const lifecycleAdapter = new FakeEditorLifecycleAdapter();
    const session = await openEditorSession({
      userId: USER_ID,
      workspaceId: WORKSPACE_ID,
      noteId: NOTE_ID,
      initialRevision: 1,
      initialMarkdown: "",
      noteClient: remote.remote,
      draftStore: new FakeDraftStore(),
      noteLock: new FakeNoteLock(true),
      lifecycleAdapter,
      generateOperationId: operationIdSequence(),
    });

    session.edit("v1");
    lifecycleAdapter.emitBlur();
    lifecycleAdapter.emitNavigation();
    lifecycleAdapter.emitOnline();
    expect(remote.calls).toHaveLength(1);

    session.edit("v2");
    lifecycleAdapter.emitBlur();
    expect(remote.calls).toHaveLength(1);

    remote.resolveNext(2);
    await vi.waitFor(() => expect(remote.calls).toHaveLength(2));
    expect(remote.calls[1]?.contentMarkdown).toBe("v2");

    await session.dispose();
    lifecycleAdapter.emitBlur();
    lifecycleAdapter.emitNavigation();
    lifecycleAdapter.emitOnline();
    expect(remote.calls).toHaveLength(2);
  });

  it("retries an offline operation immediately on the online hook with the same UUID", async () => {
    const remote = deferredNoteRemote();
    const lifecycleAdapter = new FakeEditorLifecycleAdapter();
    const session = await openEditorSession({
      userId: USER_ID,
      workspaceId: WORKSPACE_ID,
      noteId: NOTE_ID,
      initialRevision: 1,
      initialMarkdown: "",
      noteClient: remote.remote,
      draftStore: new FakeDraftStore(),
      noteLock: new FakeNoteLock(true),
      lifecycleAdapter,
      generateOperationId: operationIdSequence(),
      retryBaseMs: 10_000,
    });

    session.edit("offline draft");
    lifecycleAdapter.emitBlur();
    remote.rejectNext(new NoteOfflineError());
    await vi.waitFor(() => expect(session.snapshot().saveStatus).toBe("offline"));

    lifecycleAdapter.emitOnline();
    await vi.waitFor(() => expect(remote.calls).toHaveLength(2));
    expect(remote.calls[1]?.operationId).toBe(remote.calls[0]?.operationId);
  });

  it("keeps authoritative markdown and revision when a stale response arrives", async () => {
    const remote = deferredNoteRemote();
    const session = await openEditorSession({
      userId: USER_ID,
      workspaceId: WORKSPACE_ID,
      noteId: NOTE_ID,
      initialRevision: 5,
      initialMarkdown: "server-v5",
      noteClient: remote.remote,
      draftStore: new FakeDraftStore(),
      noteLock: new FakeNoteLock(true),
      generateOperationId: operationIdSequence(),
    });

    session.edit("local-v6");
    await session.saveNow();
    remote.resolveNext(4);
    await vi.waitFor(() => expect(session.snapshot().saveStatus).toBe("error"));

    expect(session.snapshot()).toMatchObject({
      markdown: "local-v6",
      baseRevision: 5,
      dirty: true,
      saveStatus: "error",
    });
  });
});
