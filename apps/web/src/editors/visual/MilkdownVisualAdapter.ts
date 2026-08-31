import { createDocumentEngine, type NotebookDocument } from "@glyphquire/document-engine";
import { MAX_MARKDOWN_BYTES } from "@glyphquire/api-contract";
import {
  Editor,
  defaultValueCtx,
  editorViewCtx,
  editorViewOptionsCtx,
  rootAttrsCtx,
  rootCtx,
  schemaCtx,
} from "@milkdown/kit/core";
import { history } from "@milkdown/kit/plugin/history";
import { listener, listenerCtx } from "@milkdown/kit/plugin/listener";
import { commonmark, remarkHtmlTransformer } from "@milkdown/kit/preset/commonmark";
import { gfm } from "@milkdown/kit/preset/gfm";
import { lift, setBlockType, wrapIn } from "@milkdown/kit/prose/commands";
import {
  Plugin,
  TextSelection,
  type EditorState as ProseMirrorEditorState,
  type Transaction,
} from "@milkdown/kit/prose/state";
import { findWrapping } from "@milkdown/kit/prose/transform";
import { $prose, getMarkdown, replaceAll } from "@milkdown/kit/utils";
import type { EditorSelection as WorkbenchEditorSelection } from "../editor-session.types.js";
import type { EditorAdapter } from "../types.js";
import type { ToolbarAction } from "../../components/workbench/types.js";
import { visualCalloutPlugins } from "./nodes/callout.js";
import { visualColumnsPlugins } from "./nodes/columns.js";
import { visualRuntimePlugins } from "./nodes/runtime.js";
import { visualStickyPlugins } from "./nodes/sticky.js";
import { visualTabsPlugins } from "./nodes/tabs.js";
import { visualTogglePlugins } from "./nodes/toggle.js";
import { visualWarningPlugins } from "./nodes/unknown.js";
import {
  GLYPHQUIRE_FRONTMATTER,
  createSafeImageSchema,
  createDirectiveRemarkPlugins,
  safeHtmlSchema,
  safeLinkSchema,
  setVisualControlsReadOnly,
} from "./schema.js";
import { getActiveVisualAssetResolver, type VisualAssetResolver } from "./asset-resolver.js";

const engine = createDocumentEngine();
const EMPTY_MARKDOWN = `${GLYPHQUIRE_FRONTMATTER}`;
const UTF8_ENCODER = new TextEncoder();

interface AcceptedProjection {
  readonly canonicalMarkdown: string;
  readonly document: NotebookDocument;
}

export interface MilkdownVisualAdapterOptions {
  assetResolver?: VisualAssetResolver;
}

export interface VisualSlashCommand {
  readonly query: string;
  readonly slashRange: { readonly from: number; readonly to: number };
}

function acceptedProjection(markdown: string): AcceptedProjection {
  if (
    markdown.length > MAX_MARKDOWN_BYTES ||
    UTF8_ENCODER.encode(markdown).byteLength > MAX_MARKDOWN_BYTES
  ) {
    throw new Error("Visual projection exceeds the Markdown size limit");
  }
  const parsed = engine.parse(markdown);
  if (!parsed.ok) {
    throw new Error("Visual projection requires accepted GlyphQuire Markdown");
  }
  const canonicalMarkdown = engine.serialize(parsed.document);
  if (
    canonicalMarkdown.length > MAX_MARKDOWN_BYTES ||
    UTF8_ENCODER.encode(canonicalMarkdown).byteLength > MAX_MARKDOWN_BYTES
  ) {
    throw new Error("Visual projection canonical form exceeds the Markdown size limit");
  }
  return { canonicalMarkdown, document: parsed.document };
}

function bodyMarkdown(canonicalMarkdown: string): string {
  const match = /^---\nglyphquire-spec: 1\n---\n(?:\n)?/.exec(canonicalMarkdown);
  if (!match) {
    throw new Error("Visual projection is missing canonical GlyphQuire frontmatter");
  }
  return canonicalMarkdown.slice(match[0].length);
}

/**
 * Milkdown implementation of EditorAdapter. Milkdown, ProseMirror, remark
 * directives, custom schemas, and node views are all private to this module.
 */
export class MilkdownVisualAdapter implements EditorAdapter {
  private host: HTMLElement | undefined;
  private editor: Editor | undefined;
  private ready: Promise<void> = Promise.resolve();
  private readonly listeners = new Set<(markdown: string) => void>();
  private readonly slashListeners = new Set<(request: VisualSlashCommand) => void>();
  private readonly readOnlyState = { readOnly: false };
  private projection = acceptedProjection(EMPTY_MARKDOWN);
  private semanticDocument = this.projection.document;
  private destroyed = false;
  private projecting = false;
  private pendingSlash:
    | {
        readonly nativeFrom: number;
        readonly nativeTo: number;
        readonly emitted: boolean;
      }
    | undefined;

  constructor(private readonly options: MilkdownVisualAdapterOptions = {}) {}

  mount(host: HTMLElement): void {
    if (this.host) {
      throw new Error("MilkdownVisualAdapter is already mounted; call destroy() first.");
    }
    this.host = host;
    this.destroyed = false;
    this.ready = this.createEditor(host);
  }

  setMarkdown(markdown: string): void {
    this.requireMounted();
    const next = acceptedProjection(markdown);
    if (next.canonicalMarkdown === this.projection.canonicalMarkdown) {
      this.projection = next;
      this.semanticDocument = next.document;
      return;
    }
    this.pendingSlash = undefined;
    if (!this.editor) {
      this.projection = next;
      return;
    }
    this.projectToMilkdown(next);
  }

  getMarkdown(): string {
    this.requireMounted();
    const editor = this.editor;
    if (!editor) return this.projection.canonicalMarkdown;
    const markdown = editor.action(getMarkdown());
    const next = acceptedProjection(`${GLYPHQUIRE_FRONTMATTER}${markdown}`);
    this.projection = next;
    this.semanticDocument = next.document;
    return next.canonicalMarkdown;
  }

  getSelection(): WorkbenchEditorSelection {
    const selection = this.requireEditor().action((ctx) => ctx.get(editorViewCtx).state.selection);
    return { anchor: selection.from, head: selection.to };
  }

  setSelection(selection: WorkbenchEditorSelection): void {
    const view = this.requireEditor().action((ctx) => ctx.get(editorViewCtx));
    const max = view.state.doc.content.size;
    const anchor = Math.max(0, Math.min(max, selection.anchor));
    const head = Math.max(0, Math.min(max, selection.head));
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, anchor, head)));
  }

  replaceRange(from: number, to: number, insert: string, cursorOffset = insert.length): boolean {
    if (this.readOnlyState.readOnly) return false;
    const view = this.requireEditor().action((ctx) => ctx.get(editorViewCtx));
    const pending = this.pendingSlash;
    const start = pending?.nativeFrom ?? view.state.selection.from;
    const end = pending?.nativeTo ?? view.state.selection.to;
    const offset = Math.max(0, Math.min(insert.length, cursorOffset));
    const transaction = pending
      ? createVisualBlockTransaction(view.state, start, end, insert)
      : null;
    const nextTransaction = transaction ?? view.state.tr.insertText(insert, start, end);
    const cursor = nextTransaction.mapping.map(start, -1) + (transaction ? 0 : offset);
    nextTransaction.setSelection(
      TextSelection.near(
        nextTransaction.doc.resolve(
          Math.max(0, Math.min(nextTransaction.doc.content.size, cursor)),
        ),
      ),
    );
    this.pendingSlash = undefined;
    view.dispatch(nextTransaction);
    this.publishCurrentProjection();
    return true;
  }

  applyVisualToolbarAction(action: ToolbarAction): boolean {
    if (this.readOnlyState.readOnly) return false;
    const view = this.requireEditor().action((ctx) => ctx.get(editorViewCtx));
    const { state } = view;
    const { from, to, empty } = state.selection;
    const schema = state.schema;
    let transaction = state.tr;

    if (action === "bold" || action === "italic" || action === "link") {
      const markName = action === "bold" ? "strong" : action === "italic" ? "emphasis" : "link";
      const markType = schema.marks[markName];
      if (!markType) return false;
      const attrs = action === "link" ? { href: "https://example.com" } : undefined;
      if (empty) {
        const value = action === "link" ? "link" : "text";
        transaction = transaction.insertText(value, from, to);
        transaction = transaction.addMark(from, from + value.length, markType.create(attrs));
        transaction = transaction.setSelection(
          TextSelection.create(transaction.doc, from, from + value.length),
        );
      } else if (state.doc.rangeHasMark(from, to, markType)) {
        transaction = transaction.removeMark(from, to, markType);
      } else {
        transaction = transaction.addMark(from, to, markType.create(attrs));
      }
      this.pendingSlash = undefined;
      view.dispatch(transaction);
      this.publishCurrentProjection();
      return true;
    }

    if (action === "heading") {
      const heading = schema.nodes.heading;
      if (!heading) return false;
      const command = setBlockType(heading, { level: 2 });
      let dispatched = false;
      const ran = command(state, (next) => {
        dispatched = true;
        view.dispatch(next);
      });
      if (dispatched) this.publishCurrentProjection();
      return Boolean(ran && dispatched);
    }

    const bulletList = schema.nodes.bullet_list;
    if (!bulletList) return false;
    const resolved = state.doc.resolve(from);
    let dispatched = false;
    const inBulletList = resolved.node(resolved.depth - 1)?.type === bulletList;
    let ran = false;
    if (inBulletList) {
      ran = lift(state, (next) => {
        dispatched = true;
        view.dispatch(next);
      });
    } else if (resolved.parent.type.name === "paragraph") {
      ran = wrapIn(bulletList)(state, (next) => {
        dispatched = true;
        view.dispatch(next);
      });
    } else {
      const paragraph = schema.nodes.paragraph;
      if (!paragraph) return false;
      const parentPosition = resolved.before(resolved.depth);
      let transaction = state.tr.setNodeMarkup(parentPosition, paragraph);
      const mappedParentPosition = transaction.mapping.map(parentPosition, -1);
      const range = transaction.doc.resolve(mappedParentPosition + 1).blockRange();
      const wrapping = range ? findWrapping(range, bulletList) : null;
      if (!range || !wrapping) return false;
      transaction = transaction.wrap(range, wrapping);
      dispatched = true;
      view.dispatch(transaction);
      ran = true;
    }
    if (dispatched) this.publishCurrentProjection();
    return Boolean(ran && dispatched);
  }

  onSlashCommand(listenerFn: (request: VisualSlashCommand) => void): () => void {
    this.slashListeners.add(listenerFn);
    return () => this.slashListeners.delete(listenerFn);
  }

  setReadOnly(readOnly: boolean): void {
    const host = this.requireMounted();
    this.readOnlyState.readOnly = readOnly;
    const editor = this.editor;
    if (editor) {
      editor.action((ctx) => {
        const view = ctx.get(editorViewCtx);
        view.setProps({ editable: () => !this.readOnlyState.readOnly });
      });
    }
    setVisualControlsReadOnly(host, readOnly);
  }

  onChange(listenerFn: (markdown: string) => void): () => void {
    this.listeners.add(listenerFn);
    return () => this.listeners.delete(listenerFn);
  }

  focus(): void {
    this.requireEditor().action((ctx) => ctx.get(editorViewCtx).focus());
  }

  destroy(): void {
    const host = this.host;
    if (!host) return;
    this.destroyed = true;
    const editor = this.editor;
    this.editor = undefined;
    this.host = undefined;
    this.listeners.clear();
    this.slashListeners.clear();
    this.pendingSlash = undefined;
    if (editor) void editor.destroy().catch(() => undefined);
    host.replaceChildren();
  }

  /** Resolves after Milkdown has created its private ProseMirror view. */
  async whenReady(): Promise<void> {
    await this.ready;
  }

  /** Contract probe: the actual ProseMirror content expression decides. */
  canContainForTests(parent: "tabs" | "columns", child: "tab" | "column" | "paragraph"): boolean {
    return this.requireEditor().action((ctx) => {
      const schema = ctx.get(schemaCtx);
      const parentType = schema.nodes[parent === "tabs" ? "gq_tabs" : "gq_columns"];
      const childName = child === "tab" ? "gq_tab" : child === "column" ? "gq_column" : child;
      const childType = schema.nodes[childName];
      return Boolean(parentType && childType && parentType.contentMatch.matchType(childType));
    });
  }

  private async createEditor(host: HTMLElement): Promise<void> {
    const initialProjection = this.projection;
    this.semanticDocument = initialProjection.document;
    const readOnlyGuard = $prose(
      () =>
        new Plugin({
          filterTransaction: (transaction) =>
            !(this.readOnlyState.readOnly && transaction.docChanged),
        }),
    );
    const slashDetector = $prose(
      () =>
        new Plugin({
          appendTransaction: (transactions, oldState, newState) => {
            if (this.projecting || this.readOnlyState.readOnly || this.destroyed) return null;
            const insertion = findSlashInsertion(transactions, oldState, newState);
            if (!insertion) return null;
            this.pendingSlash = { ...insertion, emitted: false };
            return null;
          },
        }),
    );
    const semanticPlugins = createDirectiveRemarkPlugins(() => this.semanticDocument);
    const commonmarkWithoutRawHtmlWrapping = commonmark.filter(
      (plugin) => !remarkHtmlTransformer.includes(plugin),
    );

    const editor = Editor.make()
      .config((ctx) => {
        ctx.set(rootCtx, host);
        ctx.set(rootAttrsCtx, {
          "aria-label": "Visual Markdown editor",
          "data-glyphquire-editor": "visual",
        });
        ctx.set(defaultValueCtx, bodyMarkdown(initialProjection.canonicalMarkdown));
        ctx.set(editorViewOptionsCtx, {
          editable: () => !this.readOnlyState.readOnly,
        });
        ctx.get(listenerCtx).markdownUpdated((_ctx, markdown) => {
          this.onMilkdownMarkdownChanged(markdown);
        });
      })
      .use(commonmarkWithoutRawHtmlWrapping)
      .use(gfm)
      .use(semanticPlugins)
      .use(safeLinkSchema)
      .use(createSafeImageSchema(this.options.assetResolver ?? getActiveVisualAssetResolver()))
      .use(safeHtmlSchema)
      .use(visualCalloutPlugins)
      .use(visualStickyPlugins)
      .use(visualTogglePlugins)
      .use(visualTabsPlugins)
      .use(visualColumnsPlugins)
      .use(visualRuntimePlugins)
      .use(visualWarningPlugins)
      .use(readOnlyGuard)
      .use(slashDetector)
      .use(history)
      .use(listener);

    await editor.create();
    if (this.destroyed || this.host !== host) {
      await editor.destroy();
      return;
    }
    this.editor = editor;
    this.projectToMilkdown(this.projection);
    setVisualControlsReadOnly(host, this.readOnlyState.readOnly);
  }

  private projectToMilkdown(projection: AcceptedProjection): void {
    const editor = this.requireEditor();
    const previousSemanticDocument = this.semanticDocument;
    this.projecting = true;
    this.semanticDocument = projection.document;
    try {
      editor.action(replaceAll(bodyMarkdown(projection.canonicalMarkdown), true));
      const projected = acceptedProjection(
        `${GLYPHQUIRE_FRONTMATTER}${editor.action(getMarkdown())}`,
      );
      this.projection = projected;
      this.semanticDocument = projected.document;
      setVisualControlsReadOnly(this.requireMounted(), this.readOnlyState.readOnly);
    } catch (error) {
      this.semanticDocument = previousSemanticDocument;
      throw error;
    } finally {
      this.projecting = false;
    }
  }

  private onMilkdownMarkdownChanged(markdown: string): void {
    if (this.destroyed || this.projecting || this.readOnlyState.readOnly) return;
    const next = acceptedProjection(`${GLYPHQUIRE_FRONTMATTER}${markdown}`);
    if (next.canonicalMarkdown === this.projection.canonicalMarkdown) {
      const slash = this.pendingSlash;
      if (slash && !slash.emitted) {
        const slashIndex = next.canonicalMarkdown.indexOf("/");
        if (slashIndex !== -1) {
          this.pendingSlash = { ...slash, emitted: true };
          const request = {
            query: "",
            slashRange: { from: slashIndex, to: slashIndex + 1 },
          };
          for (const listenerFn of this.slashListeners) listenerFn(request);
        }
      }
      return;
    }
    const previousMarkdown = this.projection.canonicalMarkdown;
    const slash = this.pendingSlash;
    if (slash?.emitted) this.pendingSlash = undefined;
    this.projection = next;
    this.semanticDocument = next.document;
    for (const listenerFn of this.listeners) listenerFn(next.canonicalMarkdown);
    if (slash && !slash.emitted) {
      const slashIndex = insertedSlashIndex(previousMarkdown, next.canonicalMarkdown);
      if (slashIndex !== null) {
        this.pendingSlash = { ...slash, emitted: true };
        const request = {
          query: "",
          slashRange: { from: slashIndex, to: slashIndex + 1 },
        };
        for (const listenerFn of this.slashListeners) listenerFn(request);
      }
    }
  }

  private publishCurrentProjection(): void {
    const editor = this.requireEditor();
    this.onMilkdownMarkdownChanged(editor.action(getMarkdown()));
  }

  private requireMounted(): HTMLElement {
    if (!this.host || this.destroyed) throw new Error("MilkdownVisualAdapter is not mounted");
    return this.host;
  }

  private requireEditor(): Editor {
    this.requireMounted();
    if (!this.editor) throw new Error("MilkdownVisualAdapter is not ready");
    return this.editor;
  }
}

function createVisualBlockTransaction(
  state: ProseMirrorEditorState,
  from: number,
  to: number,
  insert: string,
): Transaction | null {
  const kind =
    insert === "## "
      ? "heading"
      : insert === "- "
        ? "bullet_list"
        : insert === "> "
          ? "blockquote"
          : insert === ["```", "", "```"].join(String.fromCharCode(10))
            ? "codeBlock"
            : null;
  if (!kind) return null;

  const resolved = state.doc.resolve(from);
  if (resolved.parent.type.name !== "paragraph") return null;
  const parentPosition = resolved.before(resolved.depth);
  let transaction = state.tr.delete(from, to);
  const mappedParentPosition = transaction.mapping.map(parentPosition, -1);
  const parentAfterDelete = transaction.doc.resolve(mappedParentPosition + 1).parent;
  if (kind === "heading" || kind === "codeBlock") {
    const nodeType = state.schema.nodes[kind === "heading" ? "heading" : "code_block"];
    if (!nodeType) return null;
    transaction = transaction.setNodeMarkup(
      mappedParentPosition,
      nodeType,
      kind === "heading" ? { ...parentAfterDelete.attrs, level: 2 } : undefined,
    );
    return transaction;
  }

  const ancestor = resolved.node(resolved.depth - 1);
  if (kind === "bullet_list" && ancestor?.type.name === "list_item") return transaction;
  const nodeType = state.schema.nodes[kind];
  if (!nodeType) return null;
  const range = transaction.doc.resolve(mappedParentPosition + 1).blockRange();
  if (!range) return null;
  const wrapping = findWrapping(range, nodeType);
  if (!wrapping) return null;
  return transaction.wrap(range, wrapping);
}

function findSlashInsertion(
  transactions: readonly Transaction[],
  oldState: ProseMirrorEditorState,
  state: ProseMirrorEditorState,
): { nativeFrom: number; nativeTo: number } | null {
  let insertion: { nativeFrom: number; nativeTo: number } | undefined;
  for (const transaction of transactions) {
    if (!transaction.docChanged) continue;
    transaction.mapping.maps.forEach((map) => {
      map.forEach((oldFrom, oldTo, newFrom, newTo) => {
        if (oldFrom !== oldTo || newTo !== newFrom + 1 || insertion) return;
        if (state.doc.textBetween(newFrom, newTo, "\n", "\n") !== "/") return;
        insertion = { nativeFrom: newFrom, nativeTo: newTo };
      });
    });
  }
  if (!insertion || !state.selection.empty || state.selection.from !== insertion.nativeTo) {
    return null;
  }
  const oldResolved = oldState.doc.resolve(insertion.nativeFrom);
  if (oldResolved.parent.type.name !== "paragraph" || oldResolved.parent.textContent.length > 0) {
    return null;
  }
  const resolved = state.doc.resolve(insertion.nativeTo);
  const parent = resolved.parent;
  if (parent.type.name !== "paragraph" || parent.type.name === "code_block") return null;
  const beforeSlash = parent.textBetween(0, Math.max(0, resolved.parentOffset - 1), "\n", "\n");
  return beforeSlash.length === 0 ? insertion : null;
}

function insertedSlashIndex(before: string, after: string): number | null {
  let prefix = 0;
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) {
    prefix += 1;
  }
  const candidate = after.indexOf("/", prefix);
  return candidate === -1 ? null : candidate;
}
