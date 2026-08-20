import type { NotebookDocument } from "./nodes.js";

/**
 * Produce a canonical comparison form of a document. Deep-clones, drops
 * undefined-valued properties, and sorts object keys so structurally-equal
 * documents compare equal regardless of property insertion order.
 * Formatting is not semantic (MARKDOWN_SPEC.md §35/§36).
 */
export function semanticNormalize(document: NotebookDocument): NotebookDocument {
  return canonical(document) as NotebookDocument;
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => canonical(item));
  }
  if (value !== null && typeof value === "object") {
    const source = value as Record<string, unknown>;
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      if (key === "position") continue;
      const child = source[key];
      if (child === undefined) continue;
      result[key] = canonical(child);
    }
    return result;
  }
  return value;
}
