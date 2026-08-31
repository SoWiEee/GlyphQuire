import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, MigrationRunner, type Database } from "@glyphquire/database";

const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
const migrationsDirectory = fileURLToPath(
  new URL("../../../packages/database/src/migrations", import.meta.url),
);

async function readPackageJson(relativePath: string) {
  return JSON.parse(
    await readFile(new URL(`../../../${relativePath}`, import.meta.url), "utf8"),
  ) as {
    exports: Record<string, unknown>;
  };
}

describe("production package export contract", () => {
  it.each([
    ["packages/shared/package.json", ".", "./src/index.ts", "./dist/index.js"],
    ["packages/auth/package.json", ".", "./src/index.ts", "./dist/index.js"],
    ["packages/database/package.json", ".", "./src/index.ts", "./dist/index.js"],
    ["packages/api-contract/package.json", ".", "./src/index.ts", "./dist/index.js"],
    ["apps/api/package.json", "./app", "./src/app.ts", "./dist/app.js"],
  ])(
    "resolves %s %s to source for tools and built JavaScript for Node",
    async (packagePath, exportName, sourcePath, distributionPath) => {
      const manifest = await readPackageJson(packagePath);

      expect(manifest.exports[exportName]).toEqual({
        types: sourcePath,
        development: sourcePath,
        import: distributionPath,
        default: distributionPath,
      });
    },
  );
});

function freePort() {
  return new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("could not allocate a loopback port"));
        return;
      }
      server.close((error) => {
        if (error) reject(error);
        else resolve(address.port);
      });
    });
  });
}

function spawnProductionArtifact(databaseUrl: string, port: number) {
  const child = spawn("pnpm", ["--filter", "@glyphquire/api", "start"], {
    cwd: repositoryRoot,
    env: {
      ...process.env,
      NODE_ENV: "production",
      DATABASE_URL: databaseUrl,
      BETTER_AUTH_SECRET: "artifact-smoke-secret-at-least-32-characters",
      BETTER_AUTH_URL: "https://app.example.test",
      WEB_ORIGIN: "https://app.example.test",
      API_PORT: String(port),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  return { child, output: () => ({ stdout, stderr, combined: `${stdout}\n${stderr}` }) };
}

type ArtifactChild = ReturnType<typeof spawnProductionArtifact>["child"];

async function waitForExit(child: ArtifactChild, timeoutMs = 15_000) {
  if (child.exitCode !== null) return child.exitCode;
  const result = await Promise.race([
    once(child, "exit").then(([code]) => code as number | null),
    delay(timeoutMs).then(() => "timeout" as const),
  ]);
  if (result === "timeout") throw new Error("production artifact did not exit in time");
  return result;
}

async function stopChild(child: ArtifactChild) {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  const stopped = await Promise.race([
    once(child, "exit").then(() => true),
    delay(2_000).then(() => false),
  ]);
  if (!stopped && child.exitCode === null) {
    child.kill("SIGKILL");
    await once(child, "exit");
  }
}

async function waitForHealth(child: ArtifactChild, port: number) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error("production artifact exited before listening");
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (response.status === 200) return response;
    } catch {
      // The foreground child is still completing its database capability probe.
    }
    await delay(50);
  }
  throw new Error("production artifact did not become healthy in time");
}

const artifactSmokeEnabled = process.env.TEST_PRODUCTION_ARTIFACT_SMOKE === "1";
const migrationDatabaseUrl = process.env.TEST_MIGRATION_DATABASE_URL;

describe.runIf(artifactSmokeEnabled)("built production API artifact", () => {
  let adminDb: Database;
  let artifactDb: Database;
  let artifactDatabaseName: string;
  let artifactDatabaseUrl: string;

  beforeAll(async () => {
    if (!migrationDatabaseUrl) {
      throw new Error("TEST_MIGRATION_DATABASE_URL is required for the artifact smoke");
    }
    const adminUrl = new URL(migrationDatabaseUrl);
    if (!["127.0.0.1", "localhost"].includes(adminUrl.hostname)) {
      throw new Error("artifact smoke requires a loopback PostgreSQL URL");
    }
    adminDb = createDb(adminUrl.toString());
    artifactDatabaseName = `glyphquire_t5_artifact_${randomUUID().replaceAll("-", "")}`;
    await adminDb.$client.unsafe(`create database "${artifactDatabaseName}"`);
    const artifactUrl = new URL(adminUrl);
    artifactUrl.pathname = `/${artifactDatabaseName}`;
    artifactDatabaseUrl = artifactUrl.toString();
    artifactDb = createDb(artifactDatabaseUrl);
    await new MigrationRunner({
      databaseUrl: artifactDatabaseUrl,
      migrationsDirectory,
    }).execute(artifactDb);
  });

  afterAll(async () => {
    if (artifactDb) await artifactDb.$client.end();
    if (adminDb && artifactDatabaseName) {
      await adminDb.$client`
        select pg_catalog.pg_terminate_backend(activity.pid)
        from pg_catalog.pg_stat_activity activity
        where activity.datname = ${artifactDatabaseName}
          and activity.pid <> pg_catalog.pg_backend_pid()
      `;
      await adminDb.$client.unsafe(`drop database "${artifactDatabaseName}"`);
      await adminDb.$client.end();
    }
  });

  it("reaches startApi, completes the probe, listens, and serves health", async () => {
    const port = await freePort();
    const process = spawnProductionArtifact(artifactDatabaseUrl, port);
    try {
      const response = await waitForHealth(process.child, port);
      expect(await response.json()).toEqual({
        status: "ok",
        timestamp: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
      });
      const output = process.output().combined;
      expect(output).toContain(`GlyphQuire API running on http://localhost:${port}`);
      expect(output).not.toMatch(/ERR_MODULE_NOT_FOUND|ERR_UNKNOWN_FILE_EXTENSION|node:internal/);
    } finally {
      await stopChild(process.child);
    }
  });

  it("fails closed with one fixed startup event and no loader, database, or stack details", async () => {
    const port = await freePort();
    const process = spawnProductionArtifact(
      "postgresql://ARTIFACT_USER_SENTINEL:ARTIFACT_PASSWORD_SENTINEL@127.0.0.1:1/unavailable?connect_timeout=1",
      port,
    );
    try {
      const exitCode = await waitForExit(process.child);
      const output = process.output();
      const startupEvents = output.combined.match(
        /\{"event":"api_startup_failed","code":"SERVICE_UNAVAILABLE"\}/g,
      );

      expect(exitCode).not.toBe(0);
      expect(startupEvents).toEqual([
        '{"event":"api_startup_failed","code":"SERVICE_UNAVAILABLE"}',
      ]);
      expect(output.combined).not.toMatch(
        /ARTIFACT_(?:USER|PASSWORD)_SENTINEL|127\.0\.0\.1:1|ERR_MODULE_NOT_FOUND|ERR_UNKNOWN_FILE_EXTENSION|node:internal|PostgresError|ECONNREFUSED|\n\s+at\s/,
      );
    } finally {
      await stopChild(process.child);
    }
  });
});
