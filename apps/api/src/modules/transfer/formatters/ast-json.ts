import { semanticNormalize } from "@glyphquire/document-engine";
import {
  orderedExportSources,
  parseExportDocument,
  type ExportDocumentSource,
} from "./plain-text.js";

const AST_EXPORT_SCHEMA_VERSION = 1;

export function formatAstJson(sources: readonly ExportDocumentSource[]): Buffer {
  const artifact = {
    notes: orderedExportSources(sources).map((source) => ({
      document: semanticNormalize(parseExportDocument(source)),
      id: source.id,
      revision: source.revision,
      schemaVersion: source.schemaVersion,
      title: source.title,
    })),
    schemaVersion: AST_EXPORT_SCHEMA_VERSION,
  };
  return Buffer.from(`${JSON.stringify(artifact, null, 2)}\n`, "utf8");
}
