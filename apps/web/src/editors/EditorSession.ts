import { markdownSchema, revisionSchema } from "@glyphquire/api-contract";
import { NoteApiError } from "../api/NoteClient.js";
import { AutosaveController } from "../autosave/AutosaveController.js";
import { noteScopeSchema, sameNoteScope } from "../coordination/TabChannel.js";
import { EditorLifecycleController } from "./EditorLifecycleController.js";
import type { NoteConflict } from "@glyphquire/api-contract";
import type { AutosaveState } from "../autosave/AutosaveController.js";
import type { NoteScope } from "../coordination/TabChannel.js";
import type {
  DraftKey,
  EditorSession,
  EditorSessionDeps,
  EditorSessionMode,
  EditorSessionState,
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
  private markdown: string;
  private isReadOnly: boolean;
  private draftUpdatedAt: number | null;
  private sessionEnded = false;
  private disposed = false;
  private lastDraftSync: Promise<void> = Promise.resolve();
  private draftSyncVersion = 0;
  private draftDurability: DraftDurability = "persisted";
  private draftDurabilityError: DraftDurabilityError | null = null;

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
    this.markdown = markdown;
    this.draftUpdatedAt = this.deps.clock?.now() ?? Date.now();
    try {
      this.autosave.edit(markdown);
    } catch (error) {
      this.markdown = previousMarkdown;
      this.draftUpdatedAt = previousDraftUpdatedAt;
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
    if (this.disposed) return { success: false, mode: this.mode, reason: "disposed" };
    if (this.sessionEnded) {
      return { success: false, mode: this.mode, reason: "unauthorized" };
    }
    if (!this.isReadOnly) await this.saveNow();

    if (mode !== "source") {
      return { success: false, mode: this.mode, reason: "unsupported" };
    }

    this.mode = "source";
    this.notify();
    return { success: true, mode: "source" };
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
      this.autosave.resume();
      this.notify();
      return;
    }
    if (this.isReadOnly) return;
    this.isReadOnly = true;
    this.autosave.pause();
    this.notify();
  }

  private async lockAndClearForSessionEnd(): Promise<void> {
    if (this.disposed || this.sessionEnded) return;
    this.sessionEnded = true;
    this.isReadOnly = true;
    this.markdown = "";
    this.draftUpdatedAt = null;
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
