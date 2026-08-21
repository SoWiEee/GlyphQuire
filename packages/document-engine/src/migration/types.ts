import type { DocumentDiagnostic } from "../validation/diagnostics.js";

export interface MigrationResult {
  markdown: string;
  ok: boolean;
  fromVersion: number;
  toVersion: number;
  diagnostics: DocumentDiagnostic[];
  snapshot?: string;
}

export interface Migration {
  from: number;
  to: number;
  apply(markdown: string): {
    markdown: string;
    diagnostics: DocumentDiagnostic[];
    destructive: boolean;
  };
}
