import type { EditorSelection } from "../../editors/editor-session.types.js";
import type { WorkbenchCommand, ToolbarAction } from "./types.js";

export interface FormattedMarkdown {
  readonly markdown: string;
  readonly selection: EditorSelection;
}

function formatRange(value: string, action: ToolbarAction): string {
  if (action === "bold") {
    return value.startsWith("**") && value.endsWith("**")
      ? value.slice(2, -2)
      : `**${value || "text"}**`;
  }
  if (action === "italic") {
    return value.startsWith("*") && value.endsWith("*")
      ? value.slice(1, -1)
      : `*${value || "text"}*`;
  }
  if (action === "link")
    return value ? `[${value}](https://example.com)` : "[link](https://example.com)";
  const prefix = action === "heading" ? "## " : "- ";
  return value
    .split("\n")
    .map((line) => (line.startsWith(prefix) ? line.slice(prefix.length) : `${prefix}${line}`))
    .join("\n");
}

function lineStart(markdown: string, position: number): number {
  return Math.max(0, markdown.lastIndexOf("\n", Math.max(0, position) - 1) + 1);
}

function lineEnd(markdown: string, position: number): number {
  const end = markdown.indexOf("\n", position);
  return end === -1 ? markdown.length : end;
}

/**
 * Applies one toolbar operation using JavaScript/CodeMirror text offsets.
 * Line actions deliberately treat a selection ending at a newline as ending
 * on the preceding line, so an unrelated following paragraph is untouched.
 */
export function applyToolbarAction(
  markdown: string,
  action: ToolbarAction,
  selection: EditorSelection | null,
): FormattedMarkdown {
  const range = selection ?? { anchor: markdown.length, head: markdown.length };
  const selectedFrom = Math.min(range.anchor, range.head);
  const selectedTo = Math.max(range.anchor, range.head);
  const lineAction = action === "heading" || action === "bulletList";
  if (!lineAction) {
    const replacement = formatRange(markdown.slice(selectedFrom, selectedTo), action);
    return {
      markdown: `${markdown.slice(0, selectedFrom)}${replacement}${markdown.slice(selectedTo)}`,
      selection: { anchor: selectedFrom, head: selectedFrom + replacement.length },
    };
  }

  const from = lineStart(markdown, selectedFrom);
  const lastLinePosition =
    selectedTo > selectedFrom && selectedTo > 0 && markdown[selectedTo - 1] === "\n"
      ? selectedTo - 1
      : selectedTo;
  const to = lineEnd(markdown, lineStart(markdown, lastLinePosition));
  const replacement = formatRange(markdown.slice(from, to), action);
  return {
    markdown: `${markdown.slice(0, from)}${replacement}${markdown.slice(to)}`,
    selection: { anchor: from, head: from + replacement.length },
  };
}

export interface BlockCommandDefinition {
  readonly id: string;
  readonly label: string;
  readonly category: "block";
  readonly markdown: string;
  readonly cursorOffset: number;
}

export const BLOCK_COMMANDS = [
  { id: "insert-heading", label: "Heading", category: "block", markdown: "## ", cursorOffset: 3 },
  { id: "insert-list", label: "Bullet list", category: "block", markdown: "- ", cursorOffset: 2 },
  { id: "insert-quote", label: "Quote", category: "block", markdown: "> ", cursorOffset: 2 },
  {
    id: "insert-code",
    label: "Code block",
    category: "block",
    markdown: ["```", "", "```"].join(String.fromCharCode(10)),
    cursorOffset: 4,
  },
] as const satisfies readonly BlockCommandDefinition[];

export function materializeBlockCommand(
  definition: BlockCommandDefinition,
  onSelect: (definition: BlockCommandDefinition) => void,
): WorkbenchCommand {
  return { ...definition, run: () => onSelect(definition) };
}
