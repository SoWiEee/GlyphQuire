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
const DEFINITIONS = new WeakMap<BlockRegistry, Map<string, BlockDefinition>>();

function definitionsFor(registry: BlockRegistry): Map<string, BlockDefinition> {
  const definitions = DEFINITIONS.get(registry);
  if (definitions === undefined) {
    throw new Error("Block registry is not initialized.");
  }
  return definitions;
}

function insertDefinition(
  definitions: Map<string, BlockDefinition>,
  definition: BlockDefinition,
  allowReserved: boolean,
): void {
  const name = definition.name;
  if (!allowReserved && isReservedName(name)) {
    throw new Error(`Block "${name}" is reserved for built-in definitions.`);
  }
  if (allowReserved && !isReservedName(name)) {
    throw new Error(`Block "${name}" is not a reserved built-in definition.`);
  }
  if (definitions.has(name)) {
    throw new Error(`Block "${name}" is already registered.`);
  }

  const snapshot: BlockDefinition = {
    name,
    version: definition.version,
    kind: definition.kind,
    schema: definition.schema,
    capabilities: [...definition.capabilities],
    fromDirective: definition.fromDirective,
    toDirective: definition.toDirective,
  };
  Object.freeze(snapshot.capabilities);
  Object.freeze(snapshot);
  definitions.set(name, snapshot);
}

export class BlockRegistry {
  constructor() {
    DEFINITIONS.set(this, new Map());
  }

  register(definition: BlockDefinition): void {
    insertDefinition(definitionsFor(this), definition, false);
  }

  get(name: string): BlockDefinition | undefined {
    return definitionsFor(this).get(name);
  }

  has(name: string): boolean {
    return definitionsFor(this).has(name);
  }
}

export function registerBuiltin(
  registry: BlockRegistry,
  definition: BlockDefinition,
): void {
  insertDefinition(definitionsFor(registry), definition, true);
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
