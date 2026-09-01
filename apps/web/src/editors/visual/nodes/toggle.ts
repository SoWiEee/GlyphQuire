import type { MilkdownPlugin } from "@milkdown/kit/ctx";
import type { Node as ProseNode } from "@milkdown/kit/prose/model";
import type { NodeViewConstructor } from "@milkdown/kit/prose/view";
import { $nodeSchema, $view } from "@milkdown/kit/utils";
import { createVNode, render } from "vue";
import type { IconName } from "@glyphquire/theme-sdk";
import GqIcon from "../../../components/icons/GqIcon.vue";
import {
  addSemanticContainerToMarkdown,
  annotatedVisualKind,
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
  toDOM: (node) => [
    "section",
    {
      "data-glyphquire-node": "toggle",
      "data-toggle-open": String(node.attrs.open === true),
    },
    0,
  ],
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

let toggleViewId = 0;

function toggleNodeView(): NodeViewConstructor {
  return (initialNode, view, getPos) => {
    let currentNode = initialNode;
    let expanded = currentNode.attrs.open === true;
    toggleViewId += 1;
    const id = `gq-toggle-${toggleViewId}`;
    const contentId = `${id}-content`;

    const dom = document.createElement("section");
    dom.dataset.glyphquireNode = "toggle";
    const header = document.createElement("header");
    header.contentEditable = "false";
    header.dataset.glyphquireControls = "";
    header.setAttribute("role", "group");
    header.setAttribute("aria-label", "Toggle settings");

    const disclosure = document.createElement("button");
    disclosure.type = "button";
    disclosure.dataset.toggleDisclosure = "";
    disclosure.setAttribute("aria-controls", contentId);
    const chevron = document.createElement("span");
    chevron.dataset.toggleChevron = "";
    chevron.setAttribute("aria-hidden", "true");
    const disclosureTitle = document.createElement("span");
    disclosureTitle.dataset.toggleTitle = "";
    disclosure.append(chevron, disclosureTitle);
    header.append(disclosure);

    const settings = document.createElement("div");
    settings.dataset.glyphquireFields = "";
    const titleLabel = document.createElement("label");
    titleLabel.dataset.glyphquireField = "title";
    const titleLabelText = document.createElement("span");
    titleLabelText.append(document.createTextNode("Title"));
    const titleInput = document.createElement("input");
    titleInput.type = "text";
    titleInput.id = `${id}-title`;
    titleInput.setAttribute("aria-label", "Toggle title");
    titleInput.dataset.glyphquireControl = "title";
    titleLabel.htmlFor = titleInput.id;
    titleLabel.append(titleLabelText, titleInput);
    settings.append(titleLabel);
    header.append(settings);

    const contentDOM = document.createElement("div");
    contentDOM.id = contentId;
    contentDOM.dataset.glyphquireContent = "toggle";
    contentDOM.dataset.toggleContent = "";
    dom.append(header, contentDOM);

    const sync = (): void => {
      const title = typeof currentNode.attrs.title === "string" ? currentNode.attrs.title : "";
      dom.dataset.toggleOpen = String(expanded);
      disclosure.setAttribute("aria-expanded", String(expanded));
      const iconName: IconName = expanded ? "chevron-down" : "chevrons-right";
      render(createVNode(GqIcon, { name: iconName, size: "sm" }), chevron);
      disclosureTitle.textContent = title || "Toggle details";
      contentDOM.hidden = !expanded;
      titleInput.value = title;
      titleInput.setAttribute("value", title);
    };

    disclosure.addEventListener("click", () => {
      const nextExpanded = !expanded;
      if (!view.editable) {
        expanded = nextExpanded;
        sync();
        return;
      }
      const position = getPos();
      if (position === undefined) return;
      expanded = nextExpanded;
      view.dispatch(
        view.state.tr.setNodeMarkup(position, undefined, {
          ...currentNode.attrs,
          open: nextExpanded,
        }),
      );
    });

    titleInput.addEventListener("change", () => {
      if (!view.editable) {
        sync();
        return;
      }
      const position = getPos();
      if (position === undefined) return;
      view.dispatch(
        view.state.tr.setNodeMarkup(position, undefined, {
          ...currentNode.attrs,
          title: titleInput.value,
        }),
      );
    });

    sync();

    return {
      dom,
      contentDOM,
      update(nextNode: ProseNode): boolean {
        if (nextNode.type !== currentNode.type) return false;
        currentNode = nextNode;
        expanded = currentNode.attrs.open === true;
        sync();
        return true;
      },
      destroy(): void {
        render(null, chevron);
      },
      stopEvent: (event) =>
        event.target instanceof globalThis.Node && header.contains(event.target),
      ignoreMutation: (mutation) =>
        header.contains(mutation.target) ||
        (mutation.type === "attributes" && mutation.target === dom),
    };
  };
}

const visualToggleView = $view(visualToggleSchema.node, () => toggleNodeView());

export const visualTogglePlugins: MilkdownPlugin[] = [...visualToggleSchema, visualToggleView];
