import type { MilkdownPlugin } from "@milkdown/kit/ctx";
import type { Node as ProseNode } from "@milkdown/kit/prose/model";
import type { NodeViewConstructor } from "@milkdown/kit/prose/view";
import { $nodeSchema, $view } from "@milkdown/kit/utils";
import {
  addSemanticContainerToMarkdown,
  annotatedVisualKind,
  readAnnotatedSemantic,
} from "../schema.js";

export const visualTabsSchema = $nodeSchema("gq_tabs", () => ({
  group: "block",
  content: "gq_tab*",
  defining: true,
  isolating: true,
  parseDOM: [{ tag: "section[data-glyphquire-node='tabs']" }],
  toDOM: (node) => [
    "section",
    {
      "data-glyphquire-node": "tabs",
      "data-tab-count": String(node.childCount),
    },
    0,
  ],
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
  toDOM: (node) => [
    "section",
    { "data-glyphquire-node": "tab", "data-tab-title": String(node.attrs.title) },
    0,
  ],
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

let tabsViewId = 0;
let tabViewId = 0;

function tabTitle(node: ProseNode, index: number): string {
  const title = typeof node.attrs.title === "string" ? node.attrs.title.trim() : "";
  return title || `Tab ${index + 1}`;
}

function tabPanels(contentDOM: HTMLElement): HTMLElement[] {
  return Array.from(contentDOM.children).filter(
    (child): child is HTMLElement =>
      child instanceof globalThis.HTMLElement && child.dataset.glyphquireNode === "tab",
  );
}

function tabsNodeView(): NodeViewConstructor {
  return (initialNode) => {
    let currentNode = initialNode;
    let activeIndex = 0;
    tabsViewId += 1;
    const id = `gq-tabs-${tabsViewId}`;

    const dom = document.createElement("section");
    dom.dataset.glyphquireNode = "tabs";
    const header = document.createElement("header");
    header.dataset.glyphquireControls = "";
    header.contentEditable = "false";
    const tablist = document.createElement("div");
    tablist.dataset.glyphquireTablist = "";
    tablist.setAttribute("role", "tablist");
    tablist.setAttribute("aria-label", "Tabs");
    header.append(tablist);
    const contentDOM = document.createElement("div");
    contentDOM.dataset.glyphquireContent = "tabs";
    dom.append(header, contentDOM);

    let triggers: HTMLButtonElement[] = [];

    const syncPanels = (): void => {
      const panels = tabPanels(contentDOM);
      for (const [index, panel] of panels.entries()) {
        const triggerId = `${id}-tab-${index}`;
        const panelId = `${id}-panel-${index}`;
        panel.id = panelId;
        panel.setAttribute("role", "tabpanel");
        panel.setAttribute("aria-labelledby", triggerId);
        panel.setAttribute("data-tab-panel", "");
        panel.hidden = index !== activeIndex;
      }
    };

    const select = (index: number, focus: boolean): void => {
      if (triggers.length === 0) return;
      activeIndex = Math.max(0, Math.min(index, triggers.length - 1));
      for (const [triggerIndex, trigger] of triggers.entries()) {
        const selected = triggerIndex === activeIndex;
        trigger.setAttribute("aria-selected", String(selected));
        trigger.tabIndex = selected ? 0 : -1;
      }
      syncPanels();
      if (focus) triggers[activeIndex]?.focus();
    };

    const rebuildTriggers = (): void => {
      const count = currentNode.childCount;
      dom.dataset.tabCount = String(count);
      if (count === 0) activeIndex = 0;
      else activeIndex = Math.min(activeIndex, count - 1);
      tablist.replaceChildren();
      triggers = [];
      for (let index = 0; index < count; index += 1) {
        const child = currentNode.child(index);
        const trigger = document.createElement("button");
        trigger.type = "button";
        trigger.dataset.tabTrigger = "";
        trigger.id = `${id}-tab-${index}`;
        trigger.setAttribute("role", "tab");
        trigger.setAttribute("aria-controls", `${id}-panel-${index}`);
        trigger.setAttribute("aria-label", tabTitle(child, index));
        trigger.textContent = tabTitle(child, index);
        trigger.addEventListener("click", () => select(index, false));
        trigger.addEventListener("keydown", (event) => {
          let nextIndex: number | null = null;
          if (event.key === "ArrowRight" || event.key === "ArrowDown") {
            nextIndex = (activeIndex + 1) % count;
          } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
            nextIndex = (activeIndex - 1 + count) % count;
          } else if (event.key === "Home") {
            nextIndex = 0;
          } else if (event.key === "End") {
            nextIndex = count - 1;
          }
          if (nextIndex === null) return;
          event.preventDefault();
          select(nextIndex, true);
        });
        tablist.append(trigger);
        triggers.push(trigger);
      }
      select(activeIndex, false);
      syncPanels();
    };

    rebuildTriggers();
    const observer = new MutationObserver(syncPanels);
    observer.observe(contentDOM, { childList: true });

    return {
      dom,
      contentDOM,
      update(nextNode: ProseNode): boolean {
        if (nextNode.type !== currentNode.type) return false;
        currentNode = nextNode;
        rebuildTriggers();
        return true;
      },
      destroy(): void {
        observer.disconnect();
      },
      stopEvent: (event) =>
        event.target instanceof globalThis.Node && tablist.contains(event.target),
      ignoreMutation: (mutation) =>
        tablist.contains(mutation.target) ||
        (mutation.type === "attributes" && mutation.target === dom),
    };
  };
}

function tabNodeView(): NodeViewConstructor {
  return (initialNode, view, getPos) => {
    let currentNode = initialNode;
    tabViewId += 1;
    const id = `gq-tab-${tabViewId}`;
    const dom = document.createElement("section");
    dom.dataset.glyphquireNode = "tab";
    const header = document.createElement("header");
    header.contentEditable = "false";
    header.dataset.glyphquireControls = "";
    header.setAttribute("role", "group");
    header.setAttribute("aria-label", "Tab settings");
    const label = document.createElement("label");
    label.dataset.glyphquireField = "title";
    const labelText = document.createElement("span");
    labelText.append(document.createTextNode("Tab title"));
    const titleInput = document.createElement("input");
    titleInput.type = "text";
    titleInput.id = `${id}-title`;
    titleInput.setAttribute("aria-label", "Tab title");
    titleInput.dataset.glyphquireControl = "title";
    titleInput.dataset.glyphquireTabTitle = "";
    label.htmlFor = titleInput.id;
    label.append(labelText, titleInput);
    header.append(label);
    const contentDOM = document.createElement("div");
    contentDOM.dataset.glyphquireContent = "tab";
    dom.append(header, contentDOM);

    const sync = (): void => {
      const title = typeof currentNode.attrs.title === "string" ? currentNode.attrs.title : "";
      dom.dataset.tabTitle = title;
      titleInput.value = title;
      titleInput.setAttribute("value", title);
    };
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
        sync();
        return true;
      },
      stopEvent: (event) =>
        event.target instanceof globalThis.Node && header.contains(event.target),
      ignoreMutation: (mutation) =>
        header.contains(mutation.target) ||
        (mutation.type === "attributes" && mutation.target === dom),
    };
  };
}

const visualTabsView = $view(visualTabsSchema.node, () => tabsNodeView());
const visualTabView = $view(visualTabSchema.node, () => tabNodeView());

export const visualTabsPlugins: MilkdownPlugin[] = [
  ...visualTabsSchema,
  ...visualTabSchema,
  visualTabsView,
  visualTabView,
];
