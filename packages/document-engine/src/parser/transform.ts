import type {
  Root,
  RootContent,
  Paragraph,
  Heading,
  Blockquote,
  List,
  ListItem,
  Code,
  Table,
  Image,
  FootnoteDefinition,
  Definition,
  Html,
  PhrasingContent,
} from "mdast";
import type {
  ContainerDirective,
} from "mdast-util-directive";
import { ZodError } from "zod";
import type { TransformContext, DirectiveMdastNode } from "../registry/types.js";
import { readAttributes, directiveTypeOf, type BlockRegistry } from "../registry/registry.js";
import {
  diagnostic,
  DIAGNOSTIC_CODES,
  type DocumentDiagnostic,
} from "../validation/diagnostics.js";
import type {
  BlockNode,
  ImageNode,
  InvalidBlockNode,
  UnknownDirectiveNode,
  TableNode,
  TableRowNode,
  TableCellNode,
} from "../ast/nodes.js";

const DIRECTIVE_NAME_RE = /^[a-z][a-z0-9-]{0,63}$/;

export function transformRoot(
  tree: Root,
  registry: BlockRegistry,
  addDiagnostic: (d: DocumentDiagnostic) => void,
): BlockNode[] {
  const context: TransformContext = {
    transformChildren: (children) => transformNodes(children, registry, addDiagnostic),
    addDiagnostic,
  };
  return transformNodes(tree.children, registry, addDiagnostic, context);
}

function transformNodes(
  nodes: RootContent[],
  registry: BlockRegistry,
  addDiagnostic: (d: DocumentDiagnostic) => void,
  sharedContext?: TransformContext,
): BlockNode[] {
  const context: TransformContext =
    sharedContext ?? {
      transformChildren: (children) => transformNodes(children, registry, addDiagnostic),
      addDiagnostic,
    };
  const result: BlockNode[] = [];
  for (const node of nodes) {
    const mapped = transformNode(node, registry, context, addDiagnostic);
    if (mapped) result.push(mapped);
  }
  return result;
}

function transformNode(
  node: RootContent,
  registry: BlockRegistry,
  context: TransformContext,
  addDiagnostic: (d: DocumentDiagnostic) => void,
): BlockNode | null {
  switch (node.type) {
    case "yaml":
      return null; // consumed by frontmatter extraction
    case "paragraph":
      return transformParagraph(node);
    case "heading":
      return { type: "heading", depth: (node as Heading).depth, children: node.children as PhrasingContent[] };
    case "blockquote":
      return { type: "quote", children: context.transformChildren((node as Blockquote).children) };
    case "list":
      return transformList(node as List, context);
    case "code": {
      const code = node as Code;
      const out: BlockNode = { type: "code", value: code.value };
      if (code.lang) (out as { lang?: string }).lang = code.lang;
      if (code.meta) (out as { meta?: string }).meta = code.meta;
      return out;
    }
    case "table":
      return transformTable(node as Table);
    case "thematicBreak":
      return { type: "thematicBreak" };
    case "footnoteDefinition": {
      const fn = node as FootnoteDefinition;
      const out = { type: "footnoteDefinition", identifier: fn.identifier, children: context.transformChildren(fn.children) } as BlockNode;
      if (fn.label) (out as { label?: string }).label = fn.label;
      return out;
    }
    case "definition": {
      const def = node as Definition;
      const out = { type: "definition", identifier: def.identifier, url: def.url } as BlockNode;
      if (def.label) (out as { label?: string }).label = def.label;
      if (def.title) (out as { title?: string }).title = def.title;
      return out;
    }
    case "html":
      return transformHtml(node as Html, addDiagnostic);
    case "containerDirective":
    case "leafDirective":
    case "textDirective":
      return transformDirective(node as DirectiveMdastNode, registry, context, addDiagnostic);
    default:
      return null;
  }
}

function transformParagraph(node: Paragraph): BlockNode {
  // Lone image paragraph -> ImageNode (§27/§54)
  if (node.children.length === 1 && node.children[0]?.type === "image") {
    const img = node.children[0] as Image;
    const out: ImageNode = { type: "image", url: img.url };
    if (img.alt) out.alt = img.alt;
    if (img.title) out.title = img.title;
    return out;
  }
  return { type: "paragraph", children: node.children as PhrasingContent[] };
}

function transformList(node: List, context: TransformContext): BlockNode {
  const children = node.children.map((item: ListItem) => {
    const li = {
      type: "listItem" as const,
      spread: item.spread ?? false,
      children: context.transformChildren(item.children),
    };
    if (item.checked !== null && item.checked !== undefined) {
      (li as { checked?: boolean }).checked = item.checked;
    }
    return li;
  });
  const out = { type: "list" as const, ordered: node.ordered ?? false, spread: node.spread ?? false, children };
  if (node.start !== null && node.start !== undefined) (out as { start?: number }).start = node.start;
  return out;
}

function transformTable(node: Table): TableNode {
  const align = (node.align ?? []).map((a) => a ?? null);
  const rows: TableRowNode[] = node.children.map((row) => ({
    type: "tableRow",
    children: row.children.map((cell): TableCellNode => ({
      type: "tableCell",
      children: cell.children as PhrasingContent[],
    })),
  }));
  return { type: "table", align, children: rows };
}

function transformHtml(node: Html, addDiagnostic: (d: DocumentDiagnostic) => void): InvalidBlockNode {
  addDiagnostic(
    diagnostic(DIAGNOSTIC_CODES.RAW_HTML_DISABLED, "warning", "Raw HTML is disabled in v0.1."),
  );
  return { type: "invalid-block", originalType: "html", attributes: {}, errors: [{ code: DIAGNOSTIC_CODES.RAW_HTML_DISABLED, message: "Raw HTML is disabled." }], source: node.value, children: [] };
}

function transformDirective(
  node: DirectiveMdastNode,
  registry: BlockRegistry,
  context: TransformContext,
  addDiagnostic: (d: DocumentDiagnostic) => void,
): BlockNode {
  const name = node.name;
  const attributes = readAttributes(node);
  const kind = directiveTypeOf(node);

  // Transform children only in the fallback paths (unknown/invalid-name/
  // schema-invalid). The known-definition path lets `fromDirective` transform
  // its own children, so children are never transformed twice.
  const fallbackChildren = (): BlockNode[] =>
    node.type === "containerDirective"
      ? context.transformChildren((node as ContainerDirective).children)
      : [];

  if (!DIRECTIVE_NAME_RE.test(name)) {
    addDiagnostic(diagnostic(DIAGNOSTIC_CODES.DIRECTIVE_INVALID_NAME, "error", `Invalid directive name "${name}".`, { block: name }));
    return { type: "unknown-directive", directiveType: kind, name, attributes, children: fallbackChildren() } satisfies UnknownDirectiveNode;
  }

  const def = registry.get(name);
  if (!def) {
    addDiagnostic(diagnostic(DIAGNOSTIC_CODES.DIRECTIVE_UNKNOWN, "warning", `Unknown directive "${name}".`, { block: name }));
    return { type: "unknown-directive", directiveType: kind, name, attributes, children: fallbackChildren() } satisfies UnknownDirectiveNode;
  }

  try {
    return def.fromDirective(node, context);
  } catch (error) {
    const issues = error instanceof ZodError
      ? error.issues.map((i) => ({ code: DIAGNOSTIC_CODES.ATTRIBUTE_INVALID_VALUE, message: i.message, attribute: i.path.join(".") || undefined }))
      : [{ code: DIAGNOSTIC_CODES.ATTRIBUTE_INVALID_VALUE, message: String(error), attribute: undefined }];
    for (const issue of issues) {
      addDiagnostic(diagnostic(issue.code, "error", issue.message, { block: name, attribute: issue.attribute }));
    }
    const invalid: InvalidBlockNode = { type: "invalid-block", originalType: name, attributes, errors: issues, children: fallbackChildren() };
    return invalid;
  }
}
