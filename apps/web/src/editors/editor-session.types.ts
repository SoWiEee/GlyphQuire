import type { NoteConflict, NoteResult, SaveNoteInput } from "@glyphquire/api-contract";
import type { DocumentDiagnostic } from "@glyphquire/document-engine";
import type {
  AutosaveClock,
  AutosaveState,
  AutosaveStatus,
} from "../autosave/AutosaveController.js";
import type { EditorSessionLifecycle } from "../coordination/SessionLifecycleCoordinator.js";
import type { NoteScope } from "../coordination/TabChannel.js";
import type { DraftKey, DraftRecord, DraftStore } from "../persistence/DraftStore.js";
import type { EditorLifecycleAdapter } from "./EditorLifecycleController.js";
import type { DocumentAnalysis } from "./DocumentWorkerClient.js";

export type EditorSessionMode = "visual" | "source" | "split";
export type EditorPane = "visual" | "source";
export type DraftDurability = "persisted" | "pending" | "memory-only-error";

export interface EditorSelection {
  readonly anchor: number;
  readonly head: number;
}

/** Mounted adapter capabilities needed by the authoritative mode transaction. */
export interface EditorModeAdapter {
  setMarkdown(markdown: string): void | Promise<void>;
  getMarkdown(): string;
  setReadOnly(readOnly: boolean): void;
  onChange(listener: (markdown: string) => void): () => void;
  getSelection?(): EditorSelection | null;
  setSelection?(selection: EditorSelection): void;
}

export interface EditorModeAdapters {
  readonly source: EditorModeAdapter;
  readonly visual: EditorModeAdapter;
}

/** Narrow worker seam; the production implementation is DocumentWorkerClient. */
export interface DocumentAnalysisPort {
  parseAndValidate(markdown: string): Promise<DocumentAnalysis>;
  cancel(): void;
  dispose(): void;
}

export interface DraftDurabilityError {
  readonly code: "DRAFT_PERSISTENCE_FAILED";
  readonly message: string;
}

/**
 * Everything a UI layer needs to render the current editing surface: which
 * mode is active, whether this tab may write at all, and the full autosave
 * lifecycle (`clean` → `dirty` → `saving` → `saved`, or `offline`/`error`/
 * `conflict`).
 */
export interface EditorSessionState {
  readonly noteId: string;
  /** The one canonical browser-side source; editor adapters only project this value. */
  readonly markdown: string;
  readonly baseRevision: number;
  readonly dirty: boolean;
  readonly saveStatus: AutosaveStatus;
  readonly conflict: NoteConflict | null;
  readonly mode: EditorSessionMode;
  /** The only pane allowed to emit authoritative edits, including in split mode. */
  readonly activePane: EditorPane;
  readonly diagnostics: readonly DocumentDiagnostic[];
  readonly readOnly: boolean;
  /** Compatibility alias for the Task 8 workbench while it adopts readOnly. */
  readonly isReadOnly: boolean;
  /** Whether recoverable editor material is safely reflected in local storage. */
  readonly draftDurability: DraftDurability;
  readonly draftDurabilityError: DraftDurabilityError | null;
  readonly autosave: AutosaveState;
}

export interface SwitchResult {
  readonly success: boolean;
  readonly mode: EditorSessionMode;
  /** Present when `success` is false — e.g. the target mode has no adapter yet. */
  readonly reason?: string;
  readonly diagnostics?: readonly DocumentDiagnostic[];
}

/** The narrow slice of {@link NoteClient} EditorSession depends on. */
export interface NoteRemote {
  save(noteId: string, input: SaveNoteInput): Promise<NoteResult>;
}

/** The narrow slice of {@link NoteLock} EditorSession depends on. */
export interface NoteLockLike {
  readonly scope: NoteScope;
  acquire(): Promise<boolean>;
  isOwner(): boolean;
  release(): void;
  requestTakeover(): Promise<boolean>;
  subscribeOwnership(listener: (owned: boolean) => void): () => void;
}

export type { DraftKey, DraftRecord, DraftStore };

export interface EditorSessionDeps {
  readonly userId: string;
  readonly workspaceId: string;
  readonly noteId: string;
  readonly initialRevision: number;
  readonly initialMarkdown: string;
  readonly noteClient: NoteRemote;
  readonly draftStore: DraftStore;
  readonly noteLock: NoteLockLike;
  readonly sessionLifecycle: EditorSessionLifecycle;
  readonly lifecycleAdapter?: EditorLifecycleAdapter;
  readonly documentAnalysis?: DocumentAnalysisPort;
  readonly generateOperationId?: () => string;
  readonly debounceMs?: number;
  readonly retryBaseMs?: number;
  readonly retryMaxMs?: number;
  readonly clock?: AutosaveClock;
}

/**
 * The single writable, authoritative controller for one open note. Owns the
 * autosave lifecycle, the local draft, and this tab's write-lock membership;
 * every other browser-side module (the editor adapter, the workbench UI)
 * only ever talks to this interface.
 */
export interface EditorSession {
  snapshot(): EditorSessionState;
  edit(markdown: string): void;
  switchMode(mode: EditorSessionMode): Promise<SwitchResult>;
  /** Binds the one mounted Source/Visual pair. The returned function detaches that exact pair. */
  attachModeAdapters(adapters: EditorModeAdapters): Promise<() => void>;
  saveNow(): Promise<void>;
  requestTakeover(): Promise<boolean>;
  subscribe(listener: (state: EditorSessionState) => void): () => void;
  dispose(): Promise<void>;
}
