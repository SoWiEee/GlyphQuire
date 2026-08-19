import type { ZodType } from "zod";
import type {
  ContainerDirective,
  LeafDirective,
  TextDirective,
} from "mdast-util-directive";
import type { RootContent } from "mdast";
import type { BlockNode } from "../ast/nodes.js";
import type { DocumentDiagnostic } from "../validation/diagnostics.js";

export type BlockCapability =
  | "static"
  | "interactive-ui"
  | "sandbox-runtime"
  | "network-request";

export type DirectiveMdastNode =
  | ContainerDirective
  | LeafDirective
  | TextDirective;

export interface TransformContext {
  /** Transform a list of MDAST block children into semantic block nodes. */
  transformChildren(children: RootContent[]): BlockNode[];
  addDiagnostic(diagnostic: DocumentDiagnostic): void;
}

export interface SerializeContext {
  /** Serialize semantic block children back into MDAST content. */
  serializeChildren(children: BlockNode[]): RootContent[];
}

export interface BlockDefinition<TNode extends BlockNode = BlockNode> {
  name: string;
  version: number;
  kind: "container" | "leaf" | "text";
  schema: ZodType;
  capabilities: BlockCapability[];
  fromDirective(node: DirectiveMdastNode, context: TransformContext): TNode;
  toDirective(node: TNode, context: SerializeContext): DirectiveMdastNode;
}
