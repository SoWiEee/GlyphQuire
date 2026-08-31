#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)"
export ROOT_DIR

# This gate is intentionally conservative. It validates the checked-in,
# sanitized evidence and refuses to emit a decision until an immutable
# candidate, publication SHA, and manual screen-reader captures are present.
node --input-type=module <<'NODE'
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const root = process.env.ROOT_DIR;
const requiredGates = Array.from({ length: 14 }, (_, index) => `P0-${String(index + 1).padStart(2, "0")}`);
const sha40 = /^[a-f0-9]{40}$/u;
const sha64 = /^[a-f0-9]{64}$/u;
const digest = /^sha256:[a-f0-9]{64}$/u;
const failures = [];

function fail(message) { failures.push(message); }
async function json(relative) {
  const path = resolve(root, relative);
  if (!existsSync(path)) { fail(`${relative} is missing`); return null; }
  try { return JSON.parse(await readFile(path, "utf8")); }
  catch { fail(`${relative} is not valid JSON`); return null; }
}
function hasExactGateRows(markdown) {
  const rows = [...markdown.matchAll(/^\|\s*(P0-\d{2})\s+\|.*?\|\s*(blocked|in_progress|passed)\s*\|\s*$/gmu)];
  const counts = new Map();
  for (const [, gate, status] of rows) counts.set(gate, [...(counts.get(gate) ?? []), status]);
  for (const gate of requiredGates) {
    const statuses = counts.get(gate) ?? [];
    if (statuses.length !== 1 || statuses[0] !== "passed") fail(`${gate} is not exactly one passed row`);
  }
  for (const gate of counts.keys()) if (!requiredGates.includes(gate)) fail(`unexpected checklist gate ${gate}`);
}

try {
  const checklistPath = resolve(root, "docs/evidence/phase6/p0-release-checklist.md");
  if (!existsSync(checklistPath)) fail("P0 checklist is missing");
  else hasExactGateRows(await readFile(checklistPath, "utf8"));

  const manifest = await json("docs/evidence/phase6/artifact-manifest.json");
  if (manifest) {
    if (!sha40.test(manifest.candidateSourceSha ?? "")) fail("artifact candidate source SHA is invalid");
    if (!sha64.test(manifest.lockfileSha256 ?? "")) fail("artifact lockfile hash is invalid");
    const versions = Object.keys(manifest.migrationJournal ?? {}).sort();
    if (versions.join(",") !== requiredGates.slice(0, 12).map((_, i) => String(i).padStart(4, "0")).join(",")) fail("artifact migration journal is incomplete");
    for (const name of ["api", "web", "worker"]) if (!digest.test(manifest.imageDigests?.[name] ?? "")) fail(`artifact ${name} image digest is invalid`);
  }

  const browser = await json("docs/evidence/phase6/browser-matrix.json");
  if (!browser || browser.status !== "passed" || browser.externalEvidenceAvailable !== true || browser.summary?.passedTargets !== 8) fail("BrowserStack matrix is not complete");
  const performance = await json("docs/evidence/phase6/performance-environment.json");
  const load = await json("docs/evidence/phase6/performance-load.json");
  if (!performance || performance.status !== "passed") fail("performance environment is not passed");
  if (!load || load.status !== "passed" || load.identity?.environmentManifestSha256 !== performance?.manifestSha256) fail("performance load does not bind to the measured environment");
  const alert = await json("docs/evidence/phase6/alert-evidence.json");
  if (!alert || alert.status !== "passed") fail("alert evidence is not passed");
  const screenReaders = [
    ["voiceover-macos.json", "macOS", "VoiceOver"],
    ["nvda-windows.json", "Windows", "NVDA"],
  ];
  for (const [file, platform, reader] of screenReaders) {
    const value = await json(`docs/evidence/phase6/${file}`);
    if (!value || value.status !== "passed" || value.platform !== platform || value.screenReader !== reader) fail(`${reader} manual evidence is missing or incomplete`);
  }

  const candidateMode = process.env.PHASE6_RELEASE_CANDIDATE === "1";
  if (candidateMode) {
    const { execFileSync } = await import("node:child_process");
    const status = execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" }).trim();
    if (status) fail("release candidate checkout is not clean");
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
    if (process.env.PHASE6_CANDIDATE_SOURCE_SHA !== head) fail("candidate source SHA does not match HEAD");
  }
} catch (error) {
  fail(error instanceof Error ? error.message : "release gate could not validate evidence");
}

if (failures.length > 0) {
  console.error("PHASE6_RELEASE_BLOCKED");
  for (const message of failures.slice(0, 20)) console.error(`- ${message}`);
  process.exit(2);
}

const publicationSha = process.env.PHASE6_EVIDENCE_PUBLICATION_SHA;
const approval = process.env.PHASE6_RELEASE_APPROVAL;
if (!sha40.test(publicationSha ?? "") || !approval) {
  console.error("PHASE6_RELEASE_BLOCKED: evidence publication SHA and explicit approval are required");
  process.exit(2);
}
if (process.env.PHASE6_EMIT_DECISION !== "1") {
  console.log("PHASE6_RELEASE_VALIDATED_NO_DECISION");
  process.exit(0);
}
const decision = {
  rows: requiredGates.map((gate) => ({ gate, status: "passed" })),
  artifactManifest: JSON.parse(await readFile(resolve(root, "docs/evidence/phase6/artifact-manifest.json"), "utf8")),
  evidencePublicationSha: publicationSha,
};
const output = resolve(root, "docs/evidence/phase6/release-decision.json");
const temporary = `${output}.${process.pid}.tmp`;
await import("node:fs/promises").then(({ writeFile, rename }) => writeFile(temporary, `${JSON.stringify(decision, null, 2)}\n`, { mode: 0o600 }).then(() => rename(temporary, output)));
console.log("PHASE6_RELEASE_DECISION_WRITTEN");
NODE
