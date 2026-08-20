import type { Root, Yaml } from "mdast";
import { parse as parseYaml } from "yaml";
import {
  diagnostic,
  DIAGNOSTIC_CODES,
  type DocumentDiagnostic,
} from "../validation/diagnostics.js";

const SPEC_FIELD = "glyphquire-spec";

export function extractSpecVersion(tree: Root): {
  version: number | null;
  diagnostics: DocumentDiagnostic[];
} {
  const yamlNode = tree.children.find((c): c is Yaml => c.type === "yaml");
  if (!yamlNode) {
    return {
      version: null,
      diagnostics: [
        diagnostic(
          DIAGNOSTIC_CODES.SPEC_VERSION_MISSING,
          "warning",
          `Missing required frontmatter field "${SPEC_FIELD}".`,
        ),
      ],
    };
  }

  let data: unknown;
  try {
    data = parseYaml(yamlNode.value);
  } catch {
    return {
      version: null,
      diagnostics: [
        diagnostic(
          DIAGNOSTIC_CODES.SPEC_VERSION_INVALID,
          "error",
          "Frontmatter is not valid YAML.",
        ),
      ],
    };
  }

  const raw =
    data && typeof data === "object"
      ? (data as Record<string, unknown>)[SPEC_FIELD]
      : undefined;

  if (raw === undefined) {
    return {
      version: null,
      diagnostics: [
        diagnostic(
          DIAGNOSTIC_CODES.SPEC_VERSION_MISSING,
          "warning",
          `Missing required frontmatter field "${SPEC_FIELD}".`,
        ),
      ],
    };
  }

  if (typeof raw !== "number" || !Number.isInteger(raw) || raw <= 0) {
    return {
      version: null,
      diagnostics: [
        diagnostic(
          DIAGNOSTIC_CODES.SPEC_VERSION_INVALID,
          "error",
          `"${SPEC_FIELD}" must be a positive integer, received ${JSON.stringify(raw)}.`,
        ),
      ],
    };
  }

  return { version: raw, diagnostics: [] };
}
