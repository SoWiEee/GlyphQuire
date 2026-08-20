import { z } from "zod";
import type { ContainerDirective } from "mdast-util-directive";
import type { BlockDefinition, TransformContext, SerializeContext, DirectiveMdastNode } from "../types.js";
import type { CalloutNode } from "../../ast/nodes.js";
import { readAttributes } from "../registry.js";

const calloutSchema = z.object({
  type: z
    .enum(["info", "note", "tip", "warning", "danger", "success"])
    .default("info"),
  title: z.string().optional(),
  icon: z.string().optional(),
});

export const calloutBlock: BlockDefinition<CalloutNode> = {
  name: "callout",
  version: 1,
  kind: "container",
  capabilities: ["static"],
  schema: calloutSchema,
  fromDirective(node: DirectiveMdastNode, context: TransformContext): CalloutNode {
    const attrs = readAttributes(node);
    const props = calloutSchema.parse(attrs);
    const container = node as ContainerDirective;
    return {
      type: "callout",
      version: 1,
      props,
      children: context.transformChildren(container.children),
    };
  },
  toDirective(node: CalloutNode, context: SerializeContext): DirectiveMdastNode {
    const attributes: Record<string, string> = { type: node.props.type };
    if (node.props.title !== undefined) attributes.title = node.props.title;
    if (node.props.icon !== undefined) attributes.icon = node.props.icon;
    const directive: ContainerDirective = {
      type: "containerDirective",
      name: "callout",
      attributes,
      children: context.serializeChildren(node.children) as ContainerDirective["children"],
    };
    return directive;
  },
};
