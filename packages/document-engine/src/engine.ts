import type { NotebookDocument } from "./ast/nodes.js";
import type { BlockRegistry } from "./registry/registry.js";
import { createRegistry } from "./registry/builtins.js";
import { parse, importLegacy, type ParseResult } from "./parser/index.js";
import { serialize } from "./serializer/index.js";
import { validateDocument, type ValidationResult } from "./validation/validate.js";
import { extractText } from "./text/extract.js";
import { migrateDocument } from "./migration/migrate.js";
import type { MigrationResult } from "./migration/types.js";

export interface DocumentEngine {
  parse(markdown: string): ParseResult;
  importLegacy(markdown: string, assumedVersion: number): ParseResult;
  validate(document: NotebookDocument): ValidationResult;
  serialize(document: NotebookDocument): string;
  migrate(markdown: string, from: number, to: number): MigrationResult;
  extractText(document: NotebookDocument): string;
}

export function createDocumentEngine(registry: BlockRegistry = createRegistry()): DocumentEngine {
  return {
    parse: (markdown) => parse(markdown, registry),
    importLegacy: (markdown, assumedVersion) => importLegacy(markdown, assumedVersion, registry),
    validate: (document) => validateDocument(document),
    serialize: (document) => serialize(document, registry),
    migrate: (markdown, from, to) => migrateDocument(markdown, from, to),
    extractText: (document) => extractText(document),
  };
}
