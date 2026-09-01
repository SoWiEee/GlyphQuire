import type { ZodType } from "zod";
import type { ContainerDirective, LeafDirective, TextDirective } from "mdast-util-directive";
import type { RootContent } from "mdast";
import type { BlockNode, ValidationIssue } from "../ast/nodes.js";
import type { DocumentDiagnostic } from "../validation/diagnostics.js";

export type BlockCapability = "static" | "interactive-ui" | "sandbox-runtime" | "network-request";
export type DeclarativeBlockCapability = "static" | "interactive-ui";

export type DirectiveMdastNode = ContainerDirective | LeafDirective | TextDirective;

export interface TransformContext {
  /** Transform a list of MDAST block children into semantic block nodes. */
  transformChildren(children: RootContent[]): BlockNode[];
  addDiagnostic(diagnostic: DocumentDiagnostic): void;
}

/**
 * Signals a recoverable domain-shape violation after children have already
 * been transformed. The generic transformer can retain both the issue and
 * every child without running child transformation a second time.
 */
export class BlockValidationError extends Error {
  readonly issues: ValidationIssue[];
  readonly children: BlockNode[];

  constructor(issues: ValidationIssue[], children: BlockNode[]) {
    super(issues[0]?.message ?? "Block validation failed.");
    this.name = "BlockValidationError";
    this.issues = issues;
    this.children = children;
  }
}

export interface SerializeContext {
  /** Serialize semantic block children back into MDAST content. */
  serializeChildren(children: BlockNode[]): RootContent[];
}

export interface BlockDefinition<TNode extends BlockNode = BlockNode> {
  readonly name: string;
  readonly version: number;
  readonly kind: "container" | "leaf" | "text";
  readonly schema: ZodType;
  readonly capabilities: readonly BlockCapability[];
  readonly fromDirective: {
    bivarianceHack(node: DirectiveMdastNode, context: TransformContext): TNode;
  }["bivarianceHack"];
  readonly toDirective: {
    bivarianceHack(node: TNode, context: SerializeContext): DirectiveMdastNode;
  }["bivarianceHack"];
}
