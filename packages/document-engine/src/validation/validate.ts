import type { NotebookDocument, BlockNode } from "../ast/nodes.js";
import { diagnostic, DIAGNOSTIC_CODES, type DocumentDiagnostic } from "./diagnostics.js";

export interface ValidationResult {
  valid: boolean;
  diagnostics: DocumentDiagnostic[];
}

export function validateDocument(document: NotebookDocument): ValidationResult {
  const diagnostics: DocumentDiagnostic[] = [];
  walk(document.children, diagnostics);
  return { valid: !diagnostics.some((d) => d.severity === "error"), diagnostics };
}

function walk(nodes: BlockNode[], diagnostics: DocumentDiagnostic[]): void {
  for (const node of nodes) {
    switch (node.type) {
      case "tabs":
        if (node.children.length === 0) {
          diagnostics.push(diagnostic(DIAGNOSTIC_CODES.INVALID_CHILD, "error", "tabs must contain at least one tab.", { block: "tabs" }));
        }
        for (const child of node.children) walk(child.children, diagnostics);
        break;
      case "columns":
        for (const child of node.children) walk(child.children, diagnostics);
        break;
      case "tab":
        diagnostics.push(diagnostic(DIAGNOSTIC_CODES.INVALID_PARENT, "error", "tab must be a direct child of tabs.", { block: "tab" }));
        walk(node.children, diagnostics);
        break;
      case "column":
        diagnostics.push(diagnostic(DIAGNOSTIC_CODES.INVALID_PARENT, "error", "column must be a direct child of columns.", { block: "column" }));
        walk(node.children, diagnostics);
        break;
      case "callout":
      case "sticky":
      case "toggle":
      case "quote":
      case "unknown-directive":
      case "invalid-block":
      case "footnoteDefinition":
        walk(node.children, diagnostics);
        break;
      case "list":
        for (const item of node.children) walk(item.children, diagnostics);
        break;
      default:
        break;
    }
  }
}
