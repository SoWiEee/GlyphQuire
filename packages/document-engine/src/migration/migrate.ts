import { diagnostic, DIAGNOSTIC_CODES } from "../validation/diagnostics.js";
import type { Migration, MigrationResult } from "./types.js";

export const CURRENT_SPEC_VERSION = 1;

/** Future version-to-version steps register here. v0.1 ships none (identity only). */
const MIGRATIONS: Migration[] = [];

function isPositiveInteger(n: number): boolean {
  return Number.isInteger(n) && n > 0;
}

export function migrateDocument(markdown: string, from: number, to: number): MigrationResult {
  const base: Omit<MigrationResult, "ok" | "diagnostics"> = {
    markdown,
    fromVersion: from,
    toVersion: to,
  };

  if (!isPositiveInteger(from) || !isPositiveInteger(to)) {
    return {
      ...base,
      ok: false,
      diagnostics: [
        diagnostic(
          DIAGNOSTIC_CODES.SPEC_VERSION_INVALID,
          "error",
          "Migration versions must be positive integers.",
        ),
      ],
    };
  }

  if (to > CURRENT_SPEC_VERSION || from > CURRENT_SPEC_VERSION) {
    return {
      ...base,
      ok: false,
      diagnostics: [
        diagnostic(
          DIAGNOSTIC_CODES.UNSUPPORTED_SPEC_VERSION,
          "error",
          `Spec version ${Math.max(from, to)} is not supported (current is ${CURRENT_SPEC_VERSION}).`,
        ),
      ],
    };
  }

  if (from === to) {
    return { ...base, ok: true, diagnostics: [] };
  }

  // Build a forward chain. v0.1 has no registered steps beyond identity.
  const diagnostics = [] as MigrationResult["diagnostics"];
  let current = markdown;
  let snapshot: string | undefined;
  for (let v = from; v < to; v++) {
    const step = MIGRATIONS.find((m) => m.from === v && m.to === v + 1);
    if (!step) {
      return {
        ...base,
        ok: false,
        diagnostics: [
          diagnostic(
            DIAGNOSTIC_CODES.UNSUPPORTED_SPEC_VERSION,
            "error",
            `No migration path from ${v} to ${v + 1}.`,
          ),
        ],
      };
    }
    const applied = step.apply(current);
    if (applied.destructive && snapshot === undefined) snapshot = markdown;
    diagnostics.push(...applied.diagnostics);
    current = applied.markdown;
  }

  const result: MigrationResult = { ...base, markdown: current, ok: true, diagnostics };
  if (snapshot !== undefined) result.snapshot = snapshot;
  return result;
}
