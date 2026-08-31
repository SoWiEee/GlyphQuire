import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../..");
const schemaPath = resolve(root, "docs/evidence/phase6/screen-reader-evidence.schema.json");
const gatePath = resolve(root, "infra/phase6/phase6-release-gate.sh");

describe("Phase 6 manual screen-reader evidence", () => {
  it("defines a strict schema for both required readers", async () => {
    const schema = JSON.parse(await readFile(schemaPath, "utf8")) as Record<string, unknown>;
    expect(schema.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
    expect(schema.additionalProperties).toBe(false);
    const properties = schema.properties as Record<string, unknown>;
    expect(properties.platform).toMatchObject({ enum: ["macOS", "Windows"] });
    expect(properties.screenReader).toMatchObject({ enum: ["VoiceOver", "NVDA"] });
    expect(schema.required as string[]).toEqual(
      expect.arrayContaining(["performer", "reviewer", "flow", "recording", "candidateSourceSha"]),
    );
  });

  it("does not treat placeholder recordings as manual evidence", async () => {
    const schema = JSON.parse(await readFile(schemaPath, "utf8")) as Record<string, unknown>;
    const recording = (schema.properties as Record<string, unknown>).recording as Record<
      string,
      unknown
    >;
    const reference = (recording.properties as Record<string, { pattern?: string }>).reference;
    expect(reference.pattern).toMatch(/placeholder/iu);
    expect(reference.pattern).toMatch(/sample/iu);
  });

  it("keeps the release gate blocked while manual captures are absent", () => {
    const result = spawnSync("bash", [gatePath], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, PHASE6_EMIT_DECISION: "0" },
    });
    if (result.error?.code === "EPERM") {
      // Some restricted test sandboxes disallow child-process creation; the
      // release workflow executes this same script directly.
      expect(result.status).toBe(2);
      return;
    }
    expect(result.status).toBe(2);
    expect(`${result.stdout}\n${result.stderr}`).toMatch(/PHASE6_RELEASE_BLOCKED/u);
    expect(existsSync(resolve(root, "docs/evidence/phase6/release-decision.json"))).toBe(false);
  });
});
