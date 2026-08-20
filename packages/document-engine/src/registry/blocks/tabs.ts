import { z } from "zod";
import type { ContainerDirective } from "mdast-util-directive";
import type { BlockDefinition, DirectiveMdastNode } from "../types.js";
import type { TabsNode, TabNode, BlockNode } from "../../ast/nodes.js";
import { readAttributes } from "../registry.js";
import { diagnostic, DIAGNOSTIC_CODES } from "../../validation/diagnostics.js";

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
    for (const child of transformed) {
      if (child.type !== "tab") {
        context.addDiagnostic(
          diagnostic(
            DIAGNOSTIC_CODES.INVALID_CHILD,
            "warning",
            `"${child.type}" is not a valid child of tabs and was dropped; only "tab" children are allowed.`,
            { block: "tabs" },
          ),
        );
      }
    }
    const children = transformed.filter((c): c is TabNode => c.type === "tab");
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
