import { describe, it, expect } from "vitest";
import {
  readFileSync,
  readdirSync,
  existsSync,
  statSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { createDocumentEngine, semanticNormalize, type ParseResult } from "../index.js";

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

function fixtureLabel(caseDir: string): string {
  return caseDir.startsWith(fixturesRoot) ? caseDir.slice(fixturesRoot.length) : caseDir;
}

function assertFixtureResult(caseDir: string, input: string, result: ParseResult): void {
  const label = fixtureLabel(caseDir);
  const diagnosticsPath = join(caseDir, "expected.diagnostics.json");
  if (existsSync(diagnosticsPath)) {
    const expectedCodes = JSON.parse(readFileSync(diagnosticsPath, "utf8")) as string[];
    expect(result.diagnostics.map((item) => item.code)).toEqual(expectedCodes);
  }

  const astPath = join(caseDir, "expected.ast.json");
  const mdPath = join(caseDir, "expected.md");

  if (!result.ok) {
    if (!existsSync(astPath)) {
      throw new Error(`Rejected fixture ${label} is missing expected.ast.json (expected null).`);
    }
    expect(JSON.parse(readFileSync(astPath, "utf8"))).toBeNull();
    expect(result.document).toBeNull();
    expect(result.source).toBe(input);
    expect(existsSync(mdPath)).toBe(false);
    return;
  }

  if (!existsSync(astPath)) {
    throw new Error(`Accepted fixture ${label} is missing expected.ast.json.`);
  }
  if (!existsSync(mdPath)) {
    throw new Error(`Accepted fixture ${label} is missing expected.md.`);
  }

  const expected = JSON.parse(readFileSync(astPath, "utf8"));
  expect(semanticNormalize(result.document)).toEqual(semanticNormalize(expected));

  const expectedMd = readFileSync(mdPath, "utf8");
  expect(engine.serialize(result.document)).toBe(expectedMd);
}

describe("golden fixtures", () => {
  for (const caseDir of fixtureCases(fixturesRoot)) {
    const label = fixtureLabel(caseDir);
    it(`matches expected AST, diagnostics, and markdown: ${label}`, () => {
      const input = readFileSync(join(caseDir, "input.md"), "utf8");
      const result = engine.parse(input);
      assertFixtureResult(caseDir, input, result);
    });
  }
});

describe("fixture contract", () => {
  it("requires AST and Markdown expectations for accepted fixtures", () => {
    const caseDir = mkdtempSync(join(tmpdir(), "glyphquire-fixture-contract-"));
    const input = "---\nglyphquire-spec: 1\n---\n\n# Contract sentinel\n";

    try {
      const result = engine.parse(input);
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("expected an accepted fixture result");

      expect(() => assertFixtureResult(caseDir, input, result)).toThrow(
        "missing expected.ast.json",
      );

      writeFileSync(join(caseDir, "expected.ast.json"), JSON.stringify(result.document));
      expect(() => assertFixtureResult(caseDir, input, result)).toThrow(
        "missing expected.md",
      );
    } finally {
      rmSync(caseDir, { recursive: true, force: true });
    }
  });
});
