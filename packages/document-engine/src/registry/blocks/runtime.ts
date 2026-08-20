import { z } from "zod";
import type { ContainerDirective } from "mdast-util-directive";
import type { Code } from "mdast";
import type { BlockDefinition, DirectiveMdastNode } from "../types.js";
import type { RuntimeNode } from "../../ast/nodes.js";
import { readAttributes } from "../registry.js";

const runtimeSchema = z.object({
  height: z
    .string()
    .optional()
    .transform((v) => (v === undefined ? 400 : Number(v)))
    .pipe(z.number().int().positive()),
  network: z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === "" ? [] : [v])),
  autoplay: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
});

function makeRuntimeBlock(runtime: "p5" | "canvas"): BlockDefinition<RuntimeNode> {
  return {
    name: runtime,
    version: 1,
    kind: "container",
    capabilities: ["sandbox-runtime"],
    schema: runtimeSchema,
    fromDirective(node): RuntimeNode {
      const props = runtimeSchema.parse(readAttributes(node));
      const container = node as ContainerDirective;
      const codeNode = container.children.find((c): c is Code => c.type === "code");
      return {
        type: "runtime",
        version: 1,
        runtime,
        props,
        source: codeNode?.value ?? "",
      };
    },
    toDirective(node): DirectiveMdastNode {
      const attributes: Record<string, string> = { height: String(node.props.height) };
      if (node.props.network.length > 0) attributes.network = node.props.network[0]!;
      if (node.props.autoplay) attributes.autoplay = "true";
      const code: Code = { type: "code", lang: "js", value: node.source };
      const directive: ContainerDirective = {
        type: "containerDirective",
        name: runtime,
        attributes,
        children: [code],
      };
      return directive;
    },
  };
}

export const p5Block = makeRuntimeBlock("p5");
export const canvasBlock = makeRuntimeBlock("canvas");
