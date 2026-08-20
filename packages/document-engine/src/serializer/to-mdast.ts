import type { Root, RootContent, Yaml, Image, PhrasingContent } from "mdast";
import type { ContainerDirective } from "mdast-util-directive";
import { BlockRegistry } from "../registry/registry.js";
import type { SerializeContext } from "../registry/types.js";
import type { BlockNode, NotebookDocument } from "../ast/nodes.js";

export function documentToMdast(document: NotebookDocument, registry: BlockRegistry): Root {
  const context: SerializeContext = { serializeChildren: (children) => serializeBlocks(children, registry) };
  const frontmatter: Yaml = { type: "yaml", value: `glyphquire-spec: ${document.specVersion}` };
  return { type: "root", children: [frontmatter, ...serializeBlocks(document.children, registry, context)] };
}

function serializeBlocks(nodes: BlockNode[], registry: BlockRegistry, shared?: SerializeContext): RootContent[] {
  const context: SerializeContext = shared ?? { serializeChildren: (children) => serializeBlocks(children, registry) };
  const out: RootContent[] = [];
  for (const node of nodes) out.push(serializeBlock(node, registry, context));
  return out;
}

function serializeBlock(node: BlockNode, registry: BlockRegistry, context: SerializeContext): RootContent {
  switch (node.type) {
    case "paragraph":
      return { type: "paragraph", children: node.children };
    case "heading":
      return { type: "heading", depth: node.depth, children: node.children };
    case "quote":
      return { type: "blockquote", children: serializeBlocks(node.children, registry, context) as never };
    case "list":
      return {
        type: "list",
        ordered: node.ordered,
        ...(node.start !== undefined ? { start: node.start } : {}),
        spread: node.spread,
        children: node.children.map((item) => ({
          type: "listItem" as const,
          ...(item.checked !== undefined ? { checked: item.checked } : {}),
          spread: item.spread,
          children: serializeBlocks(item.children, registry, context) as never,
        })),
      };
    case "code":
      return { type: "code", ...(node.lang ? { lang: node.lang } : {}), ...(node.meta ? { meta: node.meta } : {}), value: node.value };
    case "table":
      return {
        type: "table",
        align: node.align,
        children: node.children.map((row) => ({
          type: "tableRow" as const,
          children: row.children.map((cell) => ({ type: "tableCell" as const, children: cell.children })),
        })),
      };
    case "image": {
      const img: Image = { type: "image", url: node.url };
      if (node.alt) img.alt = node.alt;
      if (node.title) img.title = node.title;
      return { type: "paragraph", children: [img] };
    }
    case "thematicBreak":
      return { type: "thematicBreak" };
    case "footnoteDefinition":
      return { type: "footnoteDefinition", identifier: node.identifier, ...(node.label ? { label: node.label } : {}), children: serializeBlocks(node.children, registry, context) as never };
    case "definition":
      return { type: "definition", identifier: node.identifier, ...(node.label ? { label: node.label } : {}), url: node.url, ...(node.title ? { title: node.title } : {}) };
    case "unknown-directive":
      return { type: "containerDirective", name: node.name, attributes: node.attributes, children: serializeBlocks(node.children, registry, context) as ContainerDirective["children"] };
    case "invalid-block":
      return serializeInvalid(node, registry, context);
    default:
      return serializeDirectiveBlock(node, registry, context);
  }
}

function serializeInvalid(node: Extract<BlockNode, { type: "invalid-block" }>, registry: BlockRegistry, context: SerializeContext): RootContent {
  if (node.originalType === "html" && node.source !== undefined) {
    return { type: "html", value: node.source };
  }
  // Re-emit as its original directive with preserved attributes (§15.2).
  return { type: "containerDirective", name: node.originalType, attributes: node.attributes, children: serializeBlocks(node.children, registry, context) as ContainerDirective["children"] };
}

function serializeDirectiveBlock(node: BlockNode, registry: BlockRegistry, context: SerializeContext): RootContent {
  const name = node.type === "runtime" ? node.runtime : node.type;
  const def = registry.get(name);
  if (!def) {
    // Should not happen for built-ins; fall back to an empty paragraph to avoid data loss of siblings.
    return { type: "paragraph", children: [] as PhrasingContent[] };
  }
  return def.toDirective(node, context) as unknown as RootContent;
}
