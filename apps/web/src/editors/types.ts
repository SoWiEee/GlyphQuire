/**
 * The seam between the workbench shell and any concrete editor implementation.
 *
 * The workbench only ever talks to this interface — CodeMirror (or any future
 * WYSIWYM/visual engine) stays a private implementation detail behind an adapter.
 */
export interface EditorAdapter {
  /** Mount the editor into the given host element. Call once before any other method. */
  mount(host: HTMLElement): void;
  /** Replace the editor's full document with the given Markdown source. */
  setMarkdown(markdown: string): void;
  /** Read the editor's current document as Markdown source. */
  getMarkdown(): string;
  /** Toggle whether the editor accepts edits. */
  setReadOnly(readOnly: boolean): void;
  /** Subscribe to document changes. Returns an unsubscribe function. */
  onChange(listener: (markdown: string) => void): () => void;
  /** Move keyboard focus into the editor. */
  focus(): void;
  /** Tear down the editor and release all resources. Safe to call once. */
  destroy(): void;
}

export type EditorMode = "source" | "visual";
