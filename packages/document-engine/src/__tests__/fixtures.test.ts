import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { createDocumentEngine, semanticNormalize } from "../index.js";

const engine = createDocumentEngine();
const fixturesRoot = fileURLToPath(new URL("../../tests/fixtures/", import.meta.url));

function fixtureCases(root: string): string[] {
  const cases: string[] = [];
  for (const group of readdirSync(root)) {
    const groupDir = join(root, group);
    if (!statSync(groupDir).isDirectory()) continue;
    for (const name of readdirSync(groupDir)) {
      const caseDir = join(groupDir, name);
      if (statSync(caseDir).isDirectory() && existsSync(join(caseDir, "input.md"))) {
        cases.push(caseDir);
      }
    }
  }
  return cases;
}

describe("golden fixtures", () => {
  for (const caseDir of fixtureCases(fixturesRoot)) {
    const label = caseDir.slice(fixturesRoot.length);
    it(`matches expected AST, diagnostics, and markdown: ${label}`, () => {
      const input = readFileSync(join(caseDir, "input.md"), "utf8");
      const result = engine.parse(input);

      const diagnosticsPath = join(caseDir, "expected.diagnostics.json");
      if (existsSync(diagnosticsPath)) {
        const expectedCodes = JSON.parse(readFileSync(diagnosticsPath, "utf8")) as string[];
        expect(result.diagnostics.map((item) => item.code)).toEqual(expectedCodes);
      }

      if (!result.ok) {
        expect(result.document).toBeNull();
        expect(result.source).toBe(input);

        const astPath = join(caseDir, "expected.ast.json");
        if (existsSync(astPath)) {
          expect(JSON.parse(readFileSync(astPath, "utf8"))).toBeNull();
        }

        const mdPath = join(caseDir, "expected.md");
        expect(existsSync(mdPath)).toBe(false);
        return;
      }

      const astPath = join(caseDir, "expected.ast.json");
      if (existsSync(astPath)) {
        const expected = JSON.parse(readFileSync(astPath, "utf8"));
        expect(semanticNormalize(result.document)).toEqual(semanticNormalize(expected));
      }

      const mdPath = join(caseDir, "expected.md");
      if (existsSync(mdPath)) {
        const expectedMd = readFileSync(mdPath, "utf8");
        expect(engine.serialize(result.document)).toBe(expectedMd);
      }
    });
  }
});
