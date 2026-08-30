import { createDocumentEngine, type NotebookDocument } from "@glyphquire/document-engine";

const documentEngine = createDocumentEngine();

export interface ExportDocumentSource {
  id: string;
  title: string;
  revision: number;
  schemaVersion: number;
  contentMarkdown: string;
}

export function orderedExportSources(
  sources: readonly ExportDocumentSource[],
): ExportDocumentSource[] {
  return [...sources].sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
}

export function parseExportDocument(source: ExportDocumentSource): NotebookDocument {
  const parsed = documentEngine.parse(source.contentMarkdown);
  if (
    !parsed.ok ||
    parsed.specVersion !== source.schemaVersion ||
    parsed.document.specVersion !== source.schemaVersion
  ) {
    throw new Error("EXPORT_FAILED");
  }
  return parsed.document;
}

function normalizedText(document: NotebookDocument): string {
  return documentEngine
    .extractText(document)
    .replaceAll("\r\n", "\n")
    .replaceAll("\r", "\n")
    .split("\n")
    .map((line) => line.replace(/[\t ]+$/u, ""))
    .join("\n")
    .trim();
}

export function formatPlainText(sources: readonly ExportDocumentSource[]): Buffer {
  const text = orderedExportSources(sources)
    .map((source) => normalizedText(parseExportDocument(source)))
    .filter((value) => value.length > 0)
    .join("\n\n");
  return Buffer.from(text.length === 0 ? "" : `${text}\n`, "utf8");
}
