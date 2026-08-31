import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, test } from "@playwright/test";
import {
  BROWSER_MATRIX_SCHEMA_VERSION,
  EXPECTED_BROWSER_TARGETS,
  validateBrowserMatrixEvidence,
} from "./phase6-browserstack.js";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const matrixPath = resolve(repositoryRoot, "configs/phase6-browser-matrix.json");
const evidencePath = resolve(repositoryRoot, "docs/evidence/phase6/browser-matrix.json");
const schemaPath = resolve(repositoryRoot, "docs/evidence/phase6/browser-matrix.schema.json");

type JsonRecord = Record<string, unknown>;

async function readJson(path: string): Promise<JsonRecord> {
  return JSON.parse(await readFile(path, "utf8")) as JsonRecord;
}

test.describe("Phase 6 browser matrix contract", () => {
  test("defines exactly eight latest/latest-1 provider targets", async () => {
    const matrix = await readJson(matrixPath);
    expect(matrix.schemaVersion).toBe(BROWSER_MATRIX_SCHEMA_VERSION);
    expect(matrix.provider).toBe("browserstack");
    expect(matrix.targets).toEqual(EXPECTED_BROWSER_TARGETS);
  });

  test("uses a strict schema and a scrubbed blocked instance when external evidence is absent", async () => {
    const schema = await readJson(schemaPath);
    const evidence = await readJson(evidencePath);

    expect(schema.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
    expect(schema.additionalProperties).toBe(false);
    expect(validateBrowserMatrixEvidence(evidence)).toEqual({ valid: true, errors: [] });
    expect(evidence.status).toBe("blocked");
    expect(evidence.externalEvidenceAvailable).toBe(false);

    const serialized = JSON.stringify(evidence);
    expect(serialized).not.toMatch(/password|accessKey|username|cookie|token|diagnostic|https?:/iu);
  });

  test("does not mistake local WebKit diagnostics for Safari provider evidence", async () => {
    const matrix = await readJson(matrixPath);
    const localProjectNames = new Set(["chromium", "msedge", "firefox", "webkit"]);
    const localConfig = await readFile(resolve(repositoryRoot, "playwright.config.ts"), "utf8");

    expect(localProjectNames.size).toBe(4);
    expect(localConfig).toMatch(/name:\s*["']chromium["']/u);
    expect(localConfig).toMatch(/name:\s*["']msedge["']/u);
    expect(localConfig).toMatch(/name:\s*["']firefox["']/u);
    expect(localConfig).toMatch(/name:\s*["']webkit["']/u);
    expect(localConfig).toMatch(/WebKit diagnostic only/u);
    expect(matrix.preflight.allowWebKitSubstitution).toBe(false);
    expect(JSON.stringify(matrix)).toMatch(/Safari/u);
  });

  test("runs the core shell smoke through the selected local browser", async ({ page }) => {
    await page.goto("/");
    await expect(page).toHaveTitle(/GlyphQuire/i);
  });
});
