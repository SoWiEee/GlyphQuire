import { z } from "zod";
import type { ContainerDirective } from "mdast-util-directive";
import type { BlockDefinition, DirectiveMdastNode } from "../types.js";
import type { StickyNode } from "../../ast/nodes.js";
import { readAttributes } from "../registry.js";

const stickySchema = z.object({
  tone: z.enum(["default", "yellow", "pink", "blue", "green"]).default("default"),
  title: z.string().optional(),
});

export const stickyBlock: BlockDefinition<StickyNode> = {
  name: "sticky",
  version: 1,
  kind: "container",
  capabilities: ["static"],
  schema: stickySchema,
  fromDirective(node, context): StickyNode {
    const props = stickySchema.parse(readAttributes(node));
    const container = node as ContainerDirective;
    return { type: "sticky", version: 1, props, children: context.transformChildren(container.children) };
  },
  toDirective(node, context): DirectiveMdastNode {
    const attributes: Record<string, string> = { tone: node.props.tone };
    if (node.props.title !== undefined) attributes.title = node.props.title;
    return {
      type: "containerDirective",
      name: "sticky",
      attributes,
      children: context.serializeChildren(node.children) as ContainerDirective["children"],
    };
  },
};
