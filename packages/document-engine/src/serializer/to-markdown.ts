import type { Root } from "mdast";
import { createProcessor } from "../parser/mdast.js";

/**
 * Serialize an MDAST tree to canonical Notebook Markdown. Uses the shared
 * unified processor (directive-aware) so directive fences and attributes are
 * emitted by the directive serializer, never string-concatenated
 * (MARKDOWN_SPEC.md §12/§34). The directive serializer chooses a fence length
 * that safely wraps nested directives (§13).
 */
export function mdastToMarkdown(tree: Root): string {
  const processor = createProcessor();
  const out = processor.stringify(tree);
  return out.endsWith("\n") ? out : `${out}\n`;
}
