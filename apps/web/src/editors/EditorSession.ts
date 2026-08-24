import { markdownSchema, revisionSchema } from "@glyphquire/api-contract";
import type { DocumentDiagnostic } from "@glyphquire/document-engine";
import { NoteApiError } from "../api/NoteClient.js";
import { AutosaveController } from "../autosave/AutosaveController.js";
import { noteScopeSchema, sameNoteScope } from "../coordination/TabChannel.js";
import { EditorLifecycleController } from "./EditorLifecycleController.js";
import { DocumentWorkerClient } from "./DocumentWorkerClient.js";
import type { NoteConflict } from "@glyphquire/api-contract";
import type { AutosaveState } from "../autosave/AutosaveController.js";
import type { NoteScope } from "../coordination/TabChannel.js";
import type {
  DraftKey,
  DocumentAnalysisPort,
  EditorSession,
  EditorSessionDeps,
  EditorSessionMode,
  EditorSessionState,
  EditorModeAdapters,
  EditorPane,
  EditorSelection,
  DraftDurability,
  DraftDurabilityError,
  SwitchResult,
} from "./editor-session.types.js";

const editorOpenInputSchema = noteScopeSchema.extend({
  initialRevision: revisionSchema,
  initialMarkdown: markdownSchema,
});

const DRAFT_PERSISTENCE_ERROR: DraftDurabilityError = Object.freeze({
  code: "DRAFT_PERSISTENCE_FAILED",
  message:
    "Local draft recovery is unavailable; changes may be lost if this tab closes before saving completes",
});

interface RecoveredDraft {
  readonly operationId: string;
  readonly baseRevision: number;
  readonly markdown: string;
  readonly conflict: NoteConflict | null;
  readonly updatedAt: number;
  /** Revision mismatch means the persisted operation's server binding is unknowable. */
  readonly mintFreshOperationId?: boolean;
}

interface AdapterBinding {
  readonly version: number;
  readonly adapters: EditorModeAdapters;
  readonly unsubscribe: readonly [() => void, () => void];
}

interface ModeCapture {
  readonly binding: AdapterBinding;
  readonly markdown: string;
  readonly selection: EditorSelection | null;
}

const EMPTY_GLYPHQUIRE_MARKDOWN = "---\nglyphquire-spec: 1\n---\n";

/** The sole authoritative browser controller for one validated note scope. */
class EditorSessionImpl implements EditorSession {
  private readonly autosave: AutosaveController;
  private readonly unsubscribeAutosave: () => void;
  private readonly unsubscribeOwnership: () => void;
  private readonly lifecycleController: EditorLifecycleController | undefined;
  private readonly listeners = new Set<(state: EditorSessionState) => void>();
  private readonly draftKey: DraftKey;
  private unregisterSessionLifecycle: (() => void) | undefined;
  private mode: EditorSessionMode = "source";
  private activePane: EditorPane = "source";
  private diagnostics: readonly DocumentDiagnostic[] = [];
  private markdown: string;
  private isReadOnly: boolean;
  private draftUpdatedAt: number | null;
  private sessionEnded = false;
  private disposed = false;
  private lastDraftSync: Promise<void> = Promise.resolve();
  private draftSyncVersion = 0;
  private draftDurability: DraftDurability = "persisted";
  private draftDurabilityError: DraftDurabilityError | null = null;
  private readonly documentAnalysis: DocumentAnalysisPort;
  private adapterBinding: AdapterBinding | undefined;
  private adapterBindingVersion = 0;
  private modeRequestVersion = 0;
  private adapterTransactions: Promise<void> = Promise.resolve();
  private suppressNotifications = 0;

  constructor(
    private readonly deps: EditorSessionDeps,
    private readonly scope: NoteScope,
    initialRevision: number,
    initialMarkdown: string,
    isReadOnly: boolean,
    private readonly recoveredDraft?: RecoveredDraft,
  ) {
    this.isReadOnly = isReadOnly;
    this.markdown = recoveredDraft?.markdown ?? initialMarkdown;
    this.draftUpdatedAt = recoveredDraft?.updatedAt ?? null;
    this.draftKey = scope;
    this.documentAnalysis = deps.documentAnalysis ?? new DocumentWorkerClient();
    this.autosave = new AutosaveController({
      initialRevision,
      save: async (input) => {
        // Debounced and retry timers can fire after the session clock crosses
        // expiresAt but before the coordinator's asynchronous scrub callback.
        // Recheck at the final transport boundary, not only when edit/saveNow
        // originally scheduled the attempt.
        if (!this.authorizationAllowsWrite() || this.isReadOnly) {
          throw new Error("Editor write authorization expired");
        }
        const result = await deps.noteClient.save(scope.noteId, input);
        if (result.id !== scope.noteId || result.workspaceId !== scope.workspaceId) {
          throw new NoteApiError("SERVICE_UNAVAILABLE", 502, "unknown");
        }
        return {
          revision: result.revision,
          contentMarkdown: result.contentMarkdown,
        };
      },
      generateOperationId: deps.generateOperationId,
      clock: deps.clock,
      debounceMs: deps.debounceMs,
      retryBaseMs: deps.retryBaseMs,
      retryMaxMs: deps.retryMaxMs,
    });
    this.unsubscribeAutosave = this.autosave.subscribe((state) => this.onAutosaveState(state));
    this.unsubscribeOwnership = deps.noteLock.subscribeOwnership((owned) =>
      this.onOwnershipChanged(owned),
    );
    this.lifecycleController = deps.lifecycleAdapter
      ? new EditorLifecycleController(deps.lifecycleAdapter, {
          retryNow: () => this.retryNow(),
          saveNow: () => this.saveNow(),
        })
      : undefined;
  }

  registerSessionLifecycle(): void {
    this.unregisterSessionLifecycle = this.deps.sessionLifecycle.registerEditor(this.scope, () =>
      this.lockAndClearForSessionEnd(),
    );
    if (this.recoveredDraft && !this.isReadOnly) {
      this.deps.sessionLifecycle.assertEditorAuthorized(this.scope);
      this.autosave.recoverPendingAttempt(
        this.recoveredDraft,
        this.recoveredDraft.conflict,
        this.recoveredDraft.mintFreshOperationId,
      );
    }
  }

  snapshot(): EditorSessionState {
    const autosave = this.autosave.getState();
    return {
      noteId: this.scope.noteId,
      markdown: this.markdown,
      baseRevision: autosave.revision,
      dirty: autosave.pending !== null,
      saveStatus: autosave.status,
      conflict: autosave.conflict,
      mode: this.mode,
      activePane: this.activePane,
      diagnostics: this.diagnostics,
      readOnly: this.isReadOnly,
      isReadOnly: this.isReadOnly,
      draftDurability: this.draftDurability,
      draftDurabilityError: this.draftDurabilityError,
      autosave,
    };
  }

  edit(markdown: string): void {
    if (this.disposed || this.sessionEnded) return;
    if (!this.authorizationAllowsWrite() || this.isReadOnly) return;
    const previousMarkdown = this.markdown;
    const previousDraftUpdatedAt = this.draftUpdatedAt;
    const previousDiagnostics = this.diagnostics;
    this.markdown = markdown;
    this.diagnostics = [];
    this.draftUpdatedAt = this.deps.clock?.now() ?? Date.now();
    try {
      this.autosave.edit(markdown);
    } catch (error) {
      this.markdown = previousMarkdown;
      this.draftUpdatedAt = previousDraftUpdatedAt;
      this.diagnostics = previousDiagnostics;
      throw error;
    }
  }

  async saveNow(): Promise<void> {
    if (this.disposed || this.sessionEnded) return;
    if (!this.authorizationAllowsWrite() || this.isReadOnly) return;
    this.retryDraftPersistence();
    await this.autosave.saveNow();
  }

  async switchMode(mode: EditorSessionMode): Promise<SwitchResult> {
    const requestVersion = ++this.modeRequestVersion;
    this.documentAnalysis.cancel();
    const unavailable = this.modeRequestFailure(requestVersion);
    if (unavailable) return unavailable;

    const requiresVisualProjection =
      this.activePane === "source" && (mode === "visual" || mode === "split");
    const requiresSourceProjection =
      this.activePane === "visual" && (mode === "source" || mode === "split");
    const needsAdapters =
      mode !== "source" || this.mode !== "source" || this.adapterBinding !== undefined;
    if (needsAdapters && !this.adapterBinding) {
      return { success: false, mode: this.mode, reason: "unsupported" };
    }

    if (!requiresVisualProjection && !requiresSourceProjection) {
      return this.commitModeWithoutProjection(mode, requestVersion);
    }

    // Capture is synchronous and deliberately does not go through the adapter
    // transaction queue: it only reads current, already-settled adapter state
    // (getMarkdown/getSelection are synchronous by contract), so a second
    // rapid switchMode call can race a first one to the document worker
    // without waiting on a still-in-flight projection commit.
    let capture: ModeCapture;
    try {
      capture = this.captureModeSource();
    } catch {
      const binding = this.adapterBinding;
      if (binding) await this.restoreCommittedAdapterPolicy(binding, requestVersion);
      return { success: false, mode: this.mode, reason: "adapter-rejected" };
    }

    let markdownToValidate = capture.markdown;
    let analyzed;
    try {
      analyzed = await this.documentAnalysis.parseAndValidate(markdownToValidate);
    } catch {
      const failure = this.modeRequestFailure(requestVersion);
      if (failure) return failure;
      await this.restoreCommittedAdapterPolicy(capture.binding, requestVersion);
      return { success: false, mode: this.mode, reason: "document-worker-failed" };
    }
    let afterAnalysis = this.modeRequestFailure(requestVersion);
    if (afterAnalysis) return afterAnalysis;
    if (analyzed.result.source !== markdownToValidate) {
      await this.restoreCommittedAdapterPolicy(capture.binding, requestVersion);
      return { success: false, mode: this.mode, reason: "document-worker-failed" };
    }

    // Visual content did not originate from typed canonical Markdown, so its
    // serialized (canonicalized) form is independently re-validated before
    // Source is ever allowed to treat it as authoritative.
    if (
      requiresSourceProjection &&
      analyzed.result.ok &&
      analyzed.canonicalMarkdown !== null &&
      analyzed.canonicalMarkdown !== markdownToValidate
    ) {
      markdownToValidate = analyzed.canonicalMarkdown;
      try {
        analyzed = await this.documentAnalysis.parseAndValidate(markdownToValidate);
      } catch {
        const failure = this.modeRequestFailure(requestVersion);
        if (failure) return failure;
        await this.restoreCommittedAdapterPolicy(capture.binding, requestVersion);
        return { success: false, mode: this.mode, reason: "document-worker-failed" };
      }
      afterAnalysis = this.modeRequestFailure(requestVersion);
      if (afterAnalysis) return afterAnalysis;
      if (analyzed.result.source !== markdownToValidate) {
        await this.restoreCommittedAdapterPolicy(capture.binding, requestVersion);
        return { success: false, mode: this.mode, reason: "document-worker-failed" };
      }
    }

    this.diagnostics = analyzed.result.diagnostics.map((item) => ({
      ...item,
      ...(item.range ? { range: { ...item.range } } : {}),
    }));
    if (!analyzed.result.ok || analyzed.canonicalMarkdown === null) {
      if (!this.diagnostics.some((item) => item.severity === "error")) {
        this.diagnostics = [
          ...this.diagnostics,
          {
            code: "DOCUMENT_INVALID",
            severity: "error",
            message: "The document could not be validated as GlyphQuire Markdown.",
          },
        ];
      }
      await this.restoreCommittedAdapterPolicy(capture.binding, requestVersion);
      this.notify();
      return {
        success: false,
        mode: this.mode,
        reason: "document-invalid",
        diagnostics: this.diagnostics,
      };
    }

    const canonicalMarkdown = analyzed.canonicalMarkdown;
    try {
      const committed = await this.enqueueAdapterTransaction(async () => {
        const failure = this.modeRequestFailure(requestVersion);
        if (failure || this.adapterBinding !== capture.binding) return false;
        this.lockAdapters(capture.binding.adapters);
        if (requiresVisualProjection) {
          await capture.binding.adapters.visual.setMarkdown(markdownToValidate);
          if (this.modeRequestFailure(requestVersion)) return false;
          if (capture.binding.adapters.visual.getMarkdown() !== canonicalMarkdown) {
            throw new Error("Visual adapter did not accept the validated projection");
          }
          this.restoreSelection(capture.binding.adapters.visual, capture.selection);
        } else {
          await capture.binding.adapters.source.setMarkdown(canonicalMarkdown);
          if (this.modeRequestFailure(requestVersion)) return false;
          if (capture.binding.adapters.source.getMarkdown() !== canonicalMarkdown) {
            throw new Error("Source adapter did not accept canonical Markdown");
          }
          this.restoreSelection(capture.binding.adapters.source, capture.selection);
        }
        const finalFailure = this.modeRequestFailure(requestVersion);
        if (finalFailure) return false;

        this.suppressNotifications += 1;
        try {
          if (requiresSourceProjection && this.markdown !== canonicalMarkdown) {
            this.edit(canonicalMarkdown);
          }
          this.mode = mode;
          if (mode !== "split") this.activePane = mode;
          this.applyAdapterPolicy(capture.binding);
        } finally {
          this.suppressNotifications -= 1;
        }
        this.notify();
        return true;
      });
      if (!committed) {
        await this.restoreCommittedAdapterPolicy(capture.binding, requestVersion);
        return this.modeRequestFailure(requestVersion) ?? this.supersededResult();
      }
    } catch {
      await this.restoreCommittedAdapterPolicy(capture.binding, requestVersion);
      return { success: false, mode: this.mode, reason: "adapter-rejected" };
    }

    if (requiresSourceProjection && !this.isReadOnly) await this.saveNow();
    const finalFailure = this.modeRequestFailure(requestVersion);
    if (finalFailure) return finalFailure;
    return { success: true, mode };
  }

  async attachModeAdapters(adapters: EditorModeAdapters): Promise<() => void> {
    if (this.disposed) throw new Error("Cannot attach adapters to a disposed editor session");
    if (this.sessionEnded) throw new Error("Cannot attach adapters to an ended editor session");
    const version = ++this.adapterBindingVersion;
    this.invalidateModeRequests();
    const previous = this.adapterBinding;
    if (previous) this.detachAdapterBinding(previous);
    this.lockAdapters(adapters);
    try {
      await adapters.source.setMarkdown(this.markdown);
      if (
        this.disposed ||
        this.sessionEnded ||
        version !== this.adapterBindingVersion ||
        adapters.source.getMarkdown() !== this.markdown
      ) {
        throw new Error("Source adapter did not accept authoritative Markdown");
      }
      let binding!: AdapterBinding;
      binding = {
        version,
        adapters,
        unsubscribe: [
          adapters.source.onChange((markdown) => this.onAdapterChange(binding, "source", markdown)),
          adapters.visual.onChange((markdown) => this.onAdapterChange(binding, "visual", markdown)),
        ],
      };
      this.adapterBinding = binding;
      this.applyAdapterPolicy(binding);
      return () => {
        if (this.adapterBinding !== binding) return;
        this.invalidateModeRequests();
        this.detachAdapterBinding(binding);
        this.adapterBinding = undefined;
      };
    } catch {
      this.lockAdapters(adapters);
      throw new Error("Editor adapter attachment failed");
    }
  }

  /**
   * Reads the active pane's current Markdown and selection synchronously.
   * Every operation here (getMarkdown/getSelection/setReadOnly) is
   * synchronous by the {@link EditorModeAdapter} contract, so this
   * deliberately does not go through the adapter transaction queue: a rapid
   * second `switchMode` call must be able to reach the document worker in
   * the same synchronous turn as the first, without waiting on a prior,
   * still in-flight projection commit.
   */
  private captureModeSource(): ModeCapture {
    const binding = this.adapterBinding;
    if (!binding) throw new Error("Editor session has no attached mode adapters");
    this.lockAdapters(binding.adapters);
    const adapter = binding.adapters[this.activePane];
    const markdown = adapter.getMarkdown();
    markdownSchema.parse(markdown);
    const selection = this.captureSelection(adapter);
    if (this.activePane === "source" && markdown !== this.markdown) {
      this.edit(markdown);
    }
    return { binding, markdown, selection };
  }

  private async commitModeWithoutProjection(
    mode: EditorSessionMode,
    requestVersion: number,
  ): Promise<SwitchResult> {
    if (!this.isReadOnly) await this.saveNow();
    const afterSave = this.modeRequestFailure(requestVersion);
    if (afterSave) return afterSave;

    const binding = this.adapterBinding;
    if (!binding) {
      this.mode = "source";
      this.activePane = "source";
      this.notify();
      return { success: true, mode: "source" };
    }
    try {
      const committed = await this.enqueueAdapterTransaction(() => {
        if (this.modeRequestFailure(requestVersion) || this.adapterBinding !== binding) {
          return false;
        }
        this.mode = mode;
        if (mode !== "split") this.activePane = mode;
        this.applyAdapterPolicy(binding);
        this.notify();
        return true;
      });
      if (!committed) return this.modeRequestFailure(requestVersion) ?? this.supersededResult();
      return { success: true, mode };
    } catch {
      await this.restoreCommittedAdapterPolicy(binding, requestVersion);
      return { success: false, mode: this.mode, reason: "adapter-rejected" };
    }
  }

  private modeRequestFailure(requestVersion: number): SwitchResult | null {
    if (this.disposed) return { success: false, mode: this.mode, reason: "disposed" };
    if (this.sessionEnded) {
      return { success: false, mode: this.mode, reason: "unauthorized" };
    }
    if (requestVersion !== this.modeRequestVersion) return this.supersededResult();
    return null;
  }

  private supersededResult(): SwitchResult {
    return { success: false, mode: this.mode, reason: "superseded" };
  }

  private invalidateModeRequests(): void {
    this.modeRequestVersion += 1;
    this.documentAnalysis.cancel();
  }

  private enqueueAdapterTransaction<T>(operation: () => T | Promise<T>): Promise<T> {
    const current = this.adapterTransactions.then(operation, operation);
    this.adapterTransactions = current.then(
      () => undefined,
      () => undefined,
    );
    return current;
  }

  private lockAdapters(adapters: EditorModeAdapters): void {
    let failure: unknown;
    try {
      adapters.source.setReadOnly(true);
    } catch (error) {
      failure = error;
    }
    try {
      adapters.visual.setReadOnly(true);
    } catch (error) {
      failure ??= error;
    }
    if (failure !== undefined) throw failure;
  }

  private applyAdapterPolicy(binding: AdapterBinding): void {
    this.lockAdapters(binding.adapters);
    if (this.disposed || this.sessionEnded || this.isReadOnly) return;
    try {
      binding.adapters[this.activePane].setReadOnly(false);
    } catch (error) {
      this.lockAdapters(binding.adapters);
      throw error;
    }
  }

  private async restoreCommittedAdapterPolicy(
    binding: AdapterBinding,
    requestVersion: number,
  ): Promise<void> {
    if (requestVersion !== this.modeRequestVersion || this.adapterBinding !== binding) return;
    await this.enqueueAdapterTransaction(() => {
      if (requestVersion !== this.modeRequestVersion || this.adapterBinding !== binding) return;
      this.applyAdapterPolicy(binding);
    }).catch(() => undefined);
  }

  private captureSelection(adapter: EditorModeAdapters[EditorPane]): EditorSelection | null {
    try {
      return adapter.getSelection?.() ?? null;
    } catch {
      return null;
    }
  }

  private restoreSelection(
    adapter: EditorModeAdapters[EditorPane],
    selection: EditorSelection | null,
  ): void {
    if (!selection) return;
    try {
      adapter.setSelection?.(selection);
    } catch {
      // Selection mapping is explicitly best effort and never authoritative.
    }
  }

  private onAdapterChange(binding: AdapterBinding, pane: EditorPane, markdown: string): void {
    if (
      this.adapterBinding !== binding ||
      this.disposed ||
      this.sessionEnded ||
      this.isReadOnly ||
      pane !== this.activePane
    ) {
      return;
    }
    try {
      this.edit(markdown);
    } catch {
      try {
        this.lockAdapters(binding.adapters);
      } catch {
        // Both controls were attempted; no alternative pane is granted writes.
      }
      this.diagnostics = [
        {
          code: "EDITOR_PROJECTION_INVALID",
          severity: "error",
          message: "The editor produced an invalid Markdown projection.",
        },
      ];
      this.notify();
    }
  }

  private detachAdapterBinding(binding: AdapterBinding): void {
    try {
      this.lockAdapters(binding.adapters);
    } finally {
      for (const unsubscribe of binding.unsubscribe) unsubscribe();
    }
  }

  async requestTakeover(): Promise<boolean> {
    if (this.disposed || this.sessionEnded) return false;
    if (!this.authorizationAllowsWrite()) return false;
    if (!this.isReadOnly) return true;
    const won = await this.deps.noteLock.requestTakeover();
    if (won) this.onOwnershipChanged(true);
    return won;
  }

  subscribe(listener: (state: EditorSessionState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.invalidateModeRequests();
    this.documentAnalysis.dispose();
    const binding = this.adapterBinding;
    this.adapterBinding = undefined;
    this.adapterBindingVersion += 1;
    if (binding) {
      try {
        this.detachAdapterBinding(binding);
      } catch {
        // Locking was attempted for both adapters; disposal continues fail closed.
      }
    }
    this.lifecycleController?.dispose();
    this.unregisterSessionLifecycle?.();
    this.unregisterSessionLifecycle = undefined;
    this.unsubscribeOwnership();
    this.unsubscribeAutosave();
    this.autosave.dispose();
    await this.lastDraftSync;
    if (this.deps.noteLock.isOwner()) this.deps.noteLock.release();
    this.listeners.clear();
  }

  private onOwnershipChanged(owned: boolean): void {
    if (this.disposed || this.sessionEnded) return;
    if (owned) {
      if (!this.authorizationAllowsWrite()) return;
      if (!this.isReadOnly) return;
      this.isReadOnly = false;
      const binding = this.adapterBinding;
      if (binding) {
        try {
          this.applyAdapterPolicy(binding);
        } catch {
          this.isReadOnly = true;
          return;
        }
      }
      this.autosave.resume();
      this.notify();
      return;
    }
    if (this.isReadOnly) return;
    this.invalidateModeRequests();
    this.isReadOnly = true;
    const binding = this.adapterBinding;
    if (binding) {
      try {
        this.lockAdapters(binding.adapters);
      } catch {
        // Both adapter locks were attempted before authority state is published.
      }
    }
    this.autosave.pause();
    this.notify();
  }

  private async lockAndClearForSessionEnd(): Promise<void> {
    if (this.disposed || this.sessionEnded) return;
    this.sessionEnded = true;
    this.invalidateModeRequests();
    this.isReadOnly = true;
    this.markdown = "";
    this.diagnostics = [];
    this.draftUpdatedAt = null;
    const binding = this.adapterBinding;
    if (binding) {
      try {
        this.lockAdapters(binding.adapters);
        await this.enqueueAdapterTransaction(async () => {
          if (this.adapterBinding !== binding) return;
          this.lockAdapters(binding.adapters);
          await binding.adapters.source.setMarkdown("");
          await binding.adapters.visual.setMarkdown(EMPTY_GLYPHQUIRE_MARKDOWN);
          this.lockAdapters(binding.adapters);
        });
      } catch {
        try {
          this.lockAdapters(binding.adapters);
        } catch {
          // Both lock calls were attempted; session authority remains terminal.
        }
      }
    }
    this.lifecycleController?.dispose();
    this.unsubscribeOwnership();
    this.autosave.clearSensitiveState();
    if (this.deps.noteLock.isOwner()) this.deps.noteLock.release();
    await this.lastDraftSync;
    this.notify();
  }

  private authorizationAllowsWrite(): boolean {
    try {
      this.deps.sessionLifecycle.assertEditorAuthorized(this.scope);
      return true;
    } catch {
      // The async revocation callback may still be queued. This call marks
      // the session ended and scrubs it synchronously before returning.
      void this.lockAndClearForSessionEnd();
      return false;
    }
  }

  private async retryNow(): Promise<void> {
    if (this.disposed || this.sessionEnded) return;
    if (!this.authorizationAllowsWrite() || this.isReadOnly) return;
    this.retryDraftPersistence();
    await this.autosave.retryNow();
  }

  private onAutosaveState(state: AutosaveState): void {
    if (!this.isReadOnly || this.sessionEnded) {
      const draftUpdatedAt = this.draftUpdatedAt;
      this.enqueueDraftSync(state, draftUpdatedAt);
    }
    this.notify();
  }

  private retryDraftPersistence(): void {
    if (this.draftDurability !== "memory-only-error") return;
    this.enqueueDraftSync(this.autosave.getState(), this.draftUpdatedAt);
    this.notify();
  }

  private enqueueDraftSync(state: AutosaveState, updatedAt: number | null): void {
    const version = ++this.draftSyncVersion;
    this.draftDurability = "pending";
    this.draftDurabilityError = null;
    this.lastDraftSync = this.lastDraftSync
      .then(() => this.syncDraft(state, updatedAt))
      .then(
        () => {
          if (version !== this.draftSyncVersion) return;
          this.draftDurability = "persisted";
          this.draftDurabilityError = null;
          this.notify();
        },
        () => {
          if (version !== this.draftSyncVersion) return;
          this.draftDurability = "memory-only-error";
          this.draftDurabilityError = DRAFT_PERSISTENCE_ERROR;
          this.notify();
        },
      );
  }

  private async syncDraft(state: AutosaveState, updatedAt: number | null): Promise<void> {
    if (state.pending) {
      await this.deps.draftStore.put({
        ...this.draftKey,
        operationId: state.pending.operationId,
        baseRevision: state.pending.baseRevision,
        markdown: state.pending.markdown,
        conflict: state.conflict,
        updatedAt: updatedAt ?? this.deps.clock?.now() ?? Date.now(),
      });
      return;
    }
    if (state.status === "saved" || state.status === "clean") {
      await this.deps.draftStore.delete(this.draftKey);
      if (this.draftUpdatedAt === updatedAt) this.draftUpdatedAt = null;
    }
  }

  private notify(): void {
    if (this.suppressNotifications > 0) return;
    const state = this.snapshot();
    for (const listener of this.listeners) listener(state);
  }
}

export type { EditorSessionImpl };

/**
 * Validates identity/session/workspace authorization before touching IndexedDB.
 * Authorization is checked again after the asynchronous draft read so an
 * account transition cannot expose a prior identity's recovered content.
 */
export async function openEditorSession(deps: EditorSessionDeps): Promise<EditorSessionImpl> {
  const validated = editorOpenInputSchema.parse({
    userId: deps.userId,
    workspaceId: deps.workspaceId,
    noteId: deps.noteId,
    initialRevision: deps.initialRevision,
    initialMarkdown: deps.initialMarkdown,
  });
  const scope = noteScopeSchema.parse({
    userId: validated.userId,
    workspaceId: validated.workspaceId,
    noteId: validated.noteId,
  });
  const lockScope = noteScopeSchema.safeParse(deps.noteLock.scope);
  if (!lockScope.success || !sameNoteScope(lockScope.data, scope)) {
    throw new Error("NoteLock scope does not match EditorSession scope");
  }

  await deps.sessionLifecycle.authorizeEditor(scope);
  let acquired = false;
  try {
    acquired = await deps.noteLock.acquire();

    let recoveredDraft: RecoveredDraft | undefined;
    if (acquired) {
      const draft = await deps.draftStore.get(scope);
      await deps.sessionLifecycle.authorizeEditor(scope);
      if (draft) {
        if (draft.baseRevision > validated.initialRevision) {
          // A browser draft cannot legitimately be based on a server revision
          // newer than the freshly validated server snapshot.
          await deps.draftStore.delete(scope);
        } else if (
          draft.baseRevision < validated.initialRevision &&
          draft.markdown === validated.initialMarkdown
        ) {
          // Content equality proves the local Markdown is already durable even
          // if the crash happened before the browser processed its acknowledgement.
          await deps.draftStore.delete(scope);
        } else if (draft.baseRevision < validated.initialRevision) {
          recoveredDraft = {
            operationId: draft.operationId,
            baseRevision: validated.initialRevision,
            markdown: draft.markdown,
            conflict: {
              code: "REVISION_CONFLICT",
              noteId: scope.noteId,
              serverRevision: validated.initialRevision,
              serverMarkdown: validated.initialMarkdown,
              serverUpdatedAt: new Date(deps.clock?.now() ?? Date.now()).toISOString(),
              lastEditedBy: null,
              requestId: "local-draft-recovery",
            },
            updatedAt: draft.updatedAt,
            mintFreshOperationId: true,
          };
        } else {
          recoveredDraft = {
            operationId: draft.operationId,
            baseRevision: draft.baseRevision,
            markdown: draft.markdown,
            conflict: draft.conflict ?? null,
            updatedAt: draft.updatedAt,
          };
        }
      }
    } else {
      await deps.sessionLifecycle.authorizeEditor(scope);
    }

    const session = new EditorSessionImpl(
      deps,
      scope,
      validated.initialRevision,
      validated.initialMarkdown,
      !acquired,
      recoveredDraft,
    );
    try {
      session.registerSessionLifecycle();
    } catch (error) {
      await session.dispose();
      throw error;
    }
    return session;
  } catch (error) {
    if (acquired && deps.noteLock.isOwner()) deps.noteLock.release();
    throw error;
  }
}
