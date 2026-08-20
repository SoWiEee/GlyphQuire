import type { NotebookDocument } from "../ast/nodes.js";
import type { BlockRegistry } from "../registry/registry.js";
import { createRegistry } from "../registry/builtins.js";
import { parseToMdast } from "./mdast.js";
import { extractSpecVersion } from "./frontmatter.js";
import { transformRoot } from "./transform.js";
import { validateDocument } from "../validation/validate.js";
import { CURRENT_SPEC_VERSION } from "../migration/migrate.js";
import { diagnostic, DIAGNOSTIC_CODES, type DocumentDiagnostic } from "../validation/diagnostics.js";

export interface ParseResult {
  document: NotebookDocument;
  diagnostics: DocumentDiagnostic[];
  specVersion: number | null;
}

export function parse(markdown: string, registry: BlockRegistry = createRegistry()): ParseResult {
  const diagnostics: DocumentDiagnostic[] = [];
  const add = (d: DocumentDiagnostic) => diagnostics.push(d);

  const tree = parseToMdast(markdown);
  const versionInfo = extractSpecVersion(tree);
  diagnostics.push(...versionInfo.diagnostics);

  if (versionInfo.version !== null && versionInfo.version > CURRENT_SPEC_VERSION) {
    add(diagnostic(DIAGNOSTIC_CODES.UNSUPPORTED_SPEC_VERSION, "error", `Spec version ${versionInfo.version} is newer than supported (${CURRENT_SPEC_VERSION}).`));
  }

  const children = transformRoot(tree, registry, add);
  const document: NotebookDocument = { type: "document", specVersion: 1, children };
  diagnostics.push(...validateDocument(document).diagnostics);

  return { document, diagnostics, specVersion: versionInfo.version };
}

/** Legacy import: caller asserts a version; the original input is preserved in diagnostics context. */
export function importLegacy(markdown: string, assumedVersion: number, registry: BlockRegistry = createRegistry()): ParseResult {
  const result = parse(markdown, registry);
  return { ...result, specVersion: result.specVersion ?? assumedVersion };
}
