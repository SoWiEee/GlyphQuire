import { z } from "zod";
import type { ContainerDirective } from "mdast-util-directive";
import { BlockValidationError, type BlockDefinition, type DirectiveMdastNode } from "../types.js";
import type { TabsNode, TabNode, BlockNode } from "../../ast/nodes.js";
import { readAttributes } from "../registry.js";
import { DIAGNOSTIC_CODES } from "../../validation/diagnostics.js";

const tabSchema = z.object({ title: z.string().min(1) });

export const tabBlock: BlockDefinition<TabNode> = {
  name: "tab",
  version: 1,
  kind: "container",
  capabilities: ["interactive-ui"],
  schema: tabSchema,
  fromDirective(node, context): TabNode {
    const props = tabSchema.parse(readAttributes(node));
    const container = node as ContainerDirective;
    return { type: "tab", version: 1, props, children: context.transformChildren(container.children) };
  },
  toDirective(node, context): DirectiveMdastNode {
    return {
      type: "containerDirective",
      name: "tab",
      attributes: { title: node.props.title },
      children: context.serializeChildren(node.children) as ContainerDirective["children"],
    };
  },
};

export const tabsBlock: BlockDefinition<TabsNode> = {
  name: "tabs",
  version: 1,
  kind: "container",
  capabilities: ["interactive-ui"],
  schema: z.object({}),
  fromDirective(node, context): TabsNode {
    const container = node as ContainerDirective;
    const transformed: BlockNode[] = context.transformChildren(container.children);
    const invalidChildren = transformed.filter(
      (child) => child.type !== "tab" && !(child.type === "invalid-block" && child.originalType === "tab"),
    );
    if (invalidChildren.length > 0) {
      throw new BlockValidationError(
        invalidChildren.map((child) => ({
          code: DIAGNOSTIC_CODES.INVALID_CHILD,
          message: `"${child.type}" is not a valid child of tabs; only "tab" children are allowed.`,
        })),
        transformed,
      );
    }
    const children = transformed.filter((child): child is TabNode => child.type === "tab");
    return { type: "tabs", version: 1, children };
  },
  toDirective(node, context): DirectiveMdastNode {
    return {
      type: "containerDirective",
      name: "tabs",
      attributes: {},
      children: context.serializeChildren(node.children) as ContainerDirective["children"],
    };
  },
};
