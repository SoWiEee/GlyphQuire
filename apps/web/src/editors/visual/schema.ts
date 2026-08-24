import {
  createDocumentEngine,
  createRegistry,
  documentToMdast,
  semanticNormalize,
  type BlockNode,
  type NotebookDocument,
} from "@glyphquire/document-engine";
import { htmlSchema, imageSchema, linkSchema } from "@milkdown/kit/preset/commonmark";
import type { MilkdownPlugin } from "@milkdown/kit/ctx";
import type { Fragment, Node as ProseNode } from "@milkdown/kit/prose/model";
import type { NodeViewConstructor } from "@milkdown/kit/prose/view";
import type {
  JSONRecord,
  MarkdownNode,
  RemarkPluginRaw,
  SerializerState,
} from "@milkdown/kit/transformer";
import { $remark } from "@milkdown/kit/utils";
import remarkDirective from "remark-directive";

const engine = createDocumentEngine();
const registry = createRegistry();

export const GLYPHQUIRE_FRONTMATTER = "---\nglyphquire-spec: 1\n---\n\n";
const SEMANTIC_DATA_KEY = "glyphquireSemanticJson";
const VISUAL_KIND_DATA_KEY = "glyphquireVisualKind";
const MAX_ENCODED_URL_PASSES = 3;

export type VisualUrlKind = "link" | "image";

export interface ResolvedVisualUrl {
  readonly href: string;
  readonly external: boolean;
  readonly rel?: "noopener noreferrer";
  readonly target?: "_blank";
}

function hasForbiddenUrlCodePoint(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (
      code <= 0x1f ||
      (code >= 0x7f && code <= 0xa0) ||
      (code >= 0x200b && code <= 0x200d) ||
      code === 0x2028 ||
      code === 0x2029 ||
      code === 0xfeff
    ) {
      return true;
    }
  }
  return false;
}

function decodedUrlCandidates(value: string): string[] | null {
  const candidates = [value];
  let current = value;
  for (let pass = 0; pass < MAX_ENCODED_URL_PASSES; pass += 1) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(current);
    } catch {
      return null;
    }
    if (decoded === current) break;
    candidates.push(decoded);
    current = decoded;
  }
  return candidates;
}

function schemeOf(value: string): string | null {
  return /^([a-z][a-z0-9+.-]*):/i.exec(value)?.[1]?.toLowerCase() ?? null;
}

/**
 * The only policy allowed to turn note-controlled URLs into live DOM sinks.
 * It deliberately rejects ambiguous encodings instead of trying to repair
 * them into a different URL than the Markdown contains.
 */
export function resolveVisualUrl(
  raw: unknown,
  kind: VisualUrlKind,
  baseUrl = globalThis.location?.href ?? "https://glyphquire.invalid/",
): ResolvedVisualUrl | null {
  if (typeof raw !== "string" || raw.length === 0 || raw !== raw.trim()) return null;
  const candidates = decodedUrlCandidates(raw);
  if (!candidates) return null;

  const allowedSchemes =
    kind === "image" ? new Set(["http", "https"]) : new Set(["http", "https", "mailto", "tel"]);
  const rawScheme = schemeOf(raw);

  for (const [index, candidate] of candidates.entries()) {
    if (
      hasForbiddenUrlCodePoint(candidate) ||
      candidate.includes("\\") ||
      candidate.startsWith("//")
    ) {
      return null;
    }
    const candidateScheme = schemeOf(candidate);
    if (index > 0 && candidateScheme !== rawScheme) return null;
    if (candidateScheme !== null && !allowedSchemes.has(candidateScheme)) return null;
  }

  let parsed: URL;
  let base: URL;
  try {
    base = new URL(baseUrl);
    parsed = new URL(raw, base);
  } catch {
    return null;
  }

  if (parsed.username !== "" || parsed.password !== "") return null;
  if (rawScheme !== null && !allowedSchemes.has(rawScheme)) return null;
  if (kind === "image" && parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return null;
  }

  const external = rawScheme !== null && parsed.origin !== base.origin;
  if (kind === "link" && external) {
    return { href: raw, external: true, rel: "noopener noreferrer", target: "_blank" };
  }
  return { href: raw, external };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasSemanticAnnotation(node: MarkdownNode): boolean {
  return isRecord(node.data) && typeof node.data[SEMANTIC_DATA_KEY] === "string";
}

export function annotatedVisualKind(node: MarkdownNode): string | null {
  return isRecord(node.data) && typeof node.data[VISUAL_KIND_DATA_KEY] === "string"
    ? node.data[VISUAL_KIND_DATA_KEY]
    : null;
}

function canonicalSemanticBlock(value: unknown): BlockNode {
  if (!isRecord(value) || typeof value.type !== "string") {
    throw new Error("Visual semantic node is malformed");
  }

  const candidate: NotebookDocument = {
    type: "document",
    specVersion: 1,
    children: [value as unknown as BlockNode],
  };
  let serialized: string;
  try {
    serialized = engine.serialize(candidate);
  } catch {
    throw new Error("Visual semantic node cannot be serialized safely");
  }
  const reparsed = engine.parse(serialized);
  if (!reparsed.ok || reparsed.document.children.length !== 1) {
    throw new Error("Visual semantic node cannot be reparsed safely");
  }
  if (
    JSON.stringify(semanticNormalize(reparsed.document)) !==
    JSON.stringify(semanticNormalize(candidate))
  ) {
    throw new Error("Visual semantic node changed across the document boundary");
  }
  return reparsed.document.children[0]!;
}

export function semanticBlockFromJson(raw: string): BlockNode {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("Milkdown semantic annotation is not valid JSON");
  }
  return canonicalSemanticBlock(parsed);
}

export function readAnnotatedSemantic(node: MarkdownNode): BlockNode {
  const data = isRecord(node.data) ? node.data : null;
  const raw = data?.[SEMANTIC_DATA_KEY];
  if (typeof raw !== "string") throw new Error("Milkdown node lacks a semantic annotation");
  return semanticBlockFromJson(raw);
}

function blockChildren(node: BlockNode): readonly BlockNode[] {
  switch (node.type) {
    case "quote":
    case "listItem":
    case "callout":
    case "sticky":
    case "toggle":
    case "tabs":
    case "tab":
    case "columns":
    case "column":
    case "unknown-directive":
    case "invalid-block":
    case "footnoteDefinition":
      return node.children;
    case "list":
      return node.children;
    default:
      return [];
  }
}

function isSemanticBoundary(node: BlockNode): boolean {
  return [
    "callout",
    "sticky",
    "toggle",
    "tabs",
    "tab",
    "columns",
    "column",
    "runtime",
    "unknown-directive",
    "invalid-block",
  ].includes(node.type);
}

interface SemanticBoundary {
  readonly node: BlockNode;
  readonly visualKind: string;
}

function semanticBoundaries(document: NotebookDocument): SemanticBoundary[] {
  const result: SemanticBoundary[] = [];
  const visit = (node: BlockNode, parent: BlockNode | null): void => {
    if (isSemanticBoundary(node)) {
      const structuralOrphan =
        (node.type === "tab" && parent?.type !== "tabs") ||
        (node.type === "column" && parent?.type !== "columns");
      result.push({ node, visualKind: structuralOrphan ? "warning" : visualKind(node) });
    }
    for (const child of blockChildren(node)) visit(child, node);
  };
  for (const child of document.children) visit(child, null);
  return result;
}

function semanticDirectiveName(node: BlockNode): string | null {
  switch (node.type) {
    case "runtime":
      return node.runtime;
    case "unknown-directive":
      return node.name;
    case "invalid-block":
      return node.originalType === "html" ? null : node.originalType;
    case "callout":
    case "sticky":
    case "toggle":
    case "tabs":
    case "tab":
    case "columns":
    case "column":
      return node.type;
    default:
      return null;
  }
}

function visualKind(node: BlockNode): string {
  if (node.type === "runtime") return node.runtime;
  if (node.type === "unknown-directive" || node.type === "invalid-block") return "warning";
  return node.type;
}

function isMarkdownNode(value: unknown): value is MarkdownNode {
  return isRecord(value) && typeof value.type === "string";
}

function annotateMarkdownTree(tree: MarkdownNode, document: NotebookDocument): void {
  const boundaries = semanticBoundaries(document);
  let boundaryIndex = 0;

  const visit = (node: MarkdownNode): void => {
    const isDirective =
      node.type === "containerDirective" ||
      node.type === "leafDirective" ||
      node.type === "textDirective";
    const isHtmlBoundary = node.type === "html";

    if (isDirective || isHtmlBoundary) {
      const boundary = boundaries[boundaryIndex];
      if (!boundary) {
        if (isHtmlBoundary) return;
        throw new Error("Milkdown found an unpaired semantic boundary");
      }
      const semantic = boundary.node;
      const expectedName = semanticDirectiveName(semantic);
      const markdownName = typeof node.name === "string" ? node.name : null;
      const matches = isHtmlBoundary
        ? semantic.type === "invalid-block" &&
          semantic.originalType === "html" &&
          semantic.source === node.value
        : expectedName === markdownName;
      // Inline HTML stays inside ordinary paragraph phrasing content in the
      // Document Engine; it is escaped by safeHtmlSchema but is not a block
      // boundary and therefore must not consume the next block annotation.
      if (isHtmlBoundary && !matches) return;
      if (!matches) {
        throw new Error(
          `Milkdown semantic boundary order does not match Markdown (${String(expectedName)} != ${String(markdownName ?? node.type)})`,
        );
      }

      const data = isRecord(node.data) ? { ...node.data } : {};
      data[SEMANTIC_DATA_KEY] = JSON.stringify(semantic);
      data[VISUAL_KIND_DATA_KEY] = boundary.visualKind;
      node.data = data;
      boundaryIndex += 1;
    }

    if (Array.isArray(node.children)) {
      for (const child of node.children) if (isMarkdownNode(child)) visit(child);
    }
  };

  visit(tree);
  if (boundaryIndex !== boundaries.length) {
    throw new Error("Milkdown did not retain every semantic boundary");
  }
}

/** Adds directive parsing plus a fail-closed semantic annotation pass. */
export function createDirectiveRemarkPlugins(
  currentDocument: () => NotebookDocument,
): MilkdownPlugin[] {
  const directive = $remark("glyphquireDirective", () => remarkDirective);
  const annotationFactory: RemarkPluginRaw<Record<string, never>> = () => (tree) => {
    if (!isMarkdownNode(tree)) throw new Error("Milkdown produced a malformed Markdown tree");
    annotateMarkdownTree(tree, currentDocument());
  };
  const annotation = $remark(
    "glyphquireSemanticAnnotation",
    () => annotationFactory,
    Object.freeze({}),
  );
  return [...directive, ...annotation];
}

function markdownProps(node: MarkdownNode): JSONRecord {
  const props: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) {
    if (["type", "children", "value", "position"].includes(key) || value === undefined) continue;
    props[key] = value;
  }
  return props as JSONRecord;
}

function semanticMarkdownNode(node: BlockNode): MarkdownNode {
  const document: NotebookDocument = { type: "document", specVersion: 1, children: [node] };
  const mdast = documentToMdast(document, registry).children[1];
  if (!mdast || !isMarkdownNode(mdast)) {
    throw new Error("Document Engine did not produce a visual Markdown node");
  }
  return mdast;
}

/** Delegates opaque-boundary serialization to the Document Engine registry. */
export function addSemanticNodeToMarkdown(state: SerializerState, node: BlockNode): void {
  const markdownNode = semanticMarkdownNode(node);
  state.addNode(
    markdownNode.type,
    Array.isArray(markdownNode.children) ? markdownNode.children : undefined,
    typeof markdownNode.value === "string" ? markdownNode.value : undefined,
    markdownProps(markdownNode),
  );
}

/** Delegates directive identity/attributes while retaining editable ProseMirror children. */
export function addSemanticContainerToMarkdown(
  state: SerializerState,
  node: BlockNode,
  content: Fragment,
): void {
  const markdownNode = semanticMarkdownNode(node);
  state.openNode(
    markdownNode.type,
    typeof markdownNode.value === "string" ? markdownNode.value : undefined,
    markdownProps(markdownNode),
  );
  state.next(content).closeNode();
}

export function semanticNodeSource(node: BlockNode): string {
  const markdown = engine.serialize({ type: "document", specVersion: 1, children: [node] });
  if (!markdown.startsWith(GLYPHQUIRE_FRONTMATTER)) {
    throw new Error("Document Engine returned a non-canonical visual fragment");
  }
  return markdown.slice(GLYPHQUIRE_FRONTMATTER.length);
}

export const safeLinkSchema = linkSchema.extendSchema((previous) => (ctx) => {
  const base = previous(ctx);
  return {
    ...base,
    toDOM: (mark) => {
      const resolved = resolveVisualUrl(mark.attrs.href, "link");
      const attributes: Record<string, string> = {};
      if (resolved) {
        attributes.href = resolved.href;
        if (resolved.rel) attributes.rel = resolved.rel;
        if (resolved.target) attributes.target = resolved.target;
      }
      if (typeof mark.attrs.title === "string") attributes.title = mark.attrs.title;
      return ["a", attributes, 0];
    },
  };
});

export const safeImageSchema = imageSchema.extendSchema((previous) => (ctx) => {
  const base = previous(ctx);
  return {
    ...base,
    toDOM: (node) => {
      const resolved = resolveVisualUrl(node.attrs.src, "image");
      const attributes: Record<string, string> = {
        alt: typeof node.attrs.alt === "string" ? node.attrs.alt : "",
      };
      if (resolved) attributes.src = resolved.href;
      if (typeof node.attrs.title === "string" && node.attrs.title !== "") {
        attributes.title = node.attrs.title;
      }
      return ["img", attributes];
    },
  };
});

export const safeHtmlSchema = htmlSchema.extendSchema((previous) => (ctx) => {
  const base = previous(ctx);
  return {
    ...base,
    parseMarkdown: {
      ...base.parseMarkdown,
      match: (node) => base.parseMarkdown.match(node) && !hasSemanticAnnotation(node),
    },
    toDOM: (node) => {
      const warning = document.createElement("span");
      warning.dataset.glyphquireWarning = "raw-html";
      warning.textContent = typeof node.attrs.value === "string" ? node.attrs.value : "";
      return warning;
    },
  };
});

export interface VisualControlSpec {
  readonly attribute: string;
  readonly label: string;
  readonly type: "text" | "checkbox" | "select";
  readonly options?: readonly string[];
  readonly dataAttribute?: string;
}

function controlValue(control: HTMLInputElement | HTMLSelectElement): string | boolean {
  return control instanceof HTMLInputElement && control.type === "checkbox"
    ? control.checked
    : control.value;
}

function syncControl(control: HTMLInputElement | HTMLSelectElement, value: unknown): void {
  if (control instanceof HTMLInputElement && control.type === "checkbox") {
    control.checked = value === true;
    return;
  }
  const next = typeof value === "string" ? value : "";
  control.value = next;
  if (control instanceof HTMLInputElement) control.setAttribute("value", next);
}

/** DOM-only editable container node view; note content never becomes markup. */
export function createContainerNodeView(
  nodeType: string,
  controls: readonly VisualControlSpec[],
): NodeViewConstructor {
  return (initialNode, view, getPos) => {
    let currentNode = initialNode;
    const dom = document.createElement("section");
    dom.dataset.glyphquireNode = nodeType;
    const header = document.createElement("header");
    header.contentEditable = "false";
    const heading = document.createElement("strong");
    heading.append(document.createTextNode(nodeType));
    header.append(heading);

    const renderedControls: Array<{
      spec: VisualControlSpec;
      control: HTMLInputElement | HTMLSelectElement;
    }> = [];
    for (const spec of controls) {
      const label = document.createElement("label");
      label.append(document.createTextNode(spec.label));
      let control: HTMLInputElement | HTMLSelectElement;
      if (spec.type === "select") {
        const select = document.createElement("select");
        for (const value of spec.options ?? []) {
          const option = document.createElement("option");
          option.value = value;
          option.append(document.createTextNode(value));
          select.append(option);
        }
        control = select;
      } else {
        const input = document.createElement("input");
        input.type = spec.type;
        control = input;
      }
      control.dataset.glyphquireControl = spec.attribute;
      if (spec.dataAttribute) control.setAttribute(spec.dataAttribute, "");
      syncControl(control, currentNode.attrs[spec.attribute]);
      control.addEventListener("change", () => {
        if (!view.editable) {
          syncControl(control, currentNode.attrs[spec.attribute]);
          return;
        }
        const position = getPos();
        if (position === undefined) return;
        view.dispatch(
          view.state.tr.setNodeMarkup(position, undefined, {
            ...currentNode.attrs,
            [spec.attribute]: controlValue(control),
          }),
        );
      });
      label.append(control);
      header.append(label);
      renderedControls.push({ spec, control });
    }

    const contentDOM = document.createElement("div");
    contentDOM.dataset.glyphquireContent = nodeType;
    dom.append(header, contentDOM);

    return {
      dom,
      contentDOM,
      update(nextNode: ProseNode): boolean {
        if (nextNode.type !== currentNode.type) return false;
        currentNode = nextNode;
        for (const item of renderedControls) {
          syncControl(item.control, currentNode.attrs[item.spec.attribute]);
        }
        return true;
      },
      stopEvent: (event) =>
        event.target instanceof globalThis.Node && header.contains(event.target),
      ignoreMutation: (mutation) => header.contains(mutation.target),
    };
  };
}

export function setVisualControlsReadOnly(host: HTMLElement, readOnly: boolean): void {
  for (const control of host.querySelectorAll<
    HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement
  >("[data-glyphquire-control]")) {
    control.disabled = readOnly;
  }
}
