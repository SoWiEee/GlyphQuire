import type { MilkdownPlugin } from "@milkdown/kit/ctx";
import type { Node as ProseNode } from "@milkdown/kit/prose/model";
import type { NodeViewConstructor } from "@milkdown/kit/prose/view";
import { $nodeSchema, $view } from "@milkdown/kit/utils";
import {
  addSemanticNodeToMarkdown,
  annotatedVisualKind,
  readAnnotatedSemantic,
  semanticBlockFromJson,
  semanticNodeSource,
} from "../schema.js";

export const visualWarningSchema = $nodeSchema("gq_warning", () => ({
  atom: true,
  group: "block",
  isolating: true,
  selectable: true,
  attrs: {
    semanticJson: { default: "", validate: "string" },
    source: { default: "", validate: "string" },
    label: { default: "Unsupported block", validate: "string" },
  },
  parseDOM: [{ tag: "section[data-glyphquire-warning]" }],
  toDOM: () => ["section", { "data-glyphquire-warning": "escaped" }],
  parseMarkdown: {
    match: (node) => annotatedVisualKind(node) === "warning",
    runner: (state, markdownNode, type) => {
      const semantic = readAnnotatedSemantic(markdownNode);
      const label =
        semantic.type === "unknown-directive"
          ? `Unknown directive: ${semantic.name}`
          : semantic.type === "invalid-block"
            ? `Invalid block: ${semantic.originalType}`
            : `Invalid structural block: ${semantic.type}`;
      state.addNode(type, {
        semanticJson: JSON.stringify(semantic),
        source: semanticNodeSource(semantic),
        label,
      });
    },
  },
  toMarkdown: {
    match: (node) => node.type.name === "gq_warning",
    runner: (state, node) => {
      if (typeof node.attrs.semanticJson !== "string") {
        throw new Error("Escaped visual block lost its semantic payload");
      }
      addSemanticNodeToMarkdown(state, semanticBlockFromJson(node.attrs.semanticJson));
    },
  },
}));

function warningNodeView(): NodeViewConstructor {
  return (initialNode) => {
    let currentNode = initialNode;
    const dom = document.createElement("section");
    dom.dataset.glyphquireWarning = "escaped";
    dom.contentEditable = "false";
    const label = document.createElement("strong");
    const pre = document.createElement("pre");
    const code = document.createElement("code");
    pre.append(code);
    dom.append(label, pre);

    const sync = (): void => {
      label.textContent =
        typeof currentNode.attrs.label === "string" ? currentNode.attrs.label : "Unsupported block";
      code.textContent =
        typeof currentNode.attrs.source === "string" ? currentNode.attrs.source : "";
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

export const visualWarningPlugins: MilkdownPlugin[] = [...visualWarningSchema, visualWarningView];
