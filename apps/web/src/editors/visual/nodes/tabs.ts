import type { MilkdownPlugin } from "@milkdown/kit/ctx";
import { $nodeSchema, $view } from "@milkdown/kit/utils";
import {
  addSemanticContainerToMarkdown,
  annotatedVisualKind,
  createContainerNodeView,
  readAnnotatedSemantic,
} from "../schema.js";

export const visualTabsSchema = $nodeSchema("gq_tabs", () => ({
  group: "block",
  content: "gq_tab*",
  defining: true,
  isolating: true,
  parseDOM: [{ tag: "section[data-glyphquire-node='tabs']" }],
  toDOM: () => ["section", { "data-glyphquire-node": "tabs" }, 0],
  parseMarkdown: {
    match: (node) => annotatedVisualKind(node) === "tabs",
    runner: (state, markdownNode, type) => {
      const semantic = readAnnotatedSemantic(markdownNode);
      if (semantic.type !== "tabs") throw new Error("Expected an annotated tabs node");
      state.openNode(type).next(markdownNode.children).closeNode();
    },
  },
  toMarkdown: {
    match: (node) => node.type.name === "gq_tabs",
    runner: (state, node) => {
      addSemanticContainerToMarkdown(
        state,
        { type: "tabs", version: 1, children: [] },
        node.content,
      );
    },
  },
}));

export const visualTabSchema = $nodeSchema("gq_tab", () => ({
  content: "block*",
  defining: true,
  isolating: true,
  attrs: { title: { default: "", validate: "string" } },
  parseDOM: [{ tag: "section[data-glyphquire-node='tab']" }],
  toDOM: () => ["section", { "data-glyphquire-node": "tab" }, 0],
  parseMarkdown: {
    match: (node) => annotatedVisualKind(node) === "tab",
    runner: (state, markdownNode, type) => {
      const semantic = readAnnotatedSemantic(markdownNode);
      if (semantic.type !== "tab") throw new Error("Expected an annotated tab node");
      state.openNode(type, { title: semantic.props.title }).next(markdownNode.children).closeNode();
    },
  },
  toMarkdown: {
    match: (node) => node.type.name === "gq_tab",
    runner: (state, node) => {
      addSemanticContainerToMarkdown(
        state,
        {
          type: "tab",
          version: 1,
          props: { title: String(node.attrs.title) },
          children: [],
        },
        node.content,
      );
    },
  },
}));

const visualTabsView = $view(visualTabsSchema.node, () => createContainerNodeView("tabs", []));
const visualTabView = $view(visualTabSchema.node, () =>
  createContainerNodeView("tab", [
    {
      attribute: "title",
      label: "Tab title",
      type: "text",
      dataAttribute: "data-glyphquire-tab-title",
    },
  ]),
);

export const visualTabsPlugins: MilkdownPlugin[] = [
  ...visualTabsSchema,
  ...visualTabSchema,
  visualTabsView,
  visualTabView,
];
