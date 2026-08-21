import { z } from "zod";
import type { ContainerDirective } from "mdast-util-directive";
import { BlockValidationError, type BlockDefinition, type DirectiveMdastNode } from "../types.js";
import type { ColumnsNode, ColumnNode, BlockNode } from "../../ast/nodes.js";
import { readAttributes } from "../registry.js";
import { DIAGNOSTIC_CODES } from "../../validation/diagnostics.js";

const columnsSchema = z.object({
  count: z
    .enum(["2", "3", "4"])
    .optional()
    .transform((v) => (v === undefined ? undefined : (Number(v) as 2 | 3 | 4))),
  gap: z.enum(["sm", "md", "lg"]).optional(),
});

export const columnBlock: BlockDefinition<ColumnNode> = {
  name: "column",
  version: 1,
  kind: "container",
  capabilities: ["static"],
  schema: z.object({}),
  fromDirective(node, context): ColumnNode {
    const container = node as ContainerDirective;
    return { type: "column", version: 1, children: context.transformChildren(container.children) };
  },
  toDirective(node, context): DirectiveMdastNode {
    return {
      type: "containerDirective",
      name: "column",
      attributes: {},
      children: context.serializeChildren(node.children) as ContainerDirective["children"],
    };
  },
};

export const columnsBlock: BlockDefinition<ColumnsNode> = {
  name: "columns",
  version: 1,
  kind: "container",
  capabilities: ["static"],
  schema: columnsSchema,
  fromDirective(node, context): ColumnsNode {
    const parsed = columnsSchema.parse(readAttributes(node));
    const container = node as ContainerDirective;
    const transformed: BlockNode[] = context.transformChildren(container.children);
    const invalidChildren = transformed.filter(
      (child) =>
        child.type !== "column" &&
        !(child.type === "invalid-block" && child.originalType === "column"),
    );
    const nominalInvalidChildren = transformed.filter(
      (child) => child.type === "invalid-block" && child.originalType === "column",
    );
    if (invalidChildren.length > 0 || nominalInvalidChildren.length > 0) {
      throw new BlockValidationError(
        invalidChildren.map((child) => ({
          code: DIAGNOSTIC_CODES.INVALID_CHILD,
          message: `"${child.type}" is not a valid child of columns; only "column" children are allowed.`,
        })),
        transformed,
      );
    }
    const children = transformed.filter((child): child is ColumnNode => child.type === "column");
    const count = (parsed.count ?? Math.min(Math.max(children.length, 2), 4)) as 2 | 3 | 4;
    const props: ColumnsNode["props"] = { count };
    if (parsed.gap !== undefined) props.gap = parsed.gap;
    return { type: "columns", version: 1, props, children };
  },
  toDirective(node, context): DirectiveMdastNode {
    const attributes: Record<string, string> = { count: String(node.props.count) };
    if (node.props.gap !== undefined) attributes.gap = node.props.gap;
    return {
      type: "containerDirective",
      name: "columns",
      attributes,
      children: context.serializeChildren(node.children) as ContainerDirective["children"],
    };
  },
};
