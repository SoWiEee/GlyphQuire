import type { MilkdownPlugin } from "@milkdown/kit/ctx";
import { $nodeSchema, $view } from "@milkdown/kit/utils";
import {
  addSemanticContainerToMarkdown,
  annotatedVisualKind,
  createContainerNodeView,
  readAnnotatedSemantic,
} from "../schema.js";

export const visualToggleSchema = $nodeSchema("gq_toggle", () => ({
  group: "block",
  content: "block*",
  defining: true,
  isolating: true,
  attrs: {
    title: { default: "", validate: "string" },
    open: { default: false, validate: "boolean" },
  },
  parseDOM: [{ tag: "section[data-glyphquire-node='toggle']" }],
  toDOM: () => ["section", { "data-glyphquire-node": "toggle" }, 0],
  parseMarkdown: {
    match: (node) => annotatedVisualKind(node) === "toggle",
    runner: (state, markdownNode, type) => {
      const semantic = readAnnotatedSemantic(markdownNode);
      if (semantic.type !== "toggle") throw new Error("Expected an annotated toggle node");
      state
        .openNode(type, { title: semantic.props.title, open: semantic.props.open })
        .next(markdownNode.children)
        .closeNode();
    },
  },
  toMarkdown: {
    match: (node) => node.type.name === "gq_toggle",
    runner: (state, node) => {
      addSemanticContainerToMarkdown(
        state,
        {
          type: "toggle",
          version: 1,
          props: { title: String(node.attrs.title), open: node.attrs.open === true },
          children: [],
        },
        node.content,
      );
    },
  },
}));

const visualToggleView = $view(visualToggleSchema.node, () =>
  createContainerNodeView("toggle", [
    { attribute: "title", label: "Title", type: "text" },
    { attribute: "open", label: "Open", type: "checkbox" },
  ]),
);

export const visualTogglePlugins: MilkdownPlugin[] = [...visualToggleSchema, visualToggleView];
