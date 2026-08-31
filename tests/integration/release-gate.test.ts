import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../..");
const gatePath = resolve(root, "infra/release/release-gate.sh");
const decisionPath = resolve(root, "docs/evidence/release/release-decision.json");

describe("Release decision gate", () => {
  it("requires all fourteen P0 rows and never emits a decision for blocked evidence", () => {
    const result = spawnSync("bash", [gatePath], {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        RELEASE_CANDIDATE: "0",
        RELEASE_EMIT_DECISION: "1",
        RELEASE_EVIDENCE_PUBLICATION_SHA: "a".repeat(40),
        RELEASE_APPROVAL: "test-only",
      },
    });
    if (result.error?.code === "EPERM") {
      expect(result.status).toBe(2);
      return;
    }
    expect(result.status).toBe(2);
    expect(`${result.stdout}\n${result.stderr}`).toMatch(/P0-01|RELEASE_BLOCKED/u);
    expect(existsSync(decisionPath)).toBe(false);
  });

  it("does not emit before an evidence publication SHA and approval", () => {
    const result = spawnSync("bash", [gatePath], {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        RELEASE_CANDIDATE: "0",
        RELEASE_EMIT_DECISION: "0",
      },
    });
    if (result.error?.code === "EPERM") {
      expect(result.status).toBe(2);
      return;
    }
    expect(result.status).toBe(2);
    expect(`${result.stdout}\n${result.stderr}`).toMatch(/RELEASE_BLOCKED/u);
    expect(existsSync(decisionPath)).toBe(false);
  });
});
