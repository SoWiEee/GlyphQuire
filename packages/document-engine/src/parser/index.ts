import type { NotebookDocument } from "../ast/nodes.js";
import type { BlockRegistry } from "../registry/registry.js";
import { createRegistry } from "../registry/builtins.js";
import { hasMalformedBlockDirective, parseMarkdown, type MdastParser } from "./mdast.js";
import type { Root } from "mdast";
import { extractSpecVersion } from "./frontmatter.js";
import { transformRoot } from "./transform.js";
import { validateDocument } from "../validation/validate.js";
import { CURRENT_SPEC_VERSION } from "../migration/migrate.js";
import {
  diagnostic,
  DIAGNOSTIC_CODES,
  type DocumentDiagnostic,
} from "../validation/diagnostics.js";

export interface AcceptedParseResult {
  ok: true;
  document: NotebookDocument;
  source: string;
  diagnostics: DocumentDiagnostic[];
  specVersion: number;
}

export interface RejectedParseResult {
  ok: false;
  document: null;
  source: string;
  diagnostics: DocumentDiagnostic[];
  specVersion: number | null;
}

export type ParseResult = AcceptedParseResult | RejectedParseResult;

function rejected(
  source: string,
  diagnostics: DocumentDiagnostic[],
  specVersion: number | null,
): RejectedParseResult {
  return { ok: false, document: null, source, diagnostics, specVersion };
}

function parseInternal(
  markdown: string,
  registry: BlockRegistry,
  parser: MdastParser,
  assumedVersion?: number,
): ParseResult {
  const diagnostics: DocumentDiagnostic[] = [];
  const add = (d: DocumentDiagnostic) => diagnostics.push(d);

  const parsed = parseMarkdown(markdown, parser);
  if (!parsed.ok) {
    add(
      diagnostic(
        DIAGNOSTIC_CODES.DIRECTIVE_SYNTAX_INVALID,
        "error",
        "Markdown could not be parsed safely.",
      ),
    );
    return rejected(markdown, diagnostics, null);
  }

  const tree: Root = parsed.tree;
  const versionInfo = extractSpecVersion(tree);
  diagnostics.push(...versionInfo.diagnostics);

  const hasMissingVersion = diagnostics.some(
    (item) => item.code === DIAGNOSTIC_CODES.SPEC_VERSION_MISSING,
  );
  const isLegacyImport = assumedVersion !== undefined && hasMissingVersion;
  if (versionInfo.version === null && !isLegacyImport) {
    return rejected(markdown, diagnostics, null);
  }

  if (isLegacyImport) {
    for (let index = diagnostics.length - 1; index >= 0; index -= 1) {
      if (diagnostics[index]?.code === DIAGNOSTIC_CODES.SPEC_VERSION_MISSING) {
        diagnostics.splice(index, 1);
      }
    }
  }

  const specVersion = versionInfo.version ?? assumedVersion ?? null;
  if (specVersion !== null && specVersion > CURRENT_SPEC_VERSION) {
    add(
      diagnostic(
        DIAGNOSTIC_CODES.UNSUPPORTED_SPEC_VERSION,
        "error",
        `Spec version ${specVersion} is newer than supported (${CURRENT_SPEC_VERSION}).`,
      ),
    );
    return rejected(markdown, diagnostics, specVersion);
  }

  if (hasMalformedBlockDirective(tree, markdown)) {
    add(
      diagnostic(
        DIAGNOSTIC_CODES.DIRECTIVE_SYNTAX_INVALID,
        "error",
        "A block directive attribute opener is missing its closing brace.",
      ),
    );
    return rejected(markdown, diagnostics, specVersion);
  }

  const children = transformRoot(tree, registry, add);
  // At this point the version is either an explicit supported marker or a
  // validated legacy assumption. The guard keeps the accepted result total.
  if (specVersion === null) return rejected(markdown, diagnostics, null);
  const document: NotebookDocument = { type: "document", specVersion: 1, children };
  diagnostics.push(...validateDocument(document).diagnostics);

  return { ok: true, document, source: markdown, diagnostics, specVersion };
}

export function parse(markdown: string, registry: BlockRegistry = createRegistry()): ParseResult {
  return parseInternal(markdown, registry, (source) => {
    const result = parseMarkdown(source);
    if (!result.ok) throw new Error("Markdown could not be parsed safely.");
    return result.tree;
  });
}

/** Internal seam used to exercise deterministic parser failure recovery. */
export function parseWithMdastParser(
  markdown: string,
  parser: MdastParser,
  registry: BlockRegistry = createRegistry(),
): ParseResult {
  return parseInternal(markdown, registry, parser);
}

function validateAssumedVersion(assumedVersion: number): DocumentDiagnostic | null {
  if (!Number.isInteger(assumedVersion) || assumedVersion <= 0) {
    return diagnostic(
      DIAGNOSTIC_CODES.SPEC_VERSION_INVALID,
      "error",
      `"glyphquire-spec" must be a positive integer, received ${JSON.stringify(assumedVersion)}.`,
    );
  }
  if (assumedVersion > CURRENT_SPEC_VERSION) {
    return diagnostic(
      DIAGNOSTIC_CODES.UNSUPPORTED_SPEC_VERSION,
      "error",
      `Spec version ${assumedVersion} is newer than supported (${CURRENT_SPEC_VERSION}).`,
    );
  }
  return null;
}

/** Legacy import: a validated caller version may replace a missing marker. */
export function importLegacy(
  markdown: string,
  assumedVersion: number,
  registry: BlockRegistry = createRegistry(),
): ParseResult {
  const versionError = validateAssumedVersion(assumedVersion);
  if (versionError) {
    return rejected(
      markdown,
      [versionError],
      versionError.code === DIAGNOSTIC_CODES.UNSUPPORTED_SPEC_VERSION ? assumedVersion : null,
    );
  }

  return parseInternal(
    markdown,
    registry,
    (source) => {
      const result = parseMarkdown(source);
      if (!result.ok) throw new Error("Markdown could not be parsed safely.");
      return result.tree;
    },
    assumedVersion,
  );
}
