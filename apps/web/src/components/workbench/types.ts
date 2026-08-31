import type { EditorSession } from "../../editors/editor-session.types.js";

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
  run: () => void;
}

/** Opens the one authoritative browser session for a selected note. */
export interface WorkbenchSessionHandle {
  readonly session: EditorSession;
  readonly context?: {
    readonly userId: string;
    readonly workspaceId: string;
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
