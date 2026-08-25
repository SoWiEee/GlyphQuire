import type { MilkdownPlugin } from "@milkdown/kit/ctx";
import { $nodeSchema, $view } from "@milkdown/kit/utils";
import katex from "katex";

export const visualMathBlockSchema = $nodeSchema("gq_math_block", () => ({
  group: "block",
  content: "text*",
  marks: "",
  defining: true,
  isolating: true,
  atom: false,
  code: true,
  attrs: {
    value: { default: "" },
  },
  parseDOM: [
    {
      tag: "div[data-glyphquire-node='math-block']",
      getAttrs: (dom) => ({
        value: (dom as HTMLElement).getAttribute("data-value") ?? "",
      }),
    },
  ],
  toDOM: (node) => [
    "div",
    {
      "data-glyphquire-node": "math-block",
      "data-value": node.attrs.value as string,
    },
    0,
  ],
}));

export const visualMathBlockView = $view(visualMathBlockSchema.node, () => (node) => {
  const container = document.createElement("div");
  container.classList.add("gq-math-block");
  container.setAttribute("data-glyphquire-node", "math-block");

  const latex = node.textContent || (node.attrs.value as string) || "";

  try {
    katex.render(latex, container, {
      displayMode: true,
      throwOnError: false,
      output: "mathml",
    });
  } catch {
    container.textContent = latex;
  }

  return {
    dom: container,
    update(updatedNode) {
      if (updatedNode.type.name !== "gq_math_block") return false;
      const updatedLatex = updatedNode.textContent || (updatedNode.attrs.value as string) || "";
      try {
        katex.render(updatedLatex, container, {
          displayMode: true,
          throwOnError: false,
          output: "mathml",
        });
      } catch {
        container.textContent = updatedLatex;
      }
      return true;
    },
  };
});

export const mathPlugins: MilkdownPlugin[] = [visualMathBlockSchema, visualMathBlockView];
