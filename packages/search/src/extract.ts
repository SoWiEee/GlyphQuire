import { extractText, parse, type NotebookDocument } from "@glyphquire/document-engine";
import { MAX_SEARCH_TEXT_BYTES } from "@glyphquire/database";

export class SearchTextTooLargeError extends Error {
  constructor(field: string) {
    super(`SEARCH_TEXT_TOO_LARGE: ${field}`);
    this.name = "SearchTextTooLargeError";
  }
}

export interface ExtractedNoteText {
  title: string;
  headings: string[];
  body: string;
  tags: string[];
  normalizedText: string;
}

const utf8ByteLength = (value: string): number => new TextEncoder().encode(value).byteLength;

/** Duck-typed leaf/parent text collector over document-engine's mdast-derived inline nodes. */
function plainText(nodes: readonly unknown[]): string {
  const parts: string[] = [];
  for (const node of nodes) {
    if (!node || typeof node !== "object") continue;
    const value = (node as { value?: unknown }).value;
    if (typeof value === "string") parts.push(value);
    const children = (node as { children?: unknown }).children;
    if (Array.isArray(children)) parts.push(plainText(children));
  }
  return parts.join("");
}

/**
 * Walks the block tree collecting heading text in document order. Headings
 * only ever hold inline children, so recursion stops there; every other
 * block shape (quote, list, callout, table cells, columns, tabs, ...) is
 * walked uniformly via its own `children` array.
 */
function collectHeadings(node: unknown, out: string[]): void {
  if (!node || typeof node !== "object") return;
  const type = (node as { type?: unknown }).type;
  const children = (node as { children?: unknown }).children;
  if (type === "heading") {
    const text = plainText(Array.isArray(children) ? children : [])
      .replace(/\s+/gu, " ")
      .trim();
    if (text.length > 0) out.push(text);
    return;
  }
  if (Array.isArray(children)) {
    for (const child of children) collectHeadings(child, out);
  }
}

/** Unicode-safe normalization shared by indexing and querying: NFC, case-folded, whitespace-collapsed. */
export function normalizeSearchText(value: string): string {
  return value.normalize("NFC").toLowerCase().replace(/\s+/gu, " ").trim();
}

function assertWithinBound(field: string, value: string): void {
  if (utf8ByteLength(value) > MAX_SEARCH_TEXT_BYTES) {
    throw new SearchTextTooLargeError(field);
  }
}

/**
 * Extracts searchable fields from a note's canonical Markdown. Runtime
 * blocks and code are excluded (document-engine's extractText already
 * drops them); headings are additionally surfaced as their own list. There
 * is no document-level tag concept yet, so `tags` is always empty until a
 * future phase introduces one — the field exists so SearchableNote's shape
 * is stable across that addition.
 */
export function extractSearchableText(title: string, markdown: string): ExtractedNoteText {
  assertWithinBound("title", title);

  const result = parse(markdown);
  const document: NotebookDocument | null = result.ok ? result.document : null;

  const headings: string[] = [];
  if (document) {
    for (const node of document.children) collectHeadings(node, headings);
  }
  const headingsText = headings.join(" ");
  assertWithinBound("headings", headingsText);

  const body = document ? extractText(document) : "";
  assertWithinBound("body", body);

  const tags: string[] = [];

  const normalizedText = normalizeSearchText([title, headingsText, body].filter(Boolean).join(" "));
  assertWithinBound("normalizedText", normalizedText);

  return { title, headings, body, tags, normalizedText };
}
