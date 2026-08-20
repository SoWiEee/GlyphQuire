import type { Root, RootContent, Yaml, Image } from "mdast";
import type { ContainerDirective } from "mdast-util-directive";
import type { BlockRegistry } from "../registry/registry.js";
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
      // Safe structural narrowing: serializeBlocks returns valid BlockContent
      // for a blockquote's children; `never` only bypasses mdast's overly
      // narrow declared child type, it does not mask an impossible case.
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
          // Safe structural narrowing (see blockquote case above), not an
          // impossible case.
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
      // Safe structural narrowing (see blockquote case above), not an
      // impossible case.
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
  // Assumes container-kind: InvalidBlockNode has no `directiveType` field,
  // so this always rebuilds a containerDirective. That is correct for every
  // v0.1 built-in (all kind:"container"); leaf/text directives and custom
  // blocks are deferred, so this will need revisiting once they exist.
  return { type: "containerDirective", name: node.originalType, attributes: node.attributes, children: serializeBlocks(node.children, registry, context) as ContainerDirective["children"] };
}

function serializeDirectiveBlock(node: BlockNode, registry: BlockRegistry, context: SerializeContext): RootContent {
  const name = node.type === "runtime" ? node.runtime : node.type;
  const def = registry.get(name);
  if (!def) {
    // Caller contract violation: the registry passed to serialize/
    // documentToMdast must contain every block type present in the
    // document. Silently dropping the node here would be silent data loss;
    // there is no "serialize never throws" invariant (unlike parse), so
    // surface the problem loudly instead.
    throw new Error(
      `Cannot serialize block "${name}": no definition registered. The registry passed to serialize/documentToMdast must contain every block type present in the document.`,
    );
  }
  return def.toDirective(node, context) as unknown as RootContent;
}
