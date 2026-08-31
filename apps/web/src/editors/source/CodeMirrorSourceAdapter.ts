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
import { Annotation, Compartment, EditorState, Transaction } from "@codemirror/state";
import { EditorView, keymap, placeholder, type ViewUpdate } from "@codemirror/view";
import type { EditorSelection as WorkbenchEditorSelection } from "../editor-session.types.js";
import type { EditorAdapter } from "../types.js";
import type { ToolbarAction } from "../../components/workbench/types.js";
import { applyToolbarAction } from "../../components/workbench/markdown-format.js";

/**
 * Flags an unclosed inline markdown link, e.g. `[label(no closing paren`.
 * This is a small, deliberately narrow lint — real markdown validation lives
 * in @glyphquire/document-engine, not here.
 */
const UNCLOSED_LINK_PATTERN = /\[[^\]]*\]\([^)]*$/;
const authoritativeProjection = Annotation.define<boolean>();
const editorAction = Annotation.define<"toolbar" | "replace">();

export interface SourceSlashCommand {
  readonly query: string;
  readonly slashRange: { readonly from: number; readonly to: number };
}

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
  private slashListeners = new Set<(request: SourceSlashCommand) => void>();
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
        // CodeMirror renders its content as an implicit `role="textbox"`
        // with no accessible name of its own (WCAG 4.1.2 / axe
        // aria-input-field-name); this is the one workbench text field
        // that needs one supplied explicitly.
        EditorView.contentAttributes.of({ "aria-label": "Note source markdown" }),
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
            const slash = this.detectSlashCommand(update);
            if (slash) {
              for (const listener of this.slashListeners) listener(slash);
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

  getSelection(): WorkbenchEditorSelection {
    const selection = this.requireView().state.selection.main;
    return { anchor: selection.anchor, head: selection.head };
  }

  setSelection(selection: WorkbenchEditorSelection): void {
    const view = this.requireView();
    const max = view.state.doc.length;
    const anchor = Math.max(0, Math.min(max, selection.anchor));
    const head = Math.max(0, Math.min(max, selection.head));
    view.dispatch({ selection: { anchor, head } });
  }

  replaceRange(from: number, to: number, insert: string): boolean {
    const view = this.requireView();
    if (this.readOnlyBox.readOnly) return false;
    const start = Math.max(0, Math.min(view.state.doc.length, Math.min(from, to)));
    const end = Math.max(start, Math.min(view.state.doc.length, Math.max(from, to)));
    const cursor = start + insert.length;
    view.dispatch({
      changes: { from: start, to: end, insert },
      selection: { anchor: cursor, head: cursor },
      annotations: [editorAction.of("replace"), Transaction.userEvent.of("input")],
    });
    return true;
  }

  applyToolbarAction(action: ToolbarAction): boolean {
    const view = this.requireView();
    if (this.readOnlyBox.readOnly) return false;
    const selection = this.getSelection();
    const result = applyToolbarAction(view.state.doc.toString(), action, selection);
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: result.markdown },
      selection: result.selection,
      annotations: [editorAction.of("toolbar"), Transaction.userEvent.of("input")],
    });
    return true;
  }

  onSlashCommand(listener: (request: SourceSlashCommand) => void): () => void {
    this.slashListeners.add(listener);
    return () => this.slashListeners.delete(listener);
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
    this.slashListeners.clear();
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

  private detectSlashCommand(update: ViewUpdate): SourceSlashCommand | null {
    for (const transaction of update.transactions) {
      if (transaction.annotation(authoritativeProjection) === true) continue;
      let insertion: { from: number; to: number } | undefined;
      let changes = 0;
      let valid = true;
      transaction.changes.iterChanges((fromA, toA, fromB, toB, inserted) => {
        changes += 1;
        if (toA !== fromA || inserted.toString() !== "/" || toB !== fromB + 1 || insertion) {
          valid = false;
          return;
        }
        insertion = { from: fromB, to: toB };
      });
      if (!valid || changes !== 1 || !insertion) continue;

      const beforeMarkdown = transaction.startState.doc.toString();
      const oldLineStart = beforeMarkdown.lastIndexOf("\n", insertion.from - 1) + 1;
      const oldLineEnd = beforeMarkdown.indexOf("\n", insertion.from);
      const oldLine = beforeMarkdown.slice(
        oldLineStart,
        oldLineEnd === -1 ? beforeMarkdown.length : oldLineEnd,
      );
      if (oldLine !== "" && !/^\s*(?:[-+*]|\d+[.)])\s+$/u.test(oldLine)) continue;
      const markdown = transaction.newDoc.toString();
      if (isInsideFencedCode(markdown, insertion.from)) continue;
      const start = markdown.lastIndexOf("\n", insertion.from - 1) + 1;
      const beforeSlash = markdown.slice(start, insertion.from);
      if (beforeSlash !== "" && !/^\s*(?:[-+*]|\d+[.)])\s+$/u.test(beforeSlash)) continue;
      return { query: "", slashRange: insertion };
    }
    return null;
  }
}

function isInsideFencedCode(markdown: string, position: number): boolean {
  let fenced: "`" | "~" | null = null;
  let offset = 0;
  for (const line of markdown.split("\n")) {
    if (offset >= position) break;
    const match = /^\s{0,3}(`{3,}|~{3,})/u.exec(line);
    if (match) {
      const marker = match[1][0] as "`" | "~";
      if (fenced === marker) fenced = null;
      else if (!fenced) fenced = marker;
    }
    offset += line.length + 1;
  }
  return fenced !== null;
}
