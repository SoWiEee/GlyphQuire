import type { RuntimeNode } from "@glyphquire/document-engine";
import type { MilkdownPlugin } from "@milkdown/kit/ctx";
import type { Node as ProseNode } from "@milkdown/kit/prose/model";
import type { NodeViewConstructor } from "@milkdown/kit/prose/view";
import { $nodeSchema, $view } from "@milkdown/kit/utils";
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
    toDOM: () => ["section", { "data-glyphquire-node": runtime }],
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
    dom.contentEditable = "false";

    const heading = document.createElement("strong");
    heading.append(document.createTextNode(`${runtime} (static preview)`));
    dom.append(heading);

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
      label.append(document.createTextNode(labelText));
      const input = document.createElement("input");
      input.type = type;
      if (type === "number") input.min = "1";
      input.dataset.glyphquireControl = attribute;
      label.append(input);
      dom.append(label);
      controls.push({ attribute, element: input });
    };

    addInput("height", "Height", "number");
    addInput("network", "Network declaration (inert)", "text");
    addInput("autoplay", "Autoplay declaration (inert)", "checkbox");

    const sourceLabel = document.createElement("label");
    sourceLabel.append(document.createTextNode("Source (never executed)"));
    const source = document.createElement("textarea");
    source.dataset.glyphquireControl = "source";
    source.dataset.glyphquireRuntimeSource = "";
    sourceLabel.append(source);
    dom.append(sourceLabel);
    controls.push({ attribute: "source", element: source });

    const placeholder = document.createElement("div");
    placeholder.dataset.glyphquireRuntimePlaceholder = runtime;
    placeholder.append(document.createTextNode(`${runtime} execution is disabled in Visual Mode.`));
    dom.append(placeholder);

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
