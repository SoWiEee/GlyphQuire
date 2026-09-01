import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const execFileAsync = promisify(execFile);
const backupScript = resolve(repositoryRoot, "infra/backup/backup.sh");
const restoreScript = resolve(repositoryRoot, "infra/backup/restore-drill.sh");

async function source(path: string) {
  return readFile(resolve(repositoryRoot, path), "utf8");
}

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

async function makeCommandFixtures(root: string) {
  const bin = resolve(root, "bin");
  await mkdir(bin, { recursive: true, mode: 0o700 });
  await writeFile(
    resolve(bin, "pg_dump"),
    `#!/bin/sh
output=
for argument in "$@"; do
  case "$argument" in
    --file=*) output="$(printf '%s' "$argument" | sed 's/^--file=//')" ;;
  esac
done
[ -n "$output" ] || exit 1
printf 'synthetic PostgreSQL custom dump' > "$output"
`,
    { mode: 0o700 },
  );
  await writeFile(
    resolve(bin, "pg_restore"),
    `#!/bin/sh
printf 'pg_restore invoked\n' >> "$RELEASE_COMMAND_LOG"
exit 0
`,
    { mode: 0o700 },
  );
  await writeFile(
    resolve(bin, "psql"),
    `#!/bin/sh
query=
for argument in "$@"; do query="$argument"; done
case "$query" in
  *LEFT\\ JOIN*) printf '0\\n' ;;
  *schema_version*) printf '1:1\\n' ;;
  *content_markdown*) printf 'notes-markdown\\n' ;;
  *string_agg*note_versions*) printf 'version-row\\n' ;;
  *string_agg*assets*) printf 'asset-row\\n' ;;
  *string_agg*) printf 'notes-row\\n' ;;
  *FROM\\ public.note_versions*) printf '1\\n' ;;
  *FROM\\ public.assets*) printf '1\\n' ;;
  *FROM\\ public.notes*) printf '1\\n' ;;
  *drizzle.__drizzle_migrations*) printf '16\\n' ;;
  *) exit 1 ;;
esac
`,
    { mode: 0o700 },
  );
  await writeFile(resolve(root, "pg-restore.log"), "", { mode: 0o600 });
  return bin;
}

async function prepareMigrationCopy(root: string) {
  const destination = resolve(root, "migrations");
  await cp(resolve(repositoryRoot, "packages/database/src/migrations"), destination, {
    recursive: true,
  });
  return destination;
}

async function disposableEnvironment() {
  const root = await mkdtemp(resolve(tmpdir(), "glyphquire-release-backup-"));
  const backupRoot = resolve(root, "backups");
  const objectSource = resolve(root, "object-source");
  const restoreRoot = resolve(root, "restore");
  const objectTarget = resolve(restoreRoot, "object-storage");
  const evidencePath = resolve(root, "backup-restore.json");
  const operationsEvidencePath = resolve(root, "backup-restore.md");
  const commandLog = resolve(root, "pg-restore.log");
  await mkdir(objectSource, { recursive: true, mode: 0o700 });
  await writeFile(resolve(objectSource, "sentinel-object-key"), "object payload", { mode: 0o600 });
  const bin = await makeCommandFixtures(root);
  const migrations = await prepareMigrationCopy(root);
  const base: NodeJS.ProcessEnv = {
    PATH: `${bin}:${process.env.PATH ?? ""}`,
    BACKUP_ROOT: backupRoot,
    BACKUP_ID: "20260831T000000Z",
    BACKUP_ENCRYPTION_KEY: "release-test-key-that-is-not-evidence",
    BACKUP_ENCRYPTION_KEY_VERSION: "test-v1",
    BACKUP_MIGRATIONS_DIR: migrations,
    BACKUP_MIGRATION_JOURNAL_FILE: resolve(migrations, "meta/_journal.json"),
    DATABASE_URL: "postgresql://backup:secret@db.example/glyphquire",
    OBJECT_STORAGE_SOURCE: objectSource,
    BACKUP_EVENT_LOG: resolve(root, "backup-events.jsonl"),
    BACKUP_VERIFY_MARKER: resolve(root, "backup-verify.jsonl"),
    RESTORE_ROOT: restoreRoot,
    RESTORE_DATABASE_URL: "postgresql://restore:secret@db.example/release_restore",
    RESTORE_OBJECT_STORAGE_TARGET: objectTarget,
    RESTORE_MIGRATIONS_DIR: migrations,
    RESTORE_MIGRATION_JOURNAL_FILE: resolve(migrations, "meta/_journal.json"),
    RESTORE_EVIDENCE_FILE: operationsEvidencePath,
    RELEASE_BACKUP_EVIDENCE: "1",
    RELEASE_BACKUP_EVIDENCE_FILE: evidencePath,
    RELEASE_COMMAND_LOG: commandLog,
    RESTORE_ISOLATED_CONFIRMATION: "isolated",
  };
  return {
    root,
    backupRoot,
    objectSource,
    restoreRoot,
    objectTarget,
    evidencePath,
    commandLog,
    base,
  };
}

describe("Release encrypted backup and isolated restore contract", () => {
  it("uses an authenticated AES-256-GCM envelope with versioned key metadata", async () => {
    const script = await source("infra/backup/backup.sh");

    expect(script).toContain("AES-256-GCM");
    expect(script).toContain("createCipheriv");
    expect(script).toContain("getAuthTag");
    expect(script).toContain("BACKUP_ENCRYPTION_KEY_VERSION");
    expect(script).toContain("ciphertextSha256");
    expect(script).toContain("plaintextSha256");
    expect(script).toContain("aggregateSha256");
    expect(script).not.toMatch(/aes-256-cbc/iu);
  });

  it("confines restore to explicitly confirmed isolated database and object targets", async () => {
    const script = await source("infra/backup/restore-drill.sh");

    expect(script).toContain("RESTORE_ISOLATED_CONFIRMATION:-");
    expect(script).toContain('"isolated"');
    expect(script).toContain("RESTORE_DATABASE_URL");
    expect(script).toContain("RESTORE_OBJECT_STORAGE_TARGET");
    expect(script).toContain("mktemp -d");
    expect(script).toContain("--clean");
    expect(script).toMatch(/target.+isolated|isolated.+target/isu);
    expect(script).toMatch(/production|primary|live/iu);
  });

  it("checks forward-only migrations, schema, relationships, rows, hashes, and canonical Markdown", async () => {
    const [backup, restore] = await Promise.all([
      source("infra/backup/backup.sh"),
      source("infra/backup/restore-drill.sh"),
    ]);
    const combined = `${backup}\n${restore}`;

    expect(combined).toMatch(/migration[_ -]?journal/iu);
    expect(combined).toMatch(/forward[- ]only/iu);
    expect(combined).toContain("schema_version");
    expect(combined).toContain("note_versions");
    expect(combined).toContain("assets");
    expect(combined).toMatch(/relationship/iu);
    expect(combined).toMatch(/row[_ -]?count/iu);
    expect(combined).toMatch(/content_hash/iu);
    expect(combined).toMatch(/content_markdown/iu);
    expect(combined).toMatch(/aggregate(Sha256|_hash)/u);
    expect(combined).toMatch(/MAX_(?:BACKUP_)?(?:FILE|BYTES)|MAX_(?:FILE|BYTES)/u);
  });

  it("fails closed for corrupt or truncated artifacts and cleans temporary key material", async () => {
    const [backup, restore] = await Promise.all([
      source("infra/backup/backup.sh"),
      source("infra/backup/restore-drill.sh"),
    ]);
    const combined = `${backup}\n${restore}`;

    expect(combined).toMatch(/ciphertextSha256|authTag/iu);
    expect(combined).toMatch(/truncat|corrupt|integrity/iu);
    expect(combined).toMatch(/trap.+cleanup|cleanup.+trap/isu);
    expect(combined).toMatch(/rm -f.+key|rm -rf.+work/isu);
    expect(combined).not.toMatch(/set -x/iu);
  });

  it("defines a strict sanitized evidence schema and instance", async () => {
    const [schemaSource, evidenceSource] = await Promise.all([
      source("docs/evidence/release/backup-restore-evidence.schema.json"),
      source("docs/evidence/release/backup-restore.json"),
    ]);
    const schema = JSON.parse(schemaSource) as {
      required?: string[];
      properties?: Record<string, { const?: unknown; enum?: unknown[] }>;
    };
    const evidence = JSON.parse(evidenceSource) as Record<string, unknown>;

    expect(schema.required).toEqual(
      expect.arrayContaining([
        "schemaVersion",
        "status",
        "scrubbed",
        "target",
        "encryption",
        "artifacts",
        "aggregateSha256",
        "invariants",
        "checks",
      ]),
    );
    expect(schema.properties?.scrubbed?.const).toBe(true);
    expect(schema.properties?.target?.const).toBe("isolated");
    expect(schema.properties?.status?.enum).toEqual(
      expect.arrayContaining(["blocked", "failed", "passed"]),
    );
    expect(evidence).toMatchObject({
      schemaVersion: 1,
      scrubbed: true,
      target: "isolated",
      producer: "release-backup-restore",
    });
    expect(evidenceSource).not.toContain("sentinel-object-key");
    expect(evidenceSource).not.toMatch(/postgres(?:ql)?:\/\//iu);
    expect(evidenceSource).not.toMatch(/BEGIN (?:RSA|OPENSSH|PRIVATE)/u);
  });

  it("round-trips an authenticated backup through isolated disposable targets", async () => {
    const environment = await disposableEnvironment();
    try {
      const backup = await runScript(backupScript, environment.base);
      expect(backup.code, `${backup.stdout}${backup.stderr}`).toBe(0);

      const manifestPath = resolve(environment.backupRoot, "backup-20260831T000000Z.manifest.json");
      const databaseArtifactPath = resolve(
        environment.backupRoot,
        "postgres-20260831T000000Z.dump.enc",
      );
      const objectArtifactPath = resolve(
        environment.backupRoot,
        "object-storage-20260831T000000Z.tar.enc",
      );
      const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
        encryption: { algorithm: string; keyVersion: string };
        aggregateSha256: string;
        objectStorage: { aggregateSha256: string };
      };
      expect(manifest.encryption).toMatchObject({
        algorithm: "AES-256-GCM",
        keyVersion: "test-v1",
      });
      expect(manifest.aggregateSha256).toMatch(/^[a-f0-9]{64}$/u);
      expect(await readFile(databaseArtifactPath, "utf8")).not.toContain("synthetic");
      expect(await readFile(objectArtifactPath, "utf8")).not.toContain("object payload");

      const retry = await runScript(backupScript, environment.base);
      expect(retry.code, `${retry.stdout}${retry.stderr}`).toBe(0);
      expect(JSON.parse(await readFile(manifestPath, "utf8"))).toEqual(manifest);

      const restore = await runScript(restoreScript, environment.base);
      expect(restore.code, `${restore.stdout}${restore.stderr}`).toBe(0);
      expect(await readFile(resolve(environment.objectTarget, "sentinel-object-key"), "utf8")).toBe(
        "object payload",
      );
      const evidence = JSON.parse(await readFile(environment.evidencePath, "utf8")) as {
        status: string;
        checks: { aggregateHash: boolean; rollbackCanonicalMarkdown: boolean };
      };
      expect(evidence).toMatchObject({ status: "passed", scrubbed: true, target: "isolated" });
      expect(evidence.checks).toEqual(
        expect.objectContaining({ aggregateHash: true, rollbackCanonicalMarkdown: true }),
      );
      expect(await readFile(environment.evidencePath, "utf8")).not.toContain("sentinel-object-key");
      await expect(readdir(environment.restoreRoot)).resolves.not.toContain(
        expect.stringMatching(/^\.work-/u),
      );
    } finally {
      await rm(environment.root, { recursive: true, force: true });
    }
  });

  it("rejects a wrong key or tampered ciphertext before invoking destructive restore", async () => {
    const environment = await disposableEnvironment();
    try {
      const firstBackup = await runScript(backupScript, environment.base);
      expect(firstBackup.code, `${firstBackup.stdout}${firstBackup.stderr}`).toBe(0);
      const wrongKey = await runScript(restoreScript, {
        ...environment.base,
        BACKUP_ENCRYPTION_KEY: "wrong-key",
      });
      expect(wrongKey.code).not.toBe(0);
      expect(await readFile(environment.commandLog, "utf8")).toBe("");
      const failedEvidence = JSON.parse(await readFile(environment.evidencePath, "utf8")) as {
        status: string;
        scrubbed: boolean;
        checks: { encryption: boolean; isolation: boolean };
      };
      expect(failedEvidence).toMatchObject({ status: "failed", scrubbed: true });
      expect(failedEvidence.checks).toEqual(
        expect.objectContaining({ encryption: false, isolation: false }),
      );

      const objectArtifactPath = resolve(
        environment.backupRoot,
        "object-storage-20260831T000000Z.tar.enc",
      );
      const objectArtifact = await readFile(objectArtifactPath);
      objectArtifact[0] ^= 0xff;
      await writeFile(objectArtifactPath, objectArtifact, { mode: 0o600 });
      const tampered = await runScript(restoreScript, environment.base);
      expect(tampered.code).not.toBe(0);
      expect(await readFile(environment.commandLog, "utf8")).toBe("");
      await expect(
        stat(resolve(environment.restoreRoot, ".work-20260831T000000Z")),
      ).rejects.toThrow();
    } finally {
      await rm(environment.root, { recursive: true, force: true });
    }
  });

  it("fails closed when a complete same-ID backup is corrupted before an idempotent retry", async () => {
    const environment = await disposableEnvironment();
    try {
      const firstBackup = await runScript(backupScript, environment.base);
      expect(firstBackup.code, `${firstBackup.stdout}${firstBackup.stderr}`).toBe(0);
      const manifestPath = resolve(environment.backupRoot, "backup-20260831T000000Z.manifest.json");
      const manifestBefore = await readFile(manifestPath, "utf8");
      const databaseArtifactPath = resolve(
        environment.backupRoot,
        "postgres-20260831T000000Z.dump.enc",
      );
      const databaseArtifact = await readFile(databaseArtifactPath);
      databaseArtifact[0] ^= 0xff;
      await writeFile(databaseArtifactPath, databaseArtifact, { mode: 0o600 });

      const retry = await runScript(backupScript, environment.base);
      expect(retry.code).not.toBe(0);
      expect(await readFile(manifestPath, "utf8")).toBe(manifestBefore);
    } finally {
      await rm(environment.root, { recursive: true, force: true });
    }
  });

  it("retains a scrubbed evidence history across an idempotent restore rerun", async () => {
    const environment = await disposableEnvironment();
    try {
      const firstBackup = await runScript(backupScript, environment.base);
      expect(firstBackup.code, `${firstBackup.stdout}${firstBackup.stderr}`).toBe(0);
      const firstRestore = await runScript(restoreScript, environment.base);
      expect(firstRestore.code, `${firstRestore.stdout}${firstRestore.stderr}`).toBe(0);
      const firstEvidence = JSON.parse(await readFile(environment.evidencePath, "utf8")) as {
        status: string;
        history?: unknown[];
      };
      expect(firstEvidence.status).toBe("passed");

      const secondRestore = await runScript(restoreScript, environment.base);
      expect(secondRestore.code, `${secondRestore.stdout}${secondRestore.stderr}`).toBe(0);
      const secondEvidence = JSON.parse(await readFile(environment.evidencePath, "utf8")) as {
        status: string;
        history?: Array<{ status?: string; aggregateSha256?: string }>;
      };
      expect(secondEvidence.status).toBe("passed");
      expect(secondEvidence.history).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ status: "passed", aggregateSha256: expect.any(String) }),
        ]),
      );
    } finally {
      await rm(environment.root, { recursive: true, force: true });
    }
  });

  it("requires explicit isolation confirmation before checking or mutating restore targets", async () => {
    const environment = await disposableEnvironment();
    try {
      const firstBackup = await runScript(backupScript, environment.base);
      expect(firstBackup.code, `${firstBackup.stdout}${firstBackup.stderr}`).toBe(0);
      const blocked = await runScript(restoreScript, {
        ...environment.base,
        RESTORE_ISOLATED_CONFIRMATION: "",
        RESTORE_CONFIRMATION: "",
      });
      expect(blocked.code).not.toBe(0);
      expect(`${blocked.stdout}\n${blocked.stderr}`).toMatch(/isolated|confirmation/iu);
      expect(await readFile(environment.commandLog, "utf8")).toBe("");
      await expect(stat(environment.objectTarget)).rejects.toThrow();
    } finally {
      await rm(environment.root, { recursive: true, force: true });
    }
  });
});
