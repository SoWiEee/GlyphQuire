export const DOCUMENT_ENGINE_PACKAGE = "@glyphquire/document-engine";

export * from "./ast/index.js";
export * from "./validation/index.js";
export * from "./registry/index.js";
export { parse, importLegacy, type ParseResult } from "./parser/index.js";
export { serialize, documentToMdast, mdastToMarkdown } from "./serializer/index.js";
export { extractText } from "./text/extract.js";
export { migrateDocument, CURRENT_SPEC_VERSION } from "./migration/migrate.js";
export type { MigrationResult } from "./migration/types.js";
export { createDocumentEngine, type DocumentEngine } from "./engine.js";
