import type { RuntimeNode } from "@glyphquire/document-engine";
import type { MilkdownPlugin } from "@milkdown/kit/ctx";
import type { Node as ProseNode } from "@milkdown/kit/prose/model";
import type { NodeViewConstructor } from "@milkdown/kit/prose/view";
import { $nodeSchema, $view } from "@milkdown/kit/utils";
import { createApp, h, ref as vueRef } from "vue";
import RuntimeHost from "../../../runtime/RuntimeHost.vue";
import {
  addSemanticNodeToMarkdown,
  annotatedVisualKind,
  readAnnotatedSemantic,
} from "../schema.js";

function makeRuntimeSchema<const TId extends string>(id: TId, runtime: "p5" | "canvas") {
  return $nodeSchema(id, () => ({
    atom: true,
    group: "block",
    isolating: true,
    selectable: true,
    attrs: {
      height: { default: "400", validate: "string" },
      network: { default: "", validate: "string" },
      autoplay: { default: false, validate: "boolean" },
      source: { default: "", validate: "string" },
    },
    parseDOM: [{ tag: `section[data-glyphquire-node='${runtime}']` }],
    toDOM: () => ["section", { "data-glyphquire-node": runtime, "data-runtime-kind": runtime }],
    parseMarkdown: {
      match: (node) => annotatedVisualKind(node) === runtime,
      runner: (state, markdownNode, type) => {
        const semantic = readAnnotatedSemantic(markdownNode);
        if (semantic.type !== "runtime" || semantic.runtime !== runtime) {
          throw new Error(`Expected an annotated ${runtime} runtime node`);
        }
        state.addNode(type, {
          height: String(semantic.props.height),
          network: semantic.props.network[0] ?? "",
          autoplay: semantic.props.autoplay,
          source: semantic.source,
        });
      },
    },
    toMarkdown: {
      match: (node) => node.type.name === id,
      runner: (state, node) => {
        const height = Number(node.attrs.height);
        if (!Number.isSafeInteger(height) || height <= 0) {
          throw new Error("Runtime height must remain a positive integer");
        }
        const network = typeof node.attrs.network === "string" ? node.attrs.network : "";
        const semantic: RuntimeNode = {
          type: "runtime",
          version: 1,
          runtime,
          props: {
            height,
            network: network === "" ? [] : [network],
            autoplay: node.attrs.autoplay === true,
          },
          source: String(node.attrs.source),
        };
        addSemanticNodeToMarkdown(state, semantic);
      },
    },
  }));
}

function runtimeNodeView(runtime: "p5" | "canvas"): NodeViewConstructor {
  return (initialNode, view, getPos) => {
    let currentNode = initialNode;
    const dom = document.createElement("section");
    dom.dataset.glyphquireNode = runtime;
    dom.dataset.runtimeKind = runtime;
    dom.contentEditable = "false";

    const runtimeLabel = runtime === "p5" ? "Interactive sketch" : "Interactive canvas";
    const header = document.createElement("header");
    header.dataset.glyphquireControls = "";
    header.setAttribute("role", "group");
    header.setAttribute("aria-label", `${runtimeLabel} settings`);
    const heading = document.createElement("strong");
    heading.setAttribute("role", "heading");
    heading.setAttribute("aria-level", "3");
    heading.append(document.createTextNode(runtimeLabel));
    header.append(heading);
    dom.append(header);

    const controls: Array<{
      readonly attribute: "height" | "network" | "autoplay" | "source";
      readonly element: HTMLInputElement | HTMLTextAreaElement;
    }> = [];

    const addInput = (
      attribute: "height" | "network" | "autoplay",
      labelText: string,
      type: "number" | "text" | "checkbox",
    ): void => {
      const label = document.createElement("label");
      label.dataset.glyphquireField = attribute;
      const fieldLabel = document.createElement("span");
      fieldLabel.append(document.createTextNode(labelText));
      label.append(fieldLabel);
      const input = document.createElement("input");
      input.type = type;
      if (type === "number") input.min = "1";
      input.id = `gq-${runtime}-${attribute}-${controls.length + 1}`;
      input.setAttribute("aria-label", labelText);
      label.htmlFor = input.id;
      input.dataset.glyphquireControl = attribute;
      label.append(input);
      header.append(label);
      controls.push({ attribute, element: input });
    };

    addInput("height", "Preview height", "number");
    addInput("network", "Network access", "text");
    addInput("autoplay", "Run automatically", "checkbox");

    const sourceDetails = document.createElement("details");
    sourceDetails.dataset.runtimeSourceSettings = "";
    const sourceSummary = document.createElement("summary");
    sourceSummary.append(document.createTextNode("Source code"));
    const sourceLabel = document.createElement("label");
    sourceLabel.dataset.glyphquireField = "source";
    const sourceLabelText = document.createElement("span");
    sourceLabelText.append(document.createTextNode("Source code"));
    const source = document.createElement("textarea");
    source.id = `gq-${runtime}-source-${controls.length + 1}`;
    source.setAttribute("aria-label", "Source code");
    sourceLabel.htmlFor = source.id;
    source.dataset.glyphquireControl = "source";
    source.dataset.glyphquireRuntimeSource = "";
    sourceLabel.append(sourceLabelText, source);
    sourceDetails.append(sourceSummary, sourceLabel);
    dom.append(sourceDetails);
    controls.push({ attribute: "source", element: source });

    // -- Vue RuntimeHost mount --
    const hostContainer = document.createElement("div");
    hostContainer.dataset.glyphquireRuntimeHost = "";
    dom.append(hostContainer);

    const sourceRef = vueRef(String(currentNode.attrs.source));
    const heightRef = vueRef(Number(currentNode.attrs.height) || 400);
    const autoplayRef = vueRef(currentNode.attrs.autoplay === true);

    const app = createApp({
      render: () =>
        h(RuntimeHost, {
          runtime,
          source: sourceRef.value,
          height: heightRef.value,
          autoplay: autoplayRef.value,
        }),
    });
    app.mount(hostContainer);

    const sync = (): void => {
      for (const { attribute, element } of controls) {
        const value = currentNode.attrs[attribute];
        if (element instanceof HTMLInputElement && element.type === "checkbox") {
          element.checked = value === true;
        } else {
          element.value = typeof value === "string" ? value : "";
          if (element instanceof HTMLInputElement) element.setAttribute("value", element.value);
        }
      }
      sourceRef.value = String(currentNode.attrs.source);
      heightRef.value = Number(currentNode.attrs.height) || 400;
      autoplayRef.value = currentNode.attrs.autoplay === true;
    };

    const read = (element: HTMLInputElement | HTMLTextAreaElement): string | boolean =>
      element instanceof HTMLInputElement && element.type === "checkbox"
        ? element.checked
        : element.value;

    for (const { attribute, element } of controls) {
      element.addEventListener("change", () => {
        if (!view.editable) {
          sync();
          return;
        }
        const nextValue = read(element);
        if (attribute === "height") {
          const numeric = Number(nextValue);
          if (!Number.isSafeInteger(numeric) || numeric <= 0) {
            sync();
            return;
          }
        }
        const position = getPos();
        if (position === undefined) return;
        view.dispatch(
          view.state.tr.setNodeMarkup(position, undefined, {
            ...currentNode.attrs,
            [attribute]: nextValue,
          }),
        );
      });
    }
    sync();

    return {
      dom,
      update(nextNode: ProseNode): boolean {
        if (nextNode.type !== currentNode.type) return false;
        currentNode = nextNode;
        sync();
        return true;
      },
      destroy(): void {
        app.unmount();
      },
      stopEvent: () => true,
      ignoreMutation: () => true,
    };
  };
}

export const visualP5Schema = makeRuntimeSchema("gq_p5", "p5");
export const visualCanvasSchema = makeRuntimeSchema("gq_canvas", "canvas");
const visualP5View = $view(visualP5Schema.node, () => runtimeNodeView("p5"));
const visualCanvasView = $view(visualCanvasSchema.node, () => runtimeNodeView("canvas"));

export const visualRuntimePlugins: MilkdownPlugin[] = [
  ...visualP5Schema,
  ...visualCanvasSchema,
  visualP5View,
  visualCanvasView,
];
