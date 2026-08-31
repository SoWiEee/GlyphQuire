import { chmod, cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

const validDeploymentEnvironment: NodeJS.ProcessEnv = {
  PHASE6_TARGET: "isolated",
  PHASE6_DRY_RUN: "1",
  PHASE6_DATABASE_URL: "postgresql://glyphquire_app:runtime@db.example/glyphquire",
  PHASE6_MIGRATION_DATABASE_URL: "postgresql://glyphquire_migration:migrate@db.example/glyphquire",
  PHASE6_RUNTIME_ROLE: "glyphquire_app",
  PHASE6_MIGRATION_ROLE: "glyphquire_migration",
  PHASE6_EXPECTED_DATABASE_HOST: "db.example",
  PHASE6_EXPECTED_DATABASE_NAME: "glyphquire",
  PHASE6_ISOLATED_CONFIRMATION: "isolated",
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
};

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
      PHASE6_ISOLATED_CONFIRMATION: "isolated",
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

  it("requires rollback isolation confirmation before any docker or curl action", async () => {
    const temporaryRoot = await mkdtemp(resolve(tmpdir(), "glyphquire-phase6-rollback-isolation-"));
    try {
      const commandLog = resolve(temporaryRoot, "commands.log");
      const composePath = resolve(temporaryRoot, "compose.yml");
      const dockerPath = resolve(temporaryRoot, "docker");
      const curlPath = resolve(temporaryRoot, "curl");
      await writeFile(composePath, "services: {}\n");
      await writeFile(dockerPath, '#!/bin/sh\nprintf "docker\\n" >> "$PHASE6_COMMAND_LOG"\n');
      await writeFile(curlPath, '#!/bin/sh\nprintf "curl\\n" >> "$PHASE6_COMMAND_LOG"\n');
      await Promise.all([chmod(dockerPath, 0o700), chmod(curlPath, 0o700)]);

      const baseEnvironment: NodeJS.ProcessEnv = {
        PHASE6_TARGET: "isolated",
        PHASE6_DRY_RUN: "0",
        PHASE6_DATABASE_URL: "postgresql://glyphquire_app:runtime@db.example/glyphquire",
        PHASE6_RUNTIME_ROLE: "glyphquire_app",
        PHASE6_EXPECTED_DATABASE_HOST: "db.example",
        PHASE6_EXPECTED_DATABASE_NAME: "glyphquire",
        PHASE6_PREVIOUS_API_IMAGE: `registry.example/api@sha256:${"b".repeat(64)}`,
        PHASE6_PREVIOUS_WEB_IMAGE: `registry.example/web@sha256:${"b".repeat(64)}`,
        PHASE6_PREVIOUS_WORKER_IMAGE: `registry.example/worker@sha256:${"b".repeat(64)}`,
        PHASE6_PREVIOUS_RELEASE_SOURCE_SHA: "2".repeat(40),
        PHASE6_PREVIOUS_RELEASE_MANIFEST_SHA256: "3".repeat(64),
        PHASE6_COMPOSE_FILE: composePath,
        PHASE6_API_BASE_URL: "https://api.example",
        PHASE6_PROBE_TOKEN: "probe-token",
        PHASE6_READINESS_PATH: "/ready",
        PHASE6_COMMAND_LOG: commandLog,
        PATH: `${temporaryRoot}:${process.env.PATH ?? ""}`,
      };

      const missingConfirmation = await runScript(rollbackScript, baseEnvironment);
      expect(missingConfirmation.code).not.toBe(0);
      expect(`${missingConfirmation.stdout}\n${missingConfirmation.stderr}`).toMatch(/isolat/i);
      await expect(readFile(commandLog, "utf8")).rejects.toThrow();

      const productionTarget = await runScript(rollbackScript, {
        ...baseEnvironment,
        PHASE6_ISOLATED_CONFIRMATION: "isolated",
        PHASE6_DATABASE_URL: "postgresql://glyphquire_app:runtime@prod-db.example/glyphquire_prod",
        PHASE6_EXPECTED_DATABASE_HOST: "prod-db.example",
        PHASE6_EXPECTED_DATABASE_NAME: "glyphquire_prod",
      });
      expect(productionTarget.code).not.toBe(0);
      expect(`${productionTarget.stdout}\n${productionTarget.stderr}`).toMatch(
        /production|isolat|target/i,
      );
      await expect(readFile(commandLog, "utf8")).rejects.toThrow();
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  it("refuses an unbounded queue replay and accepts only an explicit bounded maximum", async () => {
    const missingBound = await runScript(queueRecoveryScript, {
      PHASE6_TARGET: "isolated",
      PHASE6_DATABASE_URL: "postgresql://glyphquire_app:runtime@db.example/glyphquire",
      PHASE6_RUNTIME_ROLE: "glyphquire_app",
      PHASE6_EXPECTED_DATABASE_HOST: "db.example",
      PHASE6_EXPECTED_DATABASE_NAME: "glyphquire",
      PHASE6_ISOLATED_CONFIRMATION: "isolated",
    });
    expect(missingBound.code).not.toBe(0);
    expect(`${missingBound.stdout}\n${missingBound.stderr}`).toMatch(/max|bound|replay/i);

    const unbounded = await runScript(queueRecoveryScript, {
      PHASE6_TARGET: "isolated",
      PHASE6_DATABASE_URL: "postgresql://glyphquire_app:runtime@db.example/glyphquire",
      PHASE6_RUNTIME_ROLE: "glyphquire_app",
      PHASE6_EXPECTED_DATABASE_HOST: "db.example",
      PHASE6_EXPECTED_DATABASE_NAME: "glyphquire",
      PHASE6_ISOLATED_CONFIRMATION: "isolated",
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
        PHASE6_ISOLATED_CONFIRMATION: "isolated",
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

  it("requires queue recovery isolation confirmation before any curl action", async () => {
    const temporaryRoot = await mkdtemp(resolve(tmpdir(), "glyphquire-phase6-queue-isolation-"));
    try {
      const idsPath = resolve(temporaryRoot, "dead-letter-ids.txt");
      const commandLog = resolve(temporaryRoot, "commands.log");
      const curlPath = resolve(temporaryRoot, "curl");
      await writeFile(idsPath, "00000000-0000-4000-8000-000000000001\n");
      await writeFile(curlPath, '#!/bin/sh\nprintf "curl\\n" >> "$PHASE6_COMMAND_LOG"\n');
      await chmod(curlPath, 0o700);

      const baseEnvironment: NodeJS.ProcessEnv = {
        PHASE6_TARGET: "isolated",
        PHASE6_DRY_RUN: "0",
        PHASE6_DATABASE_URL: "postgresql://glyphquire_app:runtime@db.example/glyphquire",
        PHASE6_RUNTIME_ROLE: "glyphquire_app",
        PHASE6_EXPECTED_DATABASE_HOST: "db.example",
        PHASE6_EXPECTED_DATABASE_NAME: "glyphquire",
        PHASE6_MAX_REPLAY: "1",
        PHASE6_DEAD_LETTER_IDS_FILE: idsPath,
        PHASE6_API_BASE_URL: "https://api.example",
        PHASE6_OPERATOR_COOKIE: "operator-cookie",
        PHASE6_COMMAND_LOG: commandLog,
        PATH: `${temporaryRoot}:${process.env.PATH ?? ""}`,
      };

      const missingConfirmation = await runScript(queueRecoveryScript, baseEnvironment);
      expect(missingConfirmation.code).not.toBe(0);
      expect(`${missingConfirmation.stdout}\n${missingConfirmation.stderr}`).toMatch(/isolat/i);
      await expect(readFile(commandLog, "utf8")).rejects.toThrow();

      const productionTarget = await runScript(queueRecoveryScript, {
        ...baseEnvironment,
        PHASE6_ISOLATED_CONFIRMATION: "isolated",
        PHASE6_DATABASE_URL: "postgresql://glyphquire_app:runtime@prod-db.example/glyphquire_prod",
        PHASE6_EXPECTED_DATABASE_HOST: "prod-db.example",
        PHASE6_EXPECTED_DATABASE_NAME: "glyphquire_prod",
      });
      expect(productionTarget.code).not.toBe(0);
      expect(`${productionTarget.stdout}\n${productionTarget.stderr}`).toMatch(
        /production|isolat|target/i,
      );
      await expect(readFile(commandLog, "utf8")).rejects.toThrow();
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
        PHASE6_ISOLATED_CONFIRMATION: "isolated",
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

  it("rejects a modified frozen migration artifact before any dry-run evidence", async () => {
    const temporaryRoot = await mkdtemp(resolve(tmpdir(), "glyphquire-phase6-migrations-"));
    try {
      const migrationsRoot = resolve(temporaryRoot, "migrations");
      await cp(resolve(repositoryRoot, "packages/database/src/migrations"), migrationsRoot, {
        recursive: true,
      });
      const sqlPath = resolve(migrationsRoot, "0000_phase0_auth.sql");
      await writeFile(sqlPath, `${await readFile(sqlPath, "utf8")}\n-- tampered\n`);
      const result = await runScript(deployScript, {
        ...validDeploymentEnvironment,
        PHASE6_MIGRATIONS_DIR: migrationsRoot,
        PHASE6_EVIDENCE_FILE: resolve(temporaryRoot, "deployment.json"),
      });

      expect(result.code).not.toBe(0);
      expect(`${result.stdout}\n${result.stderr}`).toMatch(/migration|hash|trusted|artifact/i);
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  it("rejects extra or missing migration artifacts even when dry-run is requested", async () => {
    const extraRoot = await mkdtemp(resolve(tmpdir(), "glyphquire-phase6-extra-"));
    const missingRoot = await mkdtemp(resolve(tmpdir(), "glyphquire-phase6-missing-"));
    try {
      const extraMigrations = resolve(extraRoot, "migrations");
      const missingMigrations = resolve(missingRoot, "migrations");
      await Promise.all([
        cp(resolve(repositoryRoot, "packages/database/src/migrations"), extraMigrations, {
          recursive: true,
        }),
        cp(resolve(repositoryRoot, "packages/database/src/migrations"), missingMigrations, {
          recursive: true,
        }),
      ]);
      await writeFile(resolve(extraMigrations, "0012_unapproved.sql"), "-- unapproved\n");
      await rm(resolve(missingMigrations, "0011_phase5_export_formats.sql"));

      const extra = await runScript(deployScript, {
        ...validDeploymentEnvironment,
        PHASE6_MIGRATIONS_DIR: extraMigrations,
        PHASE6_EVIDENCE_FILE: resolve(extraRoot, "deployment.json"),
      });
      const missing = await runScript(deployScript, {
        ...validDeploymentEnvironment,
        PHASE6_MIGRATIONS_DIR: missingMigrations,
        PHASE6_EVIDENCE_FILE: resolve(missingRoot, "deployment.json"),
      });

      expect(extra.code).not.toBe(0);
      expect(missing.code).not.toBe(0);
      expect(`${extra.stdout}\n${extra.stderr}`).toMatch(/extra|artifact|migration/i);
      expect(`${missing.stdout}\n${missing.stderr}`).toMatch(/missing|artifact|migration/i);
    } finally {
      await Promise.all([
        rm(extraRoot, { recursive: true, force: true }),
        rm(missingRoot, { recursive: true, force: true }),
      ]);
    }
  });

  it("requires an explicit isolated confirmation and rejects production-like target identities", async () => {
    const missingConfirmation = { ...validDeploymentEnvironment };
    delete missingConfirmation.PHASE6_ISOLATED_CONFIRMATION;
    const withoutConfirmation = await runScript(deployScript, missingConfirmation);

    const productionTarget = await runScript(deployScript, {
      ...validDeploymentEnvironment,
      PHASE6_DATABASE_URL: "postgresql://glyphquire_app:runtime@prod-db.example/glyphquire_prod",
      PHASE6_MIGRATION_DATABASE_URL:
        "postgresql://glyphquire_migration:migrate@prod-db.example/glyphquire_prod",
      PHASE6_EXPECTED_DATABASE_HOST: "prod-db.example",
      PHASE6_EXPECTED_DATABASE_NAME: "glyphquire_prod",
    });

    expect(withoutConfirmation.code).not.toBe(0);
    expect(productionTarget.code).not.toBe(0);
    expect(`${withoutConfirmation.stdout}\n${withoutConfirmation.stderr}`).toMatch(/isolat/i);
    expect(`${productionTarget.stdout}\n${productionTarget.stderr}`).toMatch(
      /production|isolat|target/i,
    );
  });

  it("canonicalizes replay UUIDs and rejects case-insensitive duplicates", async () => {
    const duplicateRoot = await mkdtemp(resolve(tmpdir(), "glyphquire-phase6-uuid-"));
    try {
      const duplicateIds = resolve(duplicateRoot, "duplicates.txt");
      await writeFile(
        duplicateIds,
        "00000000-0000-4000-8000-0000000000AB\n00000000-0000-4000-8000-0000000000ab\n",
      );
      const duplicate = await runScript(queueRecoveryScript, {
        PHASE6_TARGET: "isolated",
        PHASE6_DRY_RUN: "1",
        PHASE6_DATABASE_URL: "postgresql://glyphquire_app:runtime@db.example/glyphquire",
        PHASE6_RUNTIME_ROLE: "glyphquire_app",
        PHASE6_EXPECTED_DATABASE_HOST: "db.example",
        PHASE6_EXPECTED_DATABASE_NAME: "glyphquire",
        PHASE6_ISOLATED_CONFIRMATION: "isolated",
        PHASE6_MAX_REPLAY: "2",
        PHASE6_DEAD_LETTER_IDS_FILE: duplicateIds,
      });
      expect(duplicate.code).not.toBe(0);
      expect(`${duplicate.stdout}\n${duplicate.stderr}`).toMatch(/duplicate|uuid/i);
    } finally {
      await rm(duplicateRoot, { recursive: true, force: true });
    }

    const replayRoot = await mkdtemp(resolve(tmpdir(), "glyphquire-phase6-replay-"));
    try {
      const idsPath = resolve(replayRoot, "ids.txt");
      const capturePath = resolve(replayRoot, "curl-args.txt");
      const curlPath = resolve(replayRoot, "curl");
      await writeFile(idsPath, "00000000-0000-4000-8000-0000000000AB\n");
      await writeFile(
        curlPath,
        '#!/usr/bin/env node\nimport { appendFileSync } from "node:fs";\nappendFileSync(process.env.PHASE6_CURL_CAPTURE, `${process.argv.slice(2).join("\\n")}\\n`);\n',
      );
      await chmod(curlPath, 0o700);
      const replay = await runScript(queueRecoveryScript, {
        PHASE6_TARGET: "isolated",
        PHASE6_DATABASE_URL: "postgresql://glyphquire_app:runtime@db.example/glyphquire",
        PHASE6_RUNTIME_ROLE: "glyphquire_app",
        PHASE6_EXPECTED_DATABASE_HOST: "db.example",
        PHASE6_EXPECTED_DATABASE_NAME: "glyphquire",
        PHASE6_ISOLATED_CONFIRMATION: "isolated",
        PHASE6_MAX_REPLAY: "1",
        PHASE6_DEAD_LETTER_IDS_FILE: idsPath,
        PHASE6_API_BASE_URL: "https://api.example",
        PHASE6_OPERATOR_COOKIE: "operator-cookie",
        PHASE6_CURL_CAPTURE: capturePath,
        PATH: `${replayRoot}:${process.env.PATH ?? ""}`,
      });
      const captured = await readFile(capturePath, "utf8");

      expect(replay.code).toBe(0);
      expect(captured).toContain("00000000-0000-4000-8000-0000000000ab/replay");
      expect(captured).not.toContain("00000000-0000-4000-8000-0000000000AB/replay");
    } finally {
      await rm(replayRoot, { recursive: true, force: true });
    }
  });
});
