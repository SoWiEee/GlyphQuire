import type { MilkdownPlugin } from "@milkdown/kit/ctx";
import type { Node as ProseNode } from "@milkdown/kit/prose/model";
import { Plugin } from "@milkdown/kit/prose/state";
import type { NodeViewConstructor } from "@milkdown/kit/prose/view";
import { $nodeSchema, $prose, $view } from "@milkdown/kit/utils";
import {
  addInlineDirectiveToMarkdown,
  addSemanticNodeToMarkdown,
  annotatedVisualKind,
  assertVisualBlockWarningAttrs,
  assertVisualInlineWarningAttrs,
  blockWarningAttrsFromSource,
  inlineWarningAttrsFromSource,
  readAnnotatedInlineDirective,
  readAnnotatedSemantic,
  semanticNodeSource,
  validateVisualBlockWarningJson,
  validateVisualBlockWarningSource,
  validateVisualInlineWarningJson,
  validateVisualInlineWarningSource,
  validateVisualWarningLabel,
} from "../schema.js";

function markerSource(
  value: HTMLElement | string,
  attribute: "data-glyphquire-inline-warning" | "data-glyphquire-warning",
): string | null {
  if (!(value instanceof globalThis.HTMLElement)) return null;
  if (value.getAttribute(attribute) !== "escaped") return null;
  if (value.childNodes.length !== 1 || value.firstChild?.nodeType !== globalThis.Node.TEXT_NODE) {
    return null;
  }
  return value.firstChild.nodeValue ?? null;
}

function warningDom(tagName: "span" | "section", attribute: string, source: string): HTMLElement {
  const dom = document.createElement(tagName);
  dom.setAttribute(attribute, "escaped");
  dom.append(document.createTextNode(source));
  return dom;
}

export const visualInlineWarningSchema = $nodeSchema("gq_inline_warning", () => ({
  inline: true,
  atom: true,
  group: "inline",
  isolating: true,
  selectable: true,
  attrs: {
    directiveJson: { validate: validateVisualInlineWarningJson },
    source: { validate: validateVisualInlineWarningSource },
  },
  leafText: (node) => assertVisualInlineWarningAttrs(node.attrs).source,
  parseDOM: [
    {
      tag: 'span[data-glyphquire-inline-warning="escaped"]',
      getAttrs: (dom) => {
        const source = markerSource(dom, "data-glyphquire-inline-warning");
        return source === null ? false : (inlineWarningAttrsFromSource(source) ?? false);
      },
    },
  ],
  toDOM: (node) => {
    const attrs = assertVisualInlineWarningAttrs(node.attrs);
    return warningDom("span", "data-glyphquire-inline-warning", attrs.source);
  },
  parseMarkdown: {
    match: (node) => annotatedVisualKind(node) === "inline-warning",
    runner: (state, markdownNode, type) => {
      const inline = readAnnotatedInlineDirective(markdownNode);
      const attrs = assertVisualInlineWarningAttrs({
        directiveJson: JSON.stringify(inline.node),
        source: inline.source,
      });
      state.addNode(type, attrs);
    },
  },
  toMarkdown: {
    match: (node) => node.type.name === "gq_inline_warning",
    runner: (state, node) => {
      const attrs = assertVisualInlineWarningAttrs(node.attrs);
      addInlineDirectiveToMarkdown(state, attrs.directiveJson);
    },
  },
}));

export const visualWarningSchema = $nodeSchema("gq_warning", () => ({
  atom: true,
  group: "block",
  isolating: true,
  selectable: true,
  attrs: {
    semanticJson: { validate: validateVisualBlockWarningJson },
    source: { validate: validateVisualBlockWarningSource },
    label: { validate: validateVisualWarningLabel },
  },
  leafText: (node) => assertVisualBlockWarningAttrs(node.attrs).source,
  parseDOM: [
    {
      tag: 'section[data-glyphquire-warning="escaped"]',
      getAttrs: (dom) => {
        const source = markerSource(dom, "data-glyphquire-warning");
        return source === null ? false : (blockWarningAttrsFromSource(source) ?? false);
      },
    },
  ],
  toDOM: (node) => {
    const attrs = assertVisualBlockWarningAttrs(node.attrs);
    return warningDom("section", "data-glyphquire-warning", attrs.source);
  },
  parseMarkdown: {
    match: (node) => annotatedVisualKind(node) === "warning",
    runner: (state, markdownNode, type) => {
      const semantic = readAnnotatedSemantic(markdownNode);
      const source = semanticNodeSource(semantic);
      const attrs = blockWarningAttrsFromSource(source);
      if (attrs === null) throw new Error("Visual warning source is not canonical");
      state.addNode(type, attrs);
    },
  },
  toMarkdown: {
    match: (node) => node.type.name === "gq_warning",
    runner: (state, node) => {
      const attrs = assertVisualBlockWarningAttrs(node.attrs);
      addSemanticNodeToMarkdown(state, attrs.semantic);
    },
  },
}));

function warningNodeView(): NodeViewConstructor {
  return (initialNode) => {
    let currentNode = initialNode;
    assertVisualBlockWarningAttrs(currentNode.attrs);
    const dom = document.createElement("section");
    dom.dataset.glyphquireWarning = "escaped";
    dom.contentEditable = "false";
    const label = document.createElement("strong");
    const pre = document.createElement("pre");
    const code = document.createElement("code");
    pre.append(code);
    dom.append(label, pre);

    const sync = (): void => {
      const attrs = assertVisualBlockWarningAttrs(currentNode.attrs);
      label.textContent = attrs.label;
      code.textContent = attrs.source;
    };
    sync();

    return {
      dom,
      update(nextNode: ProseNode): boolean {
        if (nextNode.type !== currentNode.type) return false;
        currentNode = nextNode;
        sync();
        return true;
      },
      stopEvent: () => true,
      ignoreMutation: () => true,
    };
  };
}

function inlineWarningNodeView(): NodeViewConstructor {
  return (initialNode) => {
    let currentNode = initialNode;
    assertVisualInlineWarningAttrs(currentNode.attrs);
    const dom = document.createElement("span");
    dom.dataset.glyphquireInlineWarning = "escaped";
    dom.contentEditable = "false";
    dom.setAttribute("role", "note");

    const sync = (): void => {
      dom.textContent = assertVisualInlineWarningAttrs(currentNode.attrs).source;
    };
    sync();

    return {
      dom,
      update(nextNode: ProseNode): boolean {
        if (nextNode.type !== currentNode.type) return false;
        currentNode = nextNode;
        sync();
        return true;
      },
      stopEvent: () => true,
      ignoreMutation: () => true,
    };
  };
}

const visualWarningView = $view(visualWarningSchema.node, () => warningNodeView());
const visualInlineWarningView = $view(visualInlineWarningSchema.node, () =>
  inlineWarningNodeView(),
);

const visualWarningIntegrity = $prose(() => {
  const validatedNodes = new WeakMap<
    ProseNode,
    readonly [unknown, unknown] | readonly [unknown, unknown, unknown]
  >();
  return new Plugin({
    filterTransaction: (transaction) => {
      if (!transaction.docChanged) return true;
      let valid = true;
      transaction.doc.descendants((node) => {
        if (!valid) return false;
        try {
          if (node.type.name === "gq_inline_warning") {
            const cached = validatedNodes.get(node);
            if (
              cached?.length === 2 &&
              cached[0] === node.attrs.directiveJson &&
              cached[1] === node.attrs.source
            ) {
              return false;
            }
            assertVisualInlineWarningAttrs(node.attrs);
            validatedNodes.set(node, [node.attrs.directiveJson, node.attrs.source]);
          } else if (node.type.name === "gq_warning") {
            const cached = validatedNodes.get(node);
            if (
              cached?.length === 3 &&
              cached[0] === node.attrs.semanticJson &&
              cached[1] === node.attrs.source &&
              cached[2] === node.attrs.label
            ) {
              return false;
            }
            assertVisualBlockWarningAttrs(node.attrs);
            validatedNodes.set(node, [
              node.attrs.semanticJson,
              node.attrs.source,
              node.attrs.label,
            ]);
          }
        } catch {
          valid = false;
          return false;
        }
        return true;
      });
      return valid;
    },
  });
});

export const visualWarningPlugins: MilkdownPlugin[] = [
  ...visualWarningSchema,
  ...visualInlineWarningSchema,
  visualWarningView,
  visualInlineWarningView,
  visualWarningIntegrity,
];
