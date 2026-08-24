import type { EditorSession } from "../../editors/editor-session.types.js";

/** A single in-memory note the workbench can open into a tab. */
export interface WorkbenchNote {
  id: string;
  title: string;
  markdown: string;
}

/** The editor's source/visual mode control. Visual mode is a stub in this task. */
export type WorkbenchEditorMode = "source" | "visual";

/** One entry the command palette can run. */
export interface WorkbenchCommand {
  id: string;
  label: string;
  hint?: string;
  run: () => void;
}

/** Opens the one authoritative browser session for a selected note. */
export type WorkbenchSessionFactory = (note: Readonly<WorkbenchNote>) => Promise<EditorSession>;
