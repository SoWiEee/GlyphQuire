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
import { Plugin } from "@milkdown/kit/prose/state";
import { $prose, getMarkdown, replaceAll } from "@milkdown/kit/utils";
import type { EditorAdapter } from "../types.js";
import { visualCalloutPlugins } from "./nodes/callout.js";
import { visualColumnsPlugins } from "./nodes/columns.js";
import { visualRuntimePlugins } from "./nodes/runtime.js";
import { visualStickyPlugins } from "./nodes/sticky.js";
import { visualTabsPlugins } from "./nodes/tabs.js";
import { visualTogglePlugins } from "./nodes/toggle.js";
import { visualWarningPlugins } from "./nodes/unknown.js";
import {
  GLYPHQUIRE_FRONTMATTER,
  createDirectiveRemarkPlugins,
  safeHtmlSchema,
  safeImageSchema,
  safeLinkSchema,
  setVisualControlsReadOnly,
} from "./schema.js";

const engine = createDocumentEngine();
const EMPTY_MARKDOWN = `${GLYPHQUIRE_FRONTMATTER}`;
const UTF8_ENCODER = new TextEncoder();

interface AcceptedProjection {
  readonly canonicalMarkdown: string;
  readonly document: NotebookDocument;
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
  private readonly readOnlyState = { readOnly: false };
  private projection = acceptedProjection(EMPTY_MARKDOWN);
  private semanticDocument = this.projection.document;
  private destroyed = false;
  private projecting = false;

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
      .use(safeImageSchema)
      .use(safeHtmlSchema)
      .use(visualCalloutPlugins)
      .use(visualStickyPlugins)
      .use(visualTogglePlugins)
      .use(visualTabsPlugins)
      .use(visualColumnsPlugins)
      .use(visualRuntimePlugins)
      .use(visualWarningPlugins)
      .use(readOnlyGuard)
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
    if (next.canonicalMarkdown === this.projection.canonicalMarkdown) return;
    this.projection = next;
    this.semanticDocument = next.document;
    for (const listenerFn of this.listeners) listenerFn(next.canonicalMarkdown);
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
