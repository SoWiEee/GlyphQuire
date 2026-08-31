import type { NoteConflict } from "@glyphquire/api-contract";
import type { EditorSession } from "../../editors/editor-session.types.js";

/** The user-visible persistence states for the active workbench session. */
export type WorkbenchSaveState =
  | "saved"
  | "saving"
  | "dirty"
  | "offline"
  | "error"
  | "conflict"
  | "read-only"
  | "unavailable";

/** Identity permitted to open page-level conflict recovery. */
export interface WorkbenchConflictContext {
  readonly userId: string;
  readonly workspaceId: string;
}

/** Payload sent to the page when a validated session exposes a conflict. */
export interface WorkbenchConflictRecovery extends WorkbenchConflictContext {
  readonly noteId: string;
  readonly conflict: NoteConflict;
  readonly localMarkdown: string;
  readonly localBaseRevision: number | null;
}

/** The small set of actions kept visible in the balanced editor toolbar. */
export type ToolbarAction = "bold" | "italic" | "heading" | "bulletList" | "link";

/** A surface handle owned by the active Source, Visual, or Split pane. */
export interface WorkbenchEditorHandle {
  applyToolbarAction(action: ToolbarAction): boolean;
  replaceRange(from: number, to: number, insert: string, cursorOffset?: number): boolean;
}

/** A single in-memory note the workbench can open into a tab. */
export interface WorkbenchNote {
  id: string;
  title: string;
  markdown: string;
}

/** The editor's source/visual/split mode control. */
export type WorkbenchEditorMode = "source" | "visual" | "split";

/** Which navigation surface is open on compact workbench screens. */
export type WorkbenchPanel = "explorer" | "context" | null;

/** Actions exposed by the context rail; outline selection is a separate event. */
export type ContextAction = "outline" | "history" | "assets" | "search" | "transfer" | "share";

/** Account actions are forwarded to the authenticated host without side effects here. */
export type WorkbenchAccountAction = "theme" | "sign-out";

export interface OutlineEntry {
  id: string;
  depth: 1 | 2 | 3;
  label: string;
}

/** One entry the command palette can run. */
export interface WorkbenchCommand {
  id: string;
  label: string;
  hint?: string;
  category?: "format" | "block" | "note" | "workspace";
  run: () => void;
}

export interface SlashCommandRequest {
  readonly query: string;
  readonly slashRange: { readonly from: number; readonly to: number };
}

/** Opens the one authoritative browser session for a selected note. */
export interface WorkbenchSessionHandle {
  readonly session: EditorSession;
  readonly context?: WorkbenchConflictContext & {
    readonly accountLabel?: string;
    readonly workspaceName?: string;
  };
}

/**
 * Opens the one authoritative browser session for a selected note. The bare
 * EditorSession return value remains supported for pre-authenticated callers.
 */
export type WorkbenchSessionFactory = (
  note: Readonly<WorkbenchNote>,
) => Promise<EditorSession | WorkbenchSessionHandle>;
