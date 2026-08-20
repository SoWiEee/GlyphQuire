import type { DirectiveMdastNode } from "./types.js";
import type { BlockDefinition } from "./types.js";

export const RESERVED_NAMES = [
  "callout",
  "sticky",
  "toggle",
  "tabs",
  "tab",
  "columns",
  "column",
  "p5",
  "canvas",
] as const;

const RESERVED = new Set<string>(RESERVED_NAMES);
const BUILTIN_REGISTRATION_TOKEN = Symbol("builtin-registration");
type BuiltinRegistrationToken = typeof BUILTIN_REGISTRATION_TOKEN;

export class BlockRegistry {
  private readonly definitions = new Map<string, BlockDefinition>();

  register(
    definition: BlockDefinition,
    token?: BuiltinRegistrationToken,
  ): void {
    if (token !== BUILTIN_REGISTRATION_TOKEN && isReservedName(definition.name)) {
      throw new Error(`Block "${definition.name}" is reserved for built-in definitions.`);
    }
    if (this.definitions.has(definition.name)) {
      throw new Error(`Block "${definition.name}" is already registered.`);
    }
    this.definitions.set(definition.name, definition);
  }

  get(name: string): BlockDefinition | undefined {
    return this.definitions.get(name);
  }

  has(name: string): boolean {
    return this.definitions.has(name);
  }
}

export function registerBuiltin(
  registry: BlockRegistry,
  definition: BlockDefinition,
): void {
  registry.register(definition, BUILTIN_REGISTRATION_TOKEN);
}

export function isReservedName(name: string): boolean {
  return RESERVED.has(name);
}

/** Coerce a directive node's attributes to a plain string record. */
export function readAttributes(
  node: DirectiveMdastNode,
): Record<string, string> {
  const result: Record<string, string> = {};
  const attrs = node.attributes ?? {};
  for (const [key, value] of Object.entries(attrs)) {
    if (typeof value === "string") result[key] = value;
  }
  return result;
}

export function directiveTypeOf(
  node: DirectiveMdastNode,
): "container" | "leaf" | "text" {
  if (node.type === "containerDirective") return "container";
  if (node.type === "leafDirective") return "leaf";
  return "text";
}
