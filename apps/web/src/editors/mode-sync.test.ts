import { createDocumentEngine } from "@glyphquire/document-engine";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openEditorSession } from "./EditorSession.js";
import type {
  DocumentAnalysisPort,
  DraftKey,
  DraftRecord,
  DraftStore,
  EditorModeAdapter,
  EditorPane,
  NoteLockLike,
} from "./editor-session.types.js";
import type { EditorSessionLifecycle } from "../coordination/SessionLifecycleCoordinator.js";
import type { NoteScope } from "../coordination/TabChannel.js";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const WORKSPACE_ID = "33333333-3333-4333-8333-333333333333";
const NOTE_ID = "44444444-4444-4444-8444-444444444444";
const VALID_SOURCE = "---\nglyphquire-spec: 1\n---\n\n# Hello";
const SECOND_SOURCE = "---\nglyphquire-spec: 1\n---\n\n# Changed\n\nBody";
const FATAL_SOURCE = "# exact invalid source\n\n:::callout{";
const engine = createDocumentEngine();

function analysis(markdown: string) {
  const result = engine.parse(markdown);
  return {
    result,
    canonicalMarkdown: result.ok ? engine.serialize(result.document) : null,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((settle, fail) => {
    resolve = settle;
    reject = fail;
  });
  return { promise, resolve, reject };
}

class MemoryDraftStore implements DraftStore {
  private readonly records = new Map<string, DraftRecord>();

  async put(record: DraftRecord): Promise<void> {
    this.records.set(this.key(record), record);
  }

  async get(key: DraftKey): Promise<DraftRecord | undefined> {
    return this.records.get(this.key(key));
  }

  async delete(key: DraftKey): Promise<void> {
    this.records.delete(this.key(key));
  }

  async clearForUser(userId: string): Promise<void> {
    for (const [key, value] of this.records) {
      if (value.userId === userId) this.records.delete(key);
    }
  }

  private key(key: DraftKey): string {
    return `${key.userId}:${key.workspaceId}:${key.noteId}`;
  }
}

class ModeLock implements NoteLockLike {
  readonly scope: NoteScope = {
    userId: USER_ID,
    workspaceId: WORKSPACE_ID,
    noteId: NOTE_ID,
  };
  private owned = true;
  private readonly listeners = new Set<(owned: boolean) => void>();

  async acquire(): Promise<boolean> {
    return this.owned;
  }

  isOwner(): boolean {
    return this.owned;
  }

  release(): void {
    if (!this.owned) return;
    this.owned = false;
    this.emit(false);
  }

  async requestTakeover(): Promise<boolean> {
    this.owned = true;
    this.emit(true);
    return true;
  }

  subscribeOwnership(listener: (owned: boolean) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  revoke(): void {
    this.owned = false;
    this.emit(false);
  }

  private emit(owned: boolean): void {
    for (const listener of this.listeners) listener(owned);
  }
}

class LiveLifecycle implements EditorSessionLifecycle {
  private end: (() => Promise<void>) | undefined;

  async authorizeEditor(): Promise<void> {}

  assertEditorAuthorized(): void {}

  registerEditor(_scope: NoteScope, end: () => Promise<void>): () => void {
    this.end = end;
    return () => {
      this.end = undefined;
    };
  }

  async revoke(): Promise<void> {
    await this.end?.();
  }
}

class ImmediateDocuments implements DocumentAnalysisPort {
  readonly markdown: string[] = [];
  cancelCalls = 0;
  disposeCalls = 0;

  async parseAndValidate(markdown: string) {
    this.markdown.push(markdown);
    return analysis(markdown);
  }

  cancel(): void {
    this.cancelCalls += 1;
  }

  dispose(): void {
    this.disposeCalls += 1;
  }
}

class ControlledDocuments implements DocumentAnalysisPort {
  readonly requests: Array<{
    markdown: string;
    pending: ReturnType<typeof deferred<ReturnType<typeof analysis>>>;
  }> = [];
  cancelCalls = 0;
  disposeCalls = 0;

  parseAndValidate(markdown: string): Promise<ReturnType<typeof analysis>> {
    const pending = deferred<ReturnType<typeof analysis>>();
    this.requests.push({ markdown, pending });
    return pending.promise;
  }

  resolve(index: number): void {
    const request = this.requests[index];
    if (!request) throw new Error(`Missing analysis ${index}`);
    request.pending.resolve(analysis(request.markdown));
  }

  reject(index: number): void {
    const request = this.requests[index];
    if (!request) throw new Error(`Missing analysis ${index}`);
    request.pending.reject(new Error("raw worker failure must not surface"));
  }

  cancel(): void {
    this.cancelCalls += 1;
  }

  dispose(): void {
    this.disposeCalls += 1;
  }
}

class FakeModeAdapter implements EditorModeAdapter {
  markdown = "";
  readOnly = true;
  readonly projections: string[] = [];
  readonly readOnlyTransitions: boolean[] = [];
  readonly restoredSelections: Array<{ anchor: number; head: number }> = [];
  failProjection = false;
  failSelectionRestore = false;
  projectionGate: ReturnType<typeof deferred<void>> | undefined;
  selection: { anchor: number; head: number } | null = null;
  private readonly listeners = new Set<(markdown: string) => void>();

  constructor(
    readonly pane: EditorPane,
    initialMarkdown = "",
  ) {
    this.markdown = initialMarkdown;
  }

  async setMarkdown(markdown: string): Promise<void> {
    this.projections.push(markdown);
    if (this.failProjection) throw new Error("adapter rejected projection");
    await this.projectionGate?.promise;
    if (this.pane === "visual") {
      const parsed = engine.parse(markdown);
      if (!parsed.ok) throw new Error("visual adapter rejected fatal source");
      this.markdown = engine.serialize(parsed.document);
    } else {
      this.markdown = markdown;
    }
  }

  getMarkdown(): string {
    return this.markdown;
  }

  setReadOnly(readOnly: boolean): void {
    this.readOnly = readOnly;
    this.readOnlyTransitions.push(readOnly);
  }

  onChange(listener: (markdown: string) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getSelection(): { anchor: number; head: number } | null {
    return this.selection;
  }

  setSelection(selection: { anchor: number; head: number }): void {
    if (this.failSelectionRestore) throw new Error("selection mapping is best effort");
    this.restoredSelections.push(selection);
  }

  emit(markdown: string): void {
    this.markdown = markdown;
    for (const listener of this.listeners) listener(markdown);
  }
}

async function createSession(
  options: {
    markdown?: string;
    documents?: DocumentAnalysisPort;
    lock?: ModeLock;
    lifecycle?: LiveLifecycle;
  } = {},
) {
  const documents = options.documents ?? new ImmediateDocuments();
  const lock = options.lock ?? new ModeLock();
  const lifecycle = options.lifecycle ?? new LiveLifecycle();
  const session = await openEditorSession({
    userId: USER_ID,
    workspaceId: WORKSPACE_ID,
    noteId: NOTE_ID,
    initialRevision: 1,
    initialMarkdown: options.markdown ?? VALID_SOURCE,
    noteClient: {
      async save(noteId, input) {
        return {
          id: noteId,
          workspaceId: WORKSPACE_ID,
          title: "Mode test",
          contentMarkdown: input.contentMarkdown,
          revision: input.baseRevision + 1,
          schemaVersion: 1,
          visibility: "private" as const,
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
          deletedAt: null,
        };
      },
    },
    draftStore: new MemoryDraftStore(),
    noteLock: lock,
    sessionLifecycle: lifecycle,
    documentAnalysis: documents,
    generateOperationId: () => "00000000-0000-4000-8000-000000000001",
  });
  const source = new FakeModeAdapter("source", "UNTRUSTED-SOURCE");
  const visual = new FakeModeAdapter("visual", `${VALID_SOURCE}\n\nSTALE VISUAL`);
  const detach = await session.attachModeAdapters({ source, visual });
  return { session, source, visual, documents, lock, lifecycle, detach };
}

function writablePanes(source: FakeModeAdapter, visual: FakeModeAdapter): EditorPane[] {
  return [source, visual].filter((adapter) => !adapter.readOnly).map((adapter) => adapter.pane);
}

describe("EditorSession mode synchronization", () => {
  afterEach(() => vi.restoreAllMocks());

  it("keeps exact valid Source canonical while atomically projecting accepted Visual", async () => {
    const { session, source, visual } = await createSession();
    source.selection = { anchor: 5, head: 5 };

    expect(source.markdown).toBe(VALID_SOURCE);
    expect(writablePanes(source, visual)).toEqual(["source"]);

    const result = await session.switchMode("visual");

    expect(result).toEqual({ success: true, mode: "visual" });
    expect(session.snapshot()).toMatchObject({
      mode: "visual",
      activePane: "visual",
      markdown: VALID_SOURCE,
      diagnostics: [],
    });
    expect(visual.markdown).toBe(analysis(VALID_SOURCE).canonicalMarkdown);
    expect(visual.restoredSelections).toEqual([{ anchor: 5, head: 5 }]);
    expect(writablePanes(source, visual)).toEqual(["visual"]);
  });

  it.each(["visual", "split"] as const)(
    "retains fatal Source byte-for-byte and blocks writable %s without stale overwrite",
    async (target) => {
      const { session, source, visual } = await createSession({ markdown: FATAL_SOURCE });
      const staleVisual = visual.markdown;

      const result = await session.switchMode(target);

      expect(result).toMatchObject({
        success: false,
        mode: "source",
        reason: "document-invalid",
      });
      expect(result.diagnostics?.some((item) => item.severity === "error")).toBe(true);
      expect(session.snapshot()).toMatchObject({
        mode: "source",
        activePane: "source",
        markdown: FATAL_SOURCE,
      });
      expect(session.snapshot().diagnostics.some((item) => item.severity === "error")).toBe(true);
      expect(source.markdown).toBe(FATAL_SOURCE);
      expect(visual.markdown).toBe(staleVisual);
      expect(writablePanes(source, visual)).toEqual(["source"]);

      visual.emit(`${VALID_SOURCE}\n\nFORGED STALE VISUAL`);
      expect(session.snapshot().markdown).toBe(FATAL_SOURCE);
    },
  );

  it("serializes and validates Visual before Source accepts canonical state", async () => {
    const documents = new ImmediateDocuments();
    const { session, source, visual } = await createSession({ documents });
    await session.switchMode("visual");
    visual.emit(SECOND_SOURCE);
    const expectedCanonical = analysis(SECOND_SOURCE).canonicalMarkdown;

    const result = await session.switchMode("source");

    expect(result).toEqual({ success: true, mode: "source" });
    expect(documents.markdown.at(-1)).toBe(expectedCanonical);
    expect(source.markdown).toBe(expectedCanonical);
    expect(session.snapshot()).toMatchObject({
      markdown: expectedCanonical,
      mode: "source",
      activePane: "source",
    });
    expect(writablePanes(source, visual)).toEqual(["source"]);
  });

  it("keeps the prior mode/content authoritative when the target adapter rejects projection", async () => {
    const { session, source, visual } = await createSession();
    visual.failProjection = true;

    const result = await session.switchMode("visual");

    expect(result).toEqual({
      success: false,
      mode: "source",
      reason: "adapter-rejected",
    });
    expect(session.snapshot()).toMatchObject({ mode: "source", markdown: VALID_SOURCE });
    expect(source.markdown).toBe(VALID_SOURCE);
    expect(writablePanes(source, visual)).toEqual(["source"]);
  });

  it("uses split as one source-writable pane plus one read-only visual projection", async () => {
    const { session, source, visual } = await createSession();

    await expect(session.switchMode("split")).resolves.toEqual({ success: true, mode: "split" });
    expect(session.snapshot()).toMatchObject({ mode: "split", activePane: "source" });
    expect(writablePanes(source, visual)).toEqual(["source"]);

    visual.emit(`${VALID_SOURCE}\n\nSECONDARY MUST NOT WRITE`);
    expect(session.snapshot().markdown).toBe(VALID_SOURCE);

    source.emit(SECOND_SOURCE);
    expect(session.snapshot().markdown).toBe(SECOND_SOURCE);
  });

  it("retains Visual as the only writable pane when split is entered from Visual", async () => {
    const { session, source, visual } = await createSession();
    await session.switchMode("visual");
    visual.emit(SECOND_SOURCE);

    await expect(session.switchMode("split")).resolves.toEqual({ success: true, mode: "split" });

    expect(session.snapshot()).toMatchObject({ mode: "split", activePane: "visual" });
    expect(writablePanes(source, visual)).toEqual(["visual"]);
    const authoritative = session.snapshot().markdown;
    source.emit(`${VALID_SOURCE}\n\nREAD ONLY FORGERY`);
    expect(session.snapshot().markdown).toBe(authoritative);
  });

  it("commits only the latest rapid worker result", async () => {
    const documents = new ControlledDocuments();
    const { session, source, visual } = await createSession({ documents });

    const staleVisual = session.switchMode("visual");
    const latestSplit = session.switchMode("split");
    expect(documents.requests).toHaveLength(2);

    documents.resolve(1);
    await expect(latestSplit).resolves.toEqual({ success: true, mode: "split" });
    documents.resolve(0);
    await expect(staleVisual).resolves.toMatchObject({
      success: false,
      mode: "split",
      reason: "superseded",
    });

    expect(session.snapshot()).toMatchObject({ mode: "split", activePane: "source" });
    expect(writablePanes(source, visual)).toEqual(["source"]);
  });

  it("serializes adapter transactions so a stale delayed projection cannot unlock Visual", async () => {
    const { session, source, visual } = await createSession();
    const gate = deferred<void>();
    visual.projectionGate = gate;

    const staleVisual = session.switchMode("visual");
    await vi.waitFor(() => expect(visual.projections).toContain(VALID_SOURCE));
    const latestSource = session.switchMode("source");
    gate.resolve();

    await expect(staleVisual).resolves.toMatchObject({ reason: "superseded" });
    await expect(latestSource).resolves.toEqual({ success: true, mode: "source" });
    expect(session.snapshot().mode).toBe("source");
    expect(writablePanes(source, visual)).toEqual(["source"]);
  });

  it("fails closed on worker rejection without exposing the raw error", async () => {
    const documents = new ControlledDocuments();
    const { session, source, visual } = await createSession({ documents });
    const switching = session.switchMode("visual");

    documents.reject(0);

    await expect(switching).resolves.toEqual({
      success: false,
      mode: "source",
      reason: "document-worker-failed",
    });
    expect(session.snapshot().markdown).toBe(VALID_SOURCE);
    expect(writablePanes(source, visual)).toEqual(["source"]);
  });

  it("ignores a pending worker response after dispose and leaves every adapter locked", async () => {
    const documents = new ControlledDocuments();
    const { session, source, visual } = await createSession({ documents });
    const switching = session.switchMode("visual");

    await session.dispose();
    documents.resolve(0);

    await expect(switching).resolves.toMatchObject({ success: false, reason: "disposed" });
    expect(documents.disposeCalls).toBe(1);
    expect(writablePanes(source, visual)).toEqual([]);
  });

  it.each(["lock", "session"] as const)(
    "invalidates pending mode work on %s revocation before any adapter can regain writes",
    async (kind) => {
      const documents = new ControlledDocuments();
      const lock = new ModeLock();
      const lifecycle = new LiveLifecycle();
      const { session, source, visual } = await createSession({ documents, lock, lifecycle });
      const switching = session.switchMode("visual");

      if (kind === "lock") lock.revoke();
      else await lifecycle.revoke();
      documents.resolve(0);

      await expect(switching).resolves.toMatchObject({ success: false });
      expect(session.snapshot()).toMatchObject({ readOnly: true, mode: "source" });
      expect(writablePanes(source, visual)).toEqual([]);
    },
  );

  it("treats selection restoration as best effort and never as canonical state", async () => {
    const { session, source, visual } = await createSession();
    source.selection = { anchor: 3, head: 7 };
    visual.failSelectionRestore = true;

    await expect(session.switchMode("visual")).resolves.toEqual({
      success: true,
      mode: "visual",
    });
    expect(session.snapshot().markdown).toBe(VALID_SOURCE);
    expect("selection" in session.snapshot()).toBe(false);
  });
});
