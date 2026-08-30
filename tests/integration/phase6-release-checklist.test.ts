import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, it } from "vitest";
import {
  phase6ChecklistSchema,
  phase6Gates,
  phase6ReleaseDecisionSchema,
} from "../../packages/shared/src/index.js";

type JsonSchema = {
  allOf?: JsonSchema[];
  contains?: JsonSchema;
  const?: string;
  items?: JsonSchema;
  maxContains?: number;
  maxItems?: number;
  minContains?: number;
  minItems?: number;
  properties?: Record<string, JsonSchema>;
  $defs?: Record<string, JsonSchema>;
  $ref?: string;
  type?: string;
};

type ReleaseRow = { gate: string; status: string };

const releaseDecisionSchema = JSON.parse(
  readFileSync(
    resolve(import.meta.dirname, "../../docs/evidence/phase6/release-decision.schema.json"),
    "utf8",
  ),
) as JsonSchema;

const validArtifactManifest = {
  candidateSourceSha: "a".repeat(40),
  lockfileSha256: "b".repeat(64),
  nodeVersion: "22.12.0",
  pnpmVersion: "9.15.9",
  migrationJournal: {
    "0000": "c".repeat(64),
    "0001": "c".repeat(64),
    "0002": "c".repeat(64),
    "0003": "c".repeat(64),
    "0004": "c".repeat(64),
    "0005": "c".repeat(64),
    "0006": "c".repeat(64),
    "0007": "c".repeat(64),
    "0008": "c".repeat(64),
    "0009": "c".repeat(64),
    "0010": "c".repeat(64),
    "0011": "c".repeat(64),
  },
  imageDigests: {
    api: `sha256:${"d".repeat(64)}`,
    web: `sha256:${"d".repeat(64)}`,
    worker: `sha256:${"d".repeat(64)}`,
  },
};

const validDecisionMetadata = {
  artifactManifest: validArtifactManifest,
  evidencePublicationSha: "e".repeat(40),
};

function acceptsRowsWithReleaseDecisionSchema(schema: JsonSchema, rows: ReleaseRow[]): boolean {
  const rowsSchema = schema.properties?.rows;
  const rowSchema = schema.$defs?.row;
  const status = rowSchema?.properties?.status?.const;
  const gateRules = rowsSchema?.allOf;

  if (
    rowsSchema?.type !== "array" ||
    rowSchema === undefined ||
    rowsSchema.minItems !== phase6Gates.length ||
    rowsSchema.maxItems !== phase6Gates.length ||
    rows.length < (rowsSchema.minItems ?? 0) ||
    rows.length > (rowsSchema.maxItems ?? Number.POSITIVE_INFINITY) ||
    status !== "passed" ||
    !rows.every((row) => row.status === status)
  )
    return false;

  if (gateRules === undefined) return true;

  const constrainedGates = gateRules.map((rule) => rule.contains?.properties?.gate?.const);
  if (
    gateRules.length !== phase6Gates.length ||
    new Set(constrainedGates).size !== phase6Gates.length ||
    phase6Gates.some((gate) => !constrainedGates.includes(gate))
  )
    return false;

  return gateRules.every((rule) => {
    const gate = rule.contains?.properties?.gate?.const;
    const count = rows.filter((row) => row.gate === gate).length;
    return (
      typeof gate === "string" &&
      rule.minContains === 1 &&
      rule.maxContains === 1 &&
      count >= rule.minContains &&
      count <= rule.maxContains
    );
  });
}

it("records blocked evidence but rejects it as a release decision", () => {
  expect(phase6ChecklistSchema.parse({ gate: "P0-08", status: "blocked" })).toMatchObject({
    status: "blocked",
  });
  expect(() =>
    phase6ReleaseDecisionSchema.parse({ rows: [{ gate: "P0-08", status: "blocked" }] }),
  ).toThrow();
});

it("rejects duplicate P0 gates in both release validators", () => {
  const duplicateRows = [
    ...phase6Gates.slice(0, -1).map((gate) => ({ gate, status: "passed" })),
    { gate: "P0-01", status: "passed" },
  ];
  const duplicateDecision = { ...validDecisionMetadata, rows: duplicateRows };

  expect(() => phase6ReleaseDecisionSchema.parse(duplicateDecision)).toThrow();
  expect(acceptsRowsWithReleaseDecisionSchema(releaseDecisionSchema, duplicateRows)).toBe(false);
});

it("accepts only passed rows in both release validators", () => {
  const blockedRows = phase6Gates.map((gate) => ({ gate, status: "blocked" }));
  const blockedDecision = { ...validDecisionMetadata, rows: blockedRows };

  expect(() => phase6ReleaseDecisionSchema.parse(blockedDecision)).toThrow();
  expect(acceptsRowsWithReleaseDecisionSchema(releaseDecisionSchema, blockedRows)).toBe(false);
});

it("keeps release decisions bound to the artifact manifest schema", () => {
  expect(releaseDecisionSchema.properties?.artifactManifest).toEqual({
    $ref: "artifact-manifest.schema.json",
  });
});
