import { toString as mdastToString } from "mdast-util-to-string";
import type {
  NotebookDocument,
  BlockNode,
  InlineContent,
} from "../ast/nodes.js";

/** Collect searchable text from a document (MARKDOWN_SPEC.md §43). */
export function extractText(document: NotebookDocument): string {
  const parts: string[] = [];
  collectBlocks(document.children, parts);
  return parts.filter((p) => p.length > 0).join("\n");
}

function collectInline(children: InlineContent[], parts: string[]): void {
  // Wrap in a paragraph (whose children are exactly PhrasingContent[]) so the
  // call is type-correct under strict mode.
  parts.push(mdastToString({ type: "paragraph", children }));
}

function collectBlocks(nodes: BlockNode[], parts: string[]): void {
  for (const node of nodes) {
    switch (node.type) {
      case "paragraph":
      case "heading":
        collectInline(node.children, parts);
        break;
      case "quote":
      case "column":
      case "footnoteDefinition":
        collectBlocks(node.children, parts);
        break;
      case "list":
      case "listItem":
        collectBlocks(node.children, parts);
        break;
      case "table":
        for (const row of node.children)
          for (const cell of row.children) collectInline(cell.children, parts);
        break;
      case "image":
        if (node.alt) parts.push(node.alt);
        break;
      case "callout":
      case "sticky":
        if (node.props.title) parts.push(node.props.title);
        collectBlocks(node.children, parts);
        break;
      case "toggle":
        parts.push(node.props.title);
        collectBlocks(node.children, parts);
        break;
      case "tabs":
        collectBlocks(node.children, parts);
        break;
      case "tab":
        parts.push(node.props.title);
        collectBlocks(node.children, parts);
        break;
      case "columns":
        collectBlocks(node.children, parts);
        break;
      case "unknown-directive":
      case "invalid-block":
        collectBlocks(node.children, parts);
        break;
      // code, thematicBreak, definition, runtime: excluded from search text
      case "code":
      case "thematicBreak":
      case "definition":
      case "runtime":
        break;
      default: {
        const _exhaustive: never = node;
        return _exhaustive;
      }
    }
  }
}
