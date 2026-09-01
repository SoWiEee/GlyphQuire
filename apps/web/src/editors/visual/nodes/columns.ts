import type { ColumnsNode } from "@glyphquire/document-engine";
import type { MilkdownPlugin } from "@milkdown/kit/ctx";
import { $nodeSchema, $view } from "@milkdown/kit/utils";
import {
  addSemanticContainerToMarkdown,
  annotatedVisualKind,
  createContainerNodeView,
  readAnnotatedSemantic,
} from "../schema.js";

export const visualColumnsSchema = $nodeSchema("gq_columns", () => ({
  group: "block",
  content: "gq_column*",
  defining: true,
  isolating: true,
  attrs: {
    count: { default: "2", validate: "string" },
    gap: { default: null, validate: "string|null" },
  },
  parseDOM: [{ tag: "section[data-glyphquire-node='columns']" }],
  toDOM: (node) => [
    "section",
    {
      "data-glyphquire-node": "columns",
      "data-column-count": String(node.attrs.count || "2"),
      "data-column-gap": String(node.attrs.gap || "default"),
    },
    0,
  ],
  parseMarkdown: {
    match: (node) => annotatedVisualKind(node) === "columns",
    runner: (state, markdownNode, type) => {
      const semantic = readAnnotatedSemantic(markdownNode);
      if (semantic.type !== "columns") throw new Error("Expected annotated columns");
      state
        .openNode(type, {
          count: String(semantic.props.count),
          gap: semantic.props.gap ?? null,
        })
        .next(markdownNode.children)
        .closeNode();
    },
  },
  toMarkdown: {
    match: (node) => node.type.name === "gq_columns",
    runner: (state, node) => {
      const count = Number(node.attrs.count) as ColumnsNode["props"]["count"];
      const props: ColumnsNode["props"] = { count };
      if (typeof node.attrs.gap === "string" && node.attrs.gap !== "") {
        props.gap = node.attrs.gap as NonNullable<ColumnsNode["props"]["gap"]>;
      }
      addSemanticContainerToMarkdown(
        state,
        { type: "columns", version: 1, props, children: [] },
        node.content,
      );
    },
  },
}));

export const visualColumnSchema = $nodeSchema("gq_column", () => ({
  content: "block*",
  defining: true,
  isolating: true,
  parseDOM: [{ tag: "section[data-glyphquire-node='column']" }],
  toDOM: () => ["section", { "data-glyphquire-node": "column" }, 0],
  parseMarkdown: {
    match: (node) => annotatedVisualKind(node) === "column",
    runner: (state, markdownNode, type) => {
      const semantic = readAnnotatedSemantic(markdownNode);
      if (semantic.type !== "column") throw new Error("Expected an annotated column node");
      state.openNode(type).next(markdownNode.children).closeNode();
    },
  },
  toMarkdown: {
    match: (node) => node.type.name === "gq_column",
    runner: (state, node) => {
      addSemanticContainerToMarkdown(
        state,
        { type: "column", version: 1, children: [] },
        node.content,
      );
    },
  },
}));

const visualColumnsView = $view(visualColumnsSchema.node, () =>
  createContainerNodeView(
    "columns",
    [
      {
        attribute: "count",
        label: "Column count",
        type: "select",
        options: ["2", "3", "4"],
        optionLabels: { "2": "2 columns", "3": "3 columns", "4": "4 columns" },
      },
      {
        attribute: "gap",
        label: "Column gap",
        type: "select",
        options: ["", "sm", "md", "lg"],
        optionLabels: { "": "Default", sm: "Small", md: "Medium", lg: "Large" },
      },
    ],
    {
      label: "Columns",
      dataAttributes: (node) => ({
        "data-column-count": String(node.attrs.count || "2"),
        "data-column-gap": String(node.attrs.gap || "default"),
      }),
    },
  ),
);
const visualColumnView = $view(visualColumnSchema.node, () =>
  createContainerNodeView("column", [], { label: "Column" }),
);

export const visualColumnsPlugins: MilkdownPlugin[] = [
  ...visualColumnsSchema,
  ...visualColumnSchema,
  visualColumnsView,
  visualColumnView,
];
