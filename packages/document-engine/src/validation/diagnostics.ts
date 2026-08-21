export type DiagnosticSeverity = "info" | "warning" | "error";

export interface DocumentDiagnostic {
  code: string;
  severity: DiagnosticSeverity;
  message: string;
  range?: { from: number; to: number };
  block?: string;
  attribute?: string;
}

export const DIAGNOSTIC_CODES = {
  DIRECTIVE_UNKNOWN: "DIRECTIVE_UNKNOWN",
  DIRECTIVE_INVALID_NAME: "DIRECTIVE_INVALID_NAME",
  DIRECTIVE_KIND_MISMATCH: "DIRECTIVE_KIND_MISMATCH",
  DIRECTIVE_SYNTAX_INVALID: "DIRECTIVE_SYNTAX_INVALID",
  ATTRIBUTE_UNKNOWN: "ATTRIBUTE_UNKNOWN",
  ATTRIBUTE_INVALID_VALUE: "ATTRIBUTE_INVALID_VALUE",
  ATTRIBUTE_REQUIRED: "ATTRIBUTE_REQUIRED",
  INVALID_PARENT: "INVALID_PARENT",
  INVALID_CHILD: "INVALID_CHILD",
  UNSUPPORTED_SPEC_VERSION: "UNSUPPORTED_SPEC_VERSION",
  SPEC_VERSION_MISSING: "SPEC_VERSION_MISSING",
  SPEC_VERSION_INVALID: "SPEC_VERSION_INVALID",
  SPEC_VERSION_MISMATCH: "SPEC_VERSION_MISMATCH",
  RAW_HTML_DISABLED: "RAW_HTML_DISABLED",
} as const;

export type DiagnosticCode = (typeof DIAGNOSTIC_CODES)[keyof typeof DIAGNOSTIC_CODES];

export function diagnostic(
  code: string,
  severity: DiagnosticSeverity,
  message: string,
  extra?: Pick<DocumentDiagnostic, "range" | "block" | "attribute">,
): DocumentDiagnostic {
  const result: DocumentDiagnostic = { code, severity, message };
  if (extra?.range !== undefined) result.range = extra.range;
  if (extra?.block !== undefined) result.block = extra.block;
  if (extra?.attribute !== undefined) result.attribute = extra.attribute;
  return result;
}
