import { z } from "zod";
import type { ContainerDirective } from "mdast-util-directive";
import type { BlockDefinition, DirectiveMdastNode } from "../types.js";
import type { ToggleNode } from "../../ast/nodes.js";
import { readAttributes } from "../registry.js";

const toggleSchema = z.object({
  title: z.string().min(1),
  open: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
});

export const toggleBlock: BlockDefinition<ToggleNode> = {
  name: "toggle",
  version: 1,
  kind: "container",
  capabilities: ["interactive-ui"],
  schema: toggleSchema,
  fromDirective(node, context): ToggleNode {
    const props = toggleSchema.parse(readAttributes(node));
    const container = node as ContainerDirective;
    return { type: "toggle", version: 1, props, children: context.transformChildren(container.children) };
  },
  toDirective(node, context): DirectiveMdastNode {
    const attributes: Record<string, string> = { title: node.props.title };
    if (node.props.open) attributes.open = "true"; // omit default false
    return {
      type: "containerDirective",
      name: "toggle",
      attributes,
      children: context.serializeChildren(node.children) as ContainerDirective["children"],
    };
  },
};
