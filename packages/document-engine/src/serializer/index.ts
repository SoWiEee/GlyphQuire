import type { NotebookDocument } from "../ast/nodes.js";
import type { BlockRegistry } from "../registry/registry.js";
import { createRegistry } from "../registry/builtins.js";
import { documentToMdast } from "./to-mdast.js";
import { mdastToMarkdown } from "./to-markdown.js";

export { documentToMdast } from "./to-mdast.js";
export { mdastToMarkdown } from "./to-markdown.js";

export function serialize(document: NotebookDocument, registry: BlockRegistry = createRegistry()): string {
  return mdastToMarkdown(documentToMdast(document, registry));
}
