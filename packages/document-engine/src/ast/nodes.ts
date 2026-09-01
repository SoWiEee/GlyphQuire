import type { PhrasingContent, AlignType } from "mdast";

/** Inline content is retained as MDAST phrasing content for v0.1. */
export type InlineContent = PhrasingContent;

export interface NotebookDocument {
  type: "document";
  specVersion: 1;
  children: BlockNode[];
}

// Some members (ListItemNode, TabNode, ColumnNode, etc.) are structural
// child-only nodes reachable only via specific parents, not arbitrary
// document children.
export type BlockNode =
  | ParagraphNode
  | HeadingNode
  | QuoteNode
  | ListNode
  | ListItemNode
  | CodeNode
  | TableNode
  | ImageNode
  | ThematicBreakNode
  | FootnoteDefinitionNode
  | DefinitionNode
  | CalloutNode
  | StickyNode
  | ToggleNode
  | TabsNode
  | TabNode
  | ColumnsNode
  | ColumnNode
  | RuntimeNode
  | CustomBlockNode
  | UnknownDirectiveNode
  | InvalidBlockNode;

export interface ParagraphNode {
  type: "paragraph";
  children: InlineContent[];
}

export interface HeadingNode {
  type: "heading";
  depth: 1 | 2 | 3 | 4 | 5 | 6;
  children: InlineContent[];
}

export interface QuoteNode {
  type: "quote";
  children: BlockNode[];
}

export interface ListNode {
  type: "list";
  ordered: boolean;
  start?: number;
  spread: boolean;
  children: ListItemNode[];
}

export interface ListItemNode {
  type: "listItem";
  checked?: boolean | null;
  spread: boolean;
  children: BlockNode[];
}

export interface CodeNode {
  type: "code";
  lang?: string;
  meta?: string;
  value: string;
}

export interface TableNode {
  type: "table";
  align: AlignType[];
  children: TableRowNode[];
}

export interface TableRowNode {
  type: "tableRow";
  children: TableCellNode[];
}

export interface TableCellNode {
  type: "tableCell";
  children: InlineContent[];
}

export interface ImageNode {
  type: "image";
  url: string;
  alt?: string;
  title?: string;
}

export interface ThematicBreakNode {
  type: "thematicBreak";
}

export interface FootnoteDefinitionNode {
  type: "footnoteDefinition";
  identifier: string;
  label?: string;
  children: BlockNode[];
}

export interface DefinitionNode {
  type: "definition";
  identifier: string;
  label?: string;
  url: string;
  title?: string;
}

export interface CalloutProps {
  type: "info" | "note" | "tip" | "warning" | "danger" | "success";
  title?: string;
  icon?: string;
}
export interface CalloutNode {
  type: "callout";
  version: 1;
  props: CalloutProps;
  children: BlockNode[];
}

export interface StickyProps {
  tone: "default" | "yellow" | "pink" | "blue" | "green";
  title?: string;
}
export interface StickyNode {
  type: "sticky";
  version: 1;
  props: StickyProps;
  children: BlockNode[];
}

export interface ToggleProps {
  title: string;
  open: boolean;
}
export interface ToggleNode {
  type: "toggle";
  version: 1;
  props: ToggleProps;
  children: BlockNode[];
}

export interface TabsNode {
  type: "tabs";
  version: 1;
  children: TabNode[];
}
export interface TabNode {
  type: "tab";
  version: 1;
  props: { title: string };
  children: BlockNode[];
}

export interface ColumnsProps {
  count: 2 | 3 | 4;
  gap?: "sm" | "md" | "lg";
}
export interface ColumnsNode {
  type: "columns";
  version: 1;
  props: ColumnsProps;
  children: ColumnNode[];
}
export interface ColumnNode {
  type: "column";
  version: 1;
  children: BlockNode[];
}

export interface RuntimeProps {
  height: number;
  network: string[];
  autoplay: boolean;
}
export interface RuntimeNode {
  type: "runtime";
  version: 1;
  runtime: "p5" | "canvas";
  props: RuntimeProps;
  source: string;
}

export type CustomBlockScalar = string | number | boolean;

export interface CustomBlockNode {
  type: "custom-block";
  name: string;
  version: number;
  attributes: Record<string, string>;
  props: Record<string, CustomBlockScalar>;
  children: BlockNode[];
  /** Optional authored source retained by importers that can provide it. */
  source?: string;
}

export interface UnknownDirectiveNode {
  type: "unknown-directive";
  directiveType: "container" | "leaf" | "text";
  name: string;
  attributes: Record<string, string>;
  /** Preserved raw markdown/source for round-trip (spec §14). */
  source?: string;
  children: BlockNode[];
}

export interface ValidationIssue {
  code: string;
  message: string;
  attribute?: string;
}

export interface InvalidBlockNode {
  type: "invalid-block";
  originalType: string;
  /** Directive kind when this invalid block came from a directive node. */
  directiveType?: "container" | "leaf" | "text";
  attributes: Record<string, string>;
  errors: ValidationIssue[];
  /** Preserved raw markdown/source for round-trip (e.g. raw HTML value). */
  source?: string;
  children: BlockNode[];
}
