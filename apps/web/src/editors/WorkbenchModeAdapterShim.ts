import type { Ref } from "vue";
import type { EditorModeAdapter } from "./editor-session.types.js";

/**
 * An {@link EditorModeAdapter} the workbench builds locally, rather than one
 * backed by a mounted CodeMirror/Milkdown instance. `syncFromUi` is the
 * inbound half: the workbench calls it whenever its own pane component
 * reports an edit, so `EditorSession.attachModeAdapters` sees the same
 * content `getMarkdown()` would report.
 */
export interface WorkbenchModeAdapterShim extends EditorModeAdapter {
  /**
   * Records an edit that originated in this pane's UI. `notify` controls
   * whether registered `onChange` listeners fire: pass `true` only when
   * nothing else already routes this edit into the session (see the two
   * factories below for which case applies to which pane).
   */
  syncFromUi(markdown: string, notify: boolean): void;
}

/**
 * A bookkeeping-only shim: `setMarkdown`/`getMarkdown` track a plain
 * variable, and `onChange` is never invoked. Used for the Source pane, whose
 * displayed content and edit routing already flow through the workbench's
 * pre-existing `EditorSessionState`-driven props and `session.edit()` call —
 * this shim exists only so `EditorSession.attachModeAdapters` has a
 * consistent, always-accurate view of Source's current text for mode-switch
 * capture and projection, without a second, competing edit path.
 */
export function createBookkeepingModeAdapter(initialMarkdown: string): WorkbenchModeAdapterShim {
  let markdown = initialMarkdown;

  return {
    setMarkdown(next: string): void {
      markdown = next;
    },
    getMarkdown(): string {
      return markdown;
    },
    setReadOnly(): void {
      // Source's read-only projection is driven by EditorSessionState
      // (readOnly + activePane) already bound to this pane; nothing to
      // mirror onto a second surface here.
    },
    onChange(): () => void {
      return () => {};
    },
    syncFromUi(next: string): void {
      markdown = next;
    },
  };
}

/**
 * A ref-backed shim: `setMarkdown`/`setReadOnly` write straight into the
 * given reactive refs, which the pane component binds as props, and
 * `onChange` listeners are real. Used for panes (Visual, and Visual's half
 * of Split) that have no other display or edit-routing path of their own.
 */
export function createLiveModeAdapter(
  markdownRef: Ref<string>,
  readOnlyRef: Ref<boolean>,
): WorkbenchModeAdapterShim {
  const listeners = new Set<(markdown: string) => void>();

  return {
    setMarkdown(next: string): void {
      markdownRef.value = next;
    },
    getMarkdown(): string {
      return markdownRef.value;
    },
    setReadOnly(readOnly: boolean): void {
      readOnlyRef.value = readOnly;
    },
    onChange(listener: (markdown: string) => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    syncFromUi(next: string, notify: boolean): void {
      markdownRef.value = next;
      if (!notify) return;
      for (const listener of listeners) listener(next);
    },
  };
}
