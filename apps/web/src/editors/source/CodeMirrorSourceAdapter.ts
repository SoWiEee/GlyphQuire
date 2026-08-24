import { closeBrackets, closeBracketsKeymap, completionKeymap } from "@codemirror/autocomplete";
import {
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab,
  redo as cmRedo,
  undo as cmUndo,
} from "@codemirror/commands";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { bracketMatching, syntaxHighlighting, defaultHighlightStyle } from "@codemirror/language";
import { lintGutter, linter, forceLinting, type Diagnostic } from "@codemirror/lint";
import { highlightSelectionMatches, searchKeymap } from "@codemirror/search";
import { Annotation, Compartment, EditorState } from "@codemirror/state";
import { EditorView, keymap, placeholder } from "@codemirror/view";
import type { EditorAdapter } from "../types.js";

/**
 * Flags an unclosed inline markdown link, e.g. `[label(no closing paren`.
 * This is a small, deliberately narrow lint — real markdown validation lives
 * in @glyphquire/document-engine, not here.
 */
const UNCLOSED_LINK_PATTERN = /\[[^\]]*\]\([^)]*$/;
const authoritativeProjection = Annotation.define<boolean>();

function lintUnclosedLinks(view: EditorView): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const text = view.state.doc.toString();
  const match = UNCLOSED_LINK_PATTERN.exec(text);
  if (match) {
    const from = match.index;
    diagnostics.push({
      from,
      to: text.length,
      severity: "error",
      message: "Unclosed markdown link — missing a closing parenthesis.",
    });
  }
  return diagnostics;
}

/**
 * CodeMirror 6 implementation of {@link EditorAdapter}. All CodeMirror types
 * stay behind this class — the workbench shell depends only on EditorAdapter.
 */
export class CodeMirrorSourceAdapter implements EditorAdapter {
  private view: EditorView | undefined;
  private readOnlyCompartment = new Compartment();
  private historyCompartment = new Compartment();
  private changeListeners = new Set<(markdown: string) => void>();
  /** Boxed so the static transactionFilter extension can read live state. */
  private readOnlyBox = { readOnly: false };

  mount(host: HTMLElement): void {
    if (this.view) {
      throw new Error("CodeMirrorSourceAdapter is already mounted; call destroy() first.");
    }

    const state = EditorState.create({
      doc: "",
      extensions: [
        this.historyCompartment.of(history()),
        closeBrackets(),
        bracketMatching(),
        highlightSelectionMatches(),
        lintGutter(),
        linter(lintUnclosedLinks),
        syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
        markdown({ base: markdownLanguage, codeLanguages: [] }),
        placeholder("Start writing…"),
        this.readOnlyCompartment.of([EditorView.editable.of(true), EditorState.readOnly.of(false)]),
        // Belt-and-suspenders: the readOnly facet above governs the built-in
        // commands, but a caller can still dispatch a raw transaction
        // directly against the view. Filter those out too; only this module's
        // annotated authoritative projection may change a locked document.
        EditorState.transactionFilter.of((tr) =>
          this.readOnlyBox.readOnly &&
          tr.docChanged &&
          tr.annotation(authoritativeProjection) !== true
            ? []
            : tr,
        ),
        keymap.of([
          ...closeBracketsKeymap,
          ...defaultKeymap,
          ...historyKeymap,
          ...searchKeymap,
          ...completionKeymap,
          indentWithTab,
        ]),
        EditorView.updateListener.of((update) => {
          const includesUserChange = update.transactions.some(
            (transaction) => transaction.annotation(authoritativeProjection) !== true,
          );
          if (update.docChanged && includesUserChange) {
            const markdownText = update.state.doc.toString();
            for (const listener of this.changeListeners) {
              listener(markdownText);
            }
          }
        }),
      ],
    });

    this.view = new EditorView({ state, parent: host });
  }

  setMarkdown(markdown: string): void {
    const view = this.requireView();
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: markdown },
      effects: this.historyCompartment.reconfigure([]),
      annotations: authoritativeProjection.of(true),
    });
    view.dispatch({
      effects: this.historyCompartment.reconfigure(history()),
      annotations: authoritativeProjection.of(true),
    });
  }

  getMarkdown(): string {
    return this.requireView().state.doc.toString();
  }

  setReadOnly(readOnly: boolean): void {
    const view = this.requireView();
    this.readOnlyBox.readOnly = readOnly;
    view.dispatch({
      effects: this.readOnlyCompartment.reconfigure([
        EditorView.editable.of(!readOnly),
        EditorState.readOnly.of(readOnly),
      ]),
    });
  }

  onChange(listener: (markdown: string) => void): () => void {
    this.changeListeners.add(listener);
    return () => this.changeListeners.delete(listener);
  }

  focus(): void {
    this.requireView().focus();
  }

  destroy(): void {
    this.view?.destroy();
    this.view = undefined;
    this.changeListeners.clear();
  }

  /** Test-only escape hatch to the raw CodeMirror view; not part of EditorAdapter. */
  getView(): EditorView {
    return this.requireView();
  }

  /** Test-only helper mirroring the Ctrl/Cmd+Z keybinding's command. */
  undo(): boolean {
    return cmUndo(this.requireView());
  }

  /** Test-only helper mirroring the Ctrl/Cmd+Shift+Z keybinding's command. */
  redo(): boolean {
    return cmRedo(this.requireView());
  }

  /** Test-only helper to force a lint pass instead of waiting on the debounce timer. */
  runLintForTests(): Promise<void> {
    forceLinting(this.requireView());
    // The lint plugin resolves its (already-synchronous) source through a
    // Promise chain internally; one microtask tick lets that settle.
    return Promise.resolve().then(() => undefined);
  }

  private requireView(): EditorView {
    if (!this.view) {
      throw new Error("CodeMirrorSourceAdapter has not been mounted yet.");
    }
    return this.view;
  }
}
