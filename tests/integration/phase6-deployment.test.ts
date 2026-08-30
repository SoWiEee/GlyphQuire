import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const repositoryRoot = resolve(import.meta.dirname, "../..");
const deployScript = resolve(repositoryRoot, "infra/phase6/phase6-deploy.sh");
const rollbackScript = resolve(repositoryRoot, "infra/phase6/phase6-rollback.sh");
const queueRecoveryScript = resolve(repositoryRoot, "infra/phase6/phase6-queue-recovery.sh");

async function runScript(script: string, env: NodeJS.ProcessEnv) {
  try {
    const result = await execFileAsync("bash", [script], {
      cwd: repositoryRoot,
      env: { ...process.env, ...env },
      maxBuffer: 1024 * 1024,
    });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const failure = error as { code?: number | string; stdout?: string; stderr?: string };
    return {
      code: typeof failure.code === "number" ? failure.code : 1,
      stdout: failure.stdout ?? "",
      stderr: failure.stderr ?? "",
    };
  }
}

describe("Phase 6 deployment and recovery contracts", () => {
  it("refuses deployment without separate canonical migration and runtime targets", async () => {
    const result = await runScript(deployScript, {
      PHASE6_TARGET: "isolated",
      PHASE6_DATABASE_URL: "postgresql://glyphquire_app:runtime@db.example/glyphquire",
      PHASE6_MIGRATION_DATABASE_URL: "postgresql://glyphquire_app:runtime@db.example/glyphquire",
      PHASE6_RUNTIME_ROLE: "glyphquire_app",
      PHASE6_MIGRATION_ROLE: "glyphquire_app",
      PHASE6_EXPECTED_DATABASE_HOST: "db.example",
      PHASE6_EXPECTED_DATABASE_NAME: "glyphquire",
    });

    expect(result.code).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toMatch(/migration|runtime|separat|role/i);
    expect(`${result.stdout}\n${result.stderr}`).not.toContain("postgresql://");
  });

  it("refuses rollback unless the target is explicitly isolated and digests are immutable", async () => {
    const result = await runScript(rollbackScript, {
      PHASE6_TARGET: "hosted",
      PHASE6_DATABASE_URL: "postgresql://glyphquire_app:runtime@db.example/glyphquire",
      PHASE6_PREVIOUS_API_IMAGE: "registry.example/api:previous",
    });

    expect(result.code).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toMatch(/isolated|digest|target/i);
  });

  it("refuses an unbounded queue replay and accepts only an explicit bounded maximum", async () => {
    const missingBound = await runScript(queueRecoveryScript, {
      PHASE6_TARGET: "isolated",
      PHASE6_DATABASE_URL: "postgresql://glyphquire_app:runtime@db.example/glyphquire",
      PHASE6_RUNTIME_ROLE: "glyphquire_app",
      PHASE6_EXPECTED_DATABASE_HOST: "db.example",
      PHASE6_EXPECTED_DATABASE_NAME: "glyphquire",
    });
    expect(missingBound.code).not.toBe(0);
    expect(`${missingBound.stdout}\n${missingBound.stderr}`).toMatch(/max|bound|replay/i);

    const unbounded = await runScript(queueRecoveryScript, {
      PHASE6_TARGET: "isolated",
      PHASE6_DATABASE_URL: "postgresql://glyphquire_app:runtime@db.example/glyphquire",
      PHASE6_RUNTIME_ROLE: "glyphquire_app",
      PHASE6_EXPECTED_DATABASE_HOST: "db.example",
      PHASE6_EXPECTED_DATABASE_NAME: "glyphquire",
      PHASE6_MAX_REPLAY: "0",
    });
    expect(unbounded.code).not.toBe(0);

    const temporaryRoot = await mkdtemp(resolve(tmpdir(), "glyphquire-phase6-queue-"));
    try {
      const idsPath = resolve(temporaryRoot, "dead-letter-ids.txt");
      await writeFile(idsPath, "00000000-0000-4000-8000-000000000001\n");
      const bounded = await runScript(queueRecoveryScript, {
        PHASE6_TARGET: "isolated",
        PHASE6_DRY_RUN: "1",
        PHASE6_DATABASE_URL: "postgresql://glyphquire_app:runtime@db.example/glyphquire",
        PHASE6_RUNTIME_ROLE: "glyphquire_app",
        PHASE6_EXPECTED_DATABASE_HOST: "db.example",
        PHASE6_EXPECTED_DATABASE_NAME: "glyphquire",
        PHASE6_MAX_REPLAY: "1",
        PHASE6_DEAD_LETTER_IDS_FILE: idsPath,
        PHASE6_QUEUE_EVIDENCE_FILE: resolve(temporaryRoot, "queue-recovery.json"),
      });
      expect(bounded.code).toBe(0);
      expect(bounded.stdout).toContain('"max":1');
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  it("records a scrubbed rehearsal event without mutable tags or content", async () => {
    const temporaryRoot = await mkdtemp(resolve(tmpdir(), "glyphquire-phase6-"));
    try {
      const evidencePath = resolve(temporaryRoot, "deployment-rehearsal.json");
      const result = await runScript(deployScript, {
        PHASE6_TARGET: "isolated",
        PHASE6_DRY_RUN: "1",
        PHASE6_DATABASE_URL: "postgresql://glyphquire_app:runtime@db.example/glyphquire",
        PHASE6_MIGRATION_DATABASE_URL:
          "postgresql://glyphquire_migration:migrate@db.example/glyphquire",
        PHASE6_RUNTIME_ROLE: "glyphquire_app",
        PHASE6_MIGRATION_ROLE: "glyphquire_migration",
        PHASE6_EXPECTED_DATABASE_HOST: "db.example",
        PHASE6_EXPECTED_DATABASE_NAME: "glyphquire",
        PHASE6_S3_ENDPOINT: "https://objects.example",
        PHASE6_EXPECTED_BUCKET: "glyphquire-private",
        PHASE6_CANDIDATE_SOURCE_SHA: "1".repeat(40),
        PHASE6_PREVIOUS_RELEASE_SOURCE_SHA: "2".repeat(40),
        PHASE6_PREVIOUS_RELEASE_MANIFEST_SHA256: "3".repeat(64),
        PHASE6_CANDIDATE_API_IMAGE: `registry.example/api@sha256:${"a".repeat(64)}`,
        PHASE6_CANDIDATE_WEB_IMAGE: `registry.example/web@sha256:${"a".repeat(64)}`,
        PHASE6_CANDIDATE_WORKER_IMAGE: `registry.example/worker@sha256:${"a".repeat(64)}`,
        PHASE6_PREVIOUS_API_IMAGE: `registry.example/api@sha256:${"b".repeat(64)}`,
        PHASE6_PREVIOUS_WEB_IMAGE: `registry.example/web@sha256:${"b".repeat(64)}`,
        PHASE6_PREVIOUS_WORKER_IMAGE: `registry.example/worker@sha256:${"b".repeat(64)}`,
        PHASE6_EVIDENCE_FILE: evidencePath,
      });

      expect(result.code).toBe(0);
      const evidence = await readFile(evidencePath, "utf8");
      expect(evidence).not.toContain("runtime");
      expect(evidence).not.toContain("migrate");
      expect(evidence).not.toContain("db.example");
      expect(evidence).not.toContain("registry.example");
      expect(JSON.parse(evidence)).toMatchObject({ status: "blocked", scrubbed: true });
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });
});
