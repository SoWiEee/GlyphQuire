import type { CalloutNode } from "@glyphquire/document-engine";
import type { MilkdownPlugin } from "@milkdown/kit/ctx";
import { $nodeSchema, $view } from "@milkdown/kit/utils";
import {
  addSemanticContainerToMarkdown,
  annotatedVisualKind,
  createContainerNodeView,
  readAnnotatedSemantic,
} from "../schema.js";

export const visualCalloutSchema = $nodeSchema("gq_callout", () => ({
  group: "block",
  content: "block*",
  defining: true,
  isolating: true,
  attrs: {
    calloutType: { default: "info", validate: "string" },
    title: { default: null, validate: "string|null" },
    icon: { default: null, validate: "string|null" },
  },
  parseDOM: [{ tag: "section[data-glyphquire-node='callout']" }],
  toDOM: () => ["section", { "data-glyphquire-node": "callout" }, 0],
  parseMarkdown: {
    match: (node) => annotatedVisualKind(node) === "callout",
    runner: (state, markdownNode, type) => {
      const semantic = readAnnotatedSemantic(markdownNode);
      if (semantic.type !== "callout") throw new Error("Expected an annotated callout node");
      state
        .openNode(type, {
          calloutType: semantic.props.type,
          title: semantic.props.title ?? null,
          icon: semantic.props.icon ?? null,
        })
        .next(markdownNode.children)
        .closeNode();
    },
  },
  toMarkdown: {
    match: (node) => node.type.name === "gq_callout",
    runner: (state, node) => {
      const props: CalloutNode["props"] = {
        type: node.attrs.calloutType as CalloutNode["props"]["type"],
      };
      if (typeof node.attrs.title === "string") props.title = node.attrs.title;
      if (typeof node.attrs.icon === "string") props.icon = node.attrs.icon;
      addSemanticContainerToMarkdown(
        state,
        { type: "callout", version: 1, props, children: [] },
        node.content,
      );
    },
  },
}));

const visualCalloutView = $view(visualCalloutSchema.node, () =>
  createContainerNodeView("callout", [
    {
      attribute: "calloutType",
      label: "Type",
      type: "select",
      options: ["info", "note", "tip", "warning", "danger", "success"],
    },
    { attribute: "title", label: "Title", type: "text" },
    { attribute: "icon", label: "Icon", type: "text" },
  ]),
);

export const visualCalloutPlugins: MilkdownPlugin[] = [...visualCalloutSchema, visualCalloutView];
