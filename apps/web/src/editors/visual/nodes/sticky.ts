import type { StickyNode } from "@glyphquire/document-engine";
import type { MilkdownPlugin } from "@milkdown/kit/ctx";
import { $nodeSchema, $view } from "@milkdown/kit/utils";
import {
  addSemanticContainerToMarkdown,
  annotatedVisualKind,
  createContainerNodeView,
  readAnnotatedSemantic,
} from "../schema.js";

export const visualStickySchema = $nodeSchema("gq_sticky", () => ({
  group: "block",
  content: "block*",
  defining: true,
  isolating: true,
  attrs: {
    tone: { default: "default", validate: "string" },
    title: { default: null, validate: "string|null" },
  },
  parseDOM: [{ tag: "section[data-glyphquire-node='sticky']" }],
  toDOM: (node) => [
    "section",
    {
      "data-glyphquire-node": "sticky",
      "data-sticky-tone": String(node.attrs.tone || "default"),
    },
    0,
  ],
  parseMarkdown: {
    match: (node) => annotatedVisualKind(node) === "sticky",
    runner: (state, markdownNode, type) => {
      const semantic = readAnnotatedSemantic(markdownNode);
      if (semantic.type !== "sticky") throw new Error("Expected an annotated sticky node");
      state
        .openNode(type, {
          tone: semantic.props.tone,
          title: semantic.props.title ?? null,
        })
        .next(markdownNode.children)
        .closeNode();
    },
  },
  toMarkdown: {
    match: (node) => node.type.name === "gq_sticky",
    runner: (state, node) => {
      const props: StickyNode["props"] = {
        tone: node.attrs.tone as StickyNode["props"]["tone"],
      };
      if (typeof node.attrs.title === "string") props.title = node.attrs.title;
      addSemanticContainerToMarkdown(
        state,
        { type: "sticky", version: 1, props, children: [] },
        node.content,
      );
    },
  },
}));

const visualStickyView = $view(visualStickySchema.node, () =>
  createContainerNodeView(
    "sticky",
    [
      {
        attribute: "tone",
        label: "Tone",
        type: "select",
        options: ["default", "yellow", "pink", "blue", "green"],
        optionLabels: {
          default: "Default",
          yellow: "Yellow",
          pink: "Pink",
          blue: "Blue",
          green: "Green",
        },
      },
      { attribute: "title", label: "Title", type: "text" },
    ],
    {
      label: "Sticky note",
      dataAttributes: (node) => ({
        "data-sticky-tone": String(node.attrs.tone || "default"),
      }),
    },
  ),
);

export const visualStickyPlugins: MilkdownPlugin[] = [...visualStickySchema, visualStickyView];
