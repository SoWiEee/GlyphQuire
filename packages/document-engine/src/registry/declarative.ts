import type { ContainerDirective, LeafDirective, TextDirective } from "mdast-util-directive";
import { z } from "zod";
import { customBlockDefinitionSchema, type CustomBlockDefinition } from "@glyphquire/theme-sdk";
import type { CustomBlockNode, CustomBlockScalar } from "../ast/nodes.js";
import {
  BlockValidationError,
  type BlockDefinition,
  type DirectiveMdastNode,
  type SerializeContext,
  type TransformContext,
} from "./types.js";
import { readAttributes } from "./registry.js";

const directiveVersionSchema = z.coerce.number().int().positive();

/**
 * Parse a declarative definition's string directive attributes into bounded
 * scalar props. This is intentionally data-only: definitions never carry or
 * evaluate executable renderers.
 */
export function parseDeclarativeProps(
  definition: CustomBlockDefinition,
  attributes: Record<string, string>,
): {
  props: Record<string, CustomBlockScalar>;
  issues: Array<{ code: string; message: string; attribute?: string }>;
} {
  const props: Record<string, CustomBlockScalar> = {};
  const issues: Array<{ code: string; message: string; attribute?: string }> = [];
  for (const attribute of Object.keys(attributes)) {
    if (attribute !== "version" && !(attribute in definition.propsSchema)) {
      issues.push({
        code: "ATTRIBUTE_UNKNOWN",
        message: `Unknown Custom Block attribute "${attribute}".`,
        attribute,
      });
    }
  }

  for (const [name, descriptor] of Object.entries(definition.propsSchema)) {
    const raw = attributes[name];
    if (raw === undefined) {
      if (descriptor.default !== undefined) {
        props[name] = descriptor.default as CustomBlockScalar;
      } else if (descriptor.required) {
        issues.push({
          code: "ATTRIBUTE_REQUIRED",
          message: `Attribute "${name}" is required.`,
          attribute: name,
        });
      }
      continue;
    }

    if (descriptor.type === "string") {
      if (raw.length > descriptor.maxLength) {
        issues.push({
          code: "ATTRIBUTE_INVALID_VALUE",
          message: `Attribute "${name}" exceeds its maximum length.`,
          attribute: name,
        });
      } else if (descriptor.enum && !descriptor.enum.includes(raw)) {
        issues.push({
          code: "ATTRIBUTE_INVALID_VALUE",
          message: `Attribute "${name}" is not an allowed value.`,
          attribute: name,
        });
      } else {
        props[name] = raw;
      }
      continue;
    }

    if (descriptor.type === "number") {
      const value = Number(raw);
      if (
        !Number.isFinite(value) ||
        value < descriptor.minimum ||
        value > descriptor.maximum ||
        (descriptor.enum && !descriptor.enum.includes(value))
      ) {
        issues.push({
          code: "ATTRIBUTE_INVALID_VALUE",
          message: `Attribute "${name}" must be a bounded number.`,
          attribute: name,
        });
      } else {
        props[name] = value;
      }
      continue;
    }

    if (raw !== "true" && raw !== "false") {
      issues.push({
        code: "ATTRIBUTE_INVALID_VALUE",
        message: `Attribute "${name}" must be true or false.`,
        attribute: name,
      });
    } else {
      const value = raw === "true";
      if (descriptor.enum && !descriptor.enum.includes(value)) {
        issues.push({
          code: "ATTRIBUTE_INVALID_VALUE",
          message: `Attribute "${name}" is not an allowed value.`,
          attribute: name,
        });
      } else {
        props[name] = value;
      }
    }
  }
  return { props, issues };
}

function sourceFromDirective(node: DirectiveMdastNode): string | undefined {
  const data = (node as DirectiveMdastNode & { data?: { source?: unknown } }).data;
  return typeof data?.source === "string" ? data.source : undefined;
}

/** Register a validated, non-executable Custom Block definition. */
export function registerDeclarative(
  registry: { register(definition: BlockDefinition): void },
  input: unknown,
): void {
  const definition = customBlockDefinitionSchema.parse(input);
  const block: BlockDefinition<CustomBlockNode> = {
    name: definition.name,
    version: definition.version,
    kind: definition.kind,
    capabilities: [...definition.capabilities],
    schema: z.record(z.string(), z.unknown()),
    fromDirective(node: DirectiveMdastNode, context: TransformContext): CustomBlockNode {
      const attributes = readAttributes(node);
      const children =
        node.type === "containerDirective" ? context.transformChildren(node.children) : [];
      const issues: Array<{ code: string; message: string; attribute?: string }> = [];
      const rawVersion = attributes.version;
      const version =
        rawVersion === undefined
          ? definition.version
          : directiveVersionSchema.safeParse(rawVersion).success
            ? Number(rawVersion)
            : NaN;
      if (version !== definition.version) {
        issues.push({
          code: "ATTRIBUTE_INVALID_VALUE",
          message: `Custom Block version must be ${definition.version}.`,
          attribute: "version",
        });
      }
      const parsed = parseDeclarativeProps(definition, attributes);
      issues.push(...parsed.issues);
      if (definition.contentPolicy === "required" && children.length === 0) {
        issues.push({ code: "CONTENT_REQUIRED", message: "This Custom Block requires content." });
      }
      if (definition.contentPolicy === "none" && children.length > 0) {
        issues.push({
          code: "CONTENT_FORBIDDEN",
          message: "This Custom Block does not accept nested content.",
        });
      }
      if (issues.length > 0) throw new BlockValidationError(issues, children);
      return {
        type: "custom-block",
        name: definition.name,
        version: definition.version,
        attributes,
        props: parsed.props,
        children,
        source: sourceFromDirective(node),
      };
    },
    toDirective(node: CustomBlockNode, context: SerializeContext): DirectiveMdastNode {
      const attributes: Record<string, string> = {
        ...node.attributes,
        version: String(node.version),
      };
      for (const [name, value] of Object.entries(node.props)) attributes[name] = String(value);
      if (definition.kind === "container") {
        return {
          type: "containerDirective",
          name: definition.name,
          attributes,
          children: context.serializeChildren(node.children) as ContainerDirective["children"],
        };
      }
      if (definition.kind === "leaf")
        return {
          type: "leafDirective",
          name: definition.name,
          attributes,
          children: [],
        } satisfies LeafDirective;
      return {
        type: "textDirective",
        name: definition.name,
        attributes,
        children: [],
      } satisfies TextDirective;
    },
  };
  registry.register(block);
}
