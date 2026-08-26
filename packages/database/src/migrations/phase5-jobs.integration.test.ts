import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres, { type Sql } from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb } from "../client.js";
import { readRepositoryMigrations, verifyMigrationBaseline } from "./verify-baseline.js";

const migrationDatabaseUrl = process.env.TEST_MIGRATION_DATABASE_URL;
const runtimeDatabaseUrl = process.env.TEST_DATABASE_URL;
const hasPostgresEnvironment = Boolean(migrationDatabaseUrl && runtimeDatabaseUrl);
const describeWithPostgres = hasPostgresEnvironment ? describe : describe.skip;
const migrationsDirectory = fileURLToPath(new URL("./", import.meta.url));

function urlForDatabase(baseUrl: string, databaseName: string): string {
  const url = new URL(baseUrl);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

function assertLoopbackDatabaseUrl(value: string): void {
  const url = new URL(value);
  if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) {
    throw new Error("Phase 5 migration integration tests require loopback PostgreSQL URLs");
  }
}

async function applySql(sql: Pick<Sql, "unsafe">, source: string): Promise<void> {
  for (const statement of source.split("--> statement-breakpoint")) {
    if (statement.trim()) await sql.unsafe(statement);
  }
}

async function migrateDatabase(databaseUrl: string): Promise<void> {
  await verifyMigrationBaseline(databaseUrl, migrationsDirectory);
  const db = createDb(databaseUrl);
  try {
    await migrate(db, { migrationsFolder: migrationsDirectory });
  } finally {
    await db.$client.end();
  }
}

async function migrateThroughPhase3(databaseUrl: string): Promise<void> {
  const migrations = await readRepositoryMigrations(migrationsDirectory);
  expect(migrations.slice(0, 5).map((entry) => entry.tag)).toEqual([
    "0000_phase0_auth",
    "0001_phase2_workspaces",
    "0002_phase2_notes",
    "0003_phase2_rate_limits",
    "0004_phase3_themes",
  ]);

  const client = postgres(databaseUrl, { max: 1, onnotice() {} });
  try {
    await client`create schema drizzle`;
    await client`
      create table drizzle.__drizzle_migrations (
        id serial primary key,
        hash text not null,
        created_at bigint
      )
    `;
    for (const migration of migrations.slice(0, 5)) {
      const source = await readFile(new URL(`./${migration.tag}.sql`, import.meta.url), "utf8");
      await client.begin(async (transaction) => {
        await applySql(transaction, source);
        await transaction`
          insert into drizzle.__drizzle_migrations (hash, created_at)
          values (${migration.hash}, ${migration.when})
        `;
      });
    }
  } finally {
    await client.end();
  }
}

async function journalRows(databaseUrl: string) {
  const client = postgres(databaseUrl, { max: 1 });
  try {
    return await client<{ hash: string; created_at: string }[]>`
      select hash, created_at
      from drizzle.__drizzle_migrations
      order by created_at, id
    `;
  } finally {
    await client.end();
  }
}

describe("Phase 5 jobs migration artifacts", () => {
  it("records exactly 0005_phase5_jobs after the frozen 0004 migration", async () => {
    const migrations = await readRepositoryMigrations(migrationsDirectory);
    expect(migrations.map((entry) => entry.tag).slice(-2)).toEqual([
      "0004_phase3_themes",
      "0005_phase5_jobs",
    ]);
    expect(await readFile(new URL("./meta/0005_snapshot.json", import.meta.url), "utf8")).toContain(
      '"public.jobs"',
    );
  });
});

describeWithPostgres("Phase 5 jobs PostgreSQL migration", () => {
  let admin: Sql;
  const databases = new Set<string>();

  beforeAll(() => {
    assertLoopbackDatabaseUrl(migrationDatabaseUrl!);
    assertLoopbackDatabaseUrl(runtimeDatabaseUrl!);
    const migrationUrl = new URL(migrationDatabaseUrl!);
    const runtimeUrl = new URL(runtimeDatabaseUrl!);
    if (
      migrationUrl.hostname !== runtimeUrl.hostname ||
      (migrationUrl.port || "5432") !== (runtimeUrl.port || "5432")
    ) {
      throw new Error("Migration and runtime PostgreSQL URLs must use the same local server");
    }
    admin = postgres(migrationDatabaseUrl!, { max: 1, onnotice() {} });
  });

  afterAll(async () => {
    for (const databaseName of databases) {
      await admin`
        select pg_catalog.pg_terminate_backend(activity.pid)
        from pg_catalog.pg_stat_activity activity
        where activity.datname = ${databaseName}
          and activity.pid <> pg_catalog.pg_backend_pid()
      `;
      await admin.unsafe(`drop database "${databaseName}"`);
    }
    await admin.end();
  }, 60_000);

  async function createTestDatabase(): Promise<{ databaseName: string; migrationUrl: string }> {
    const databaseName = `glyphquire_p5_jobs_${randomUUID().replaceAll("-", "")}`;
    expect(databaseName).toMatch(/^[a-z0-9_]+$/);
    await admin.unsafe(`create database "${databaseName}"`);
    databases.add(databaseName);
    return {
      databaseName,
      migrationUrl: urlForDatabase(migrationDatabaseUrl!, databaseName),
    };
  }

  it("migrates fresh, upgrades exact 0004, and reruns without journal drift", async () => {
    const repository = await readRepositoryMigrations(migrationsDirectory);

    const fresh = await createTestDatabase();
    await migrateDatabase(fresh.migrationUrl);
    expect(await journalRows(fresh.migrationUrl)).toEqual(
      repository.map((entry) => ({ hash: entry.hash, created_at: String(entry.when) })),
    );
    await migrateDatabase(fresh.migrationUrl);
    expect(await journalRows(fresh.migrationUrl)).toHaveLength(6);

    const upgraded = await createTestDatabase();
    await migrateThroughPhase3(upgraded.migrationUrl);
    expect((await journalRows(upgraded.migrationUrl)).map((row) => row.hash)).toEqual(
      repository.slice(0, 5).map((entry) => entry.hash),
    );
    await migrateDatabase(upgraded.migrationUrl);
    expect(await journalRows(upgraded.migrationUrl)).toEqual(
      repository.map((entry) => ({ hash: entry.hash, created_at: String(entry.when) })),
    );
  }, 120_000);

  it("rolls the 0005 DDL back atomically before a clean upgrade", async () => {
    const database = await createTestDatabase();
    await migrateThroughPhase3(database.migrationUrl);
    const source = await readFile(new URL("./0005_phase5_jobs.sql", import.meta.url), "utf8");
    const client = postgres(database.migrationUrl, { max: 1, onnotice() {} });
    try {
      await expect(
        client.begin(async (transaction) => {
          await applySql(transaction, source);
          throw new Error("force migration rollback");
        }),
      ).rejects.toThrow("force migration rollback");
      expect(
        await client<{ jobs: string | null; idempotency_records: string | null }[]>`
          select
            pg_catalog.to_regclass('public.jobs')::text as jobs,
            pg_catalog.to_regclass('public.idempotency_records')::text as idempotency_records
        `,
      ).toEqual([{ jobs: null, idempotency_records: null }]);
      expect(await journalRows(database.migrationUrl)).toHaveLength(5);
    } finally {
      await client.end();
    }

    await migrateDatabase(database.migrationUrl);
    expect(await journalRows(database.migrationUrl)).toHaveLength(6);
  }, 120_000);

  it("retains lifecycle targets, rejects malformed payload shapes, and preserves scope checks", async () => {
    const database = await createTestDatabase();
    await migrateDatabase(database.migrationUrl);
    const client = postgres(database.migrationUrl, { max: 1, onnotice() {} });
    const actorId = `phase5-jobs-${randomUUID()}`;
    const email = `${actorId}@example.test`;
    try {
      await client`
        insert into "user" (id, name, email)
        values (${actorId}, 'Phase 5 Jobs', ${email})
      `;
      const [workspace] = await client<{ id: string }[]>`
        insert into workspaces (personal_owner_id)
        values (${actorId})
        returning id
      `;
      const deletionId = randomUUID();
      const [lifecycleJob] = await client<{ id: string }[]>`
        insert into jobs (workspace_id, type, version, payload)
        values (
          ${workspace!.id},
          'workspace.purge',
          1,
          ${client.json({ workspaceId: workspace!.id, deletionId })}
        )
        returning id
      `;

      await expect(
        client`
          insert into jobs (workspace_id, type, version, payload)
          values (${workspace!.id}, 'asset.cleanup', 1, ${client.json([])})
        `,
      ).rejects.toMatchObject({ code: "23514", constraint_name: "jobs_payload_object_check" });
      await expect(
        client`
          insert into jobs (workspace_id, type, version, payload)
          values (null, 'asset.cleanup', 1, ${client.json({ workspaceId: workspace!.id })})
        `,
      ).rejects.toMatchObject({ code: "23514", constraint_name: "jobs_scope_check" });

      await client`delete from workspaces where id = ${workspace!.id}`;
      expect(
        await client<{ workspace_id: string | null; payload: unknown }[]>`
          select workspace_id, payload from jobs where id = ${lifecycleJob!.id}
        `,
      ).toEqual([
        {
          workspace_id: null,
          payload: { workspaceId: workspace!.id, deletionId },
        },
      ]);
    } finally {
      await client.end();
    }
  }, 120_000);

  it("allows runtime DML while denying role escalation, DDL, and migration-journal writes", async () => {
    const database = await createTestDatabase();
    await migrateDatabase(database.migrationUrl);
    const runtimeBase = new URL(runtimeDatabaseUrl!);
    const runtimeRole = decodeURIComponent(runtimeBase.username);
    const migrationRole = decodeURIComponent(new URL(migrationDatabaseUrl!).username);
    if (!/^[a-z_][a-z0-9_]{0,62}$/.test(runtimeRole)) {
      throw new Error("Runtime database role must be a simple PostgreSQL identifier");
    }
    if (!/^[a-z_][a-z0-9_]{0,62}$/.test(migrationRole)) {
      throw new Error("Migration database role must be a simple PostgreSQL identifier");
    }

    await admin.unsafe(`grant connect on database "${database.databaseName}" to "${runtimeRole}"`);
    const migration = postgres(database.migrationUrl, { max: 1, onnotice() {} });
    try {
      await migration.unsafe(`grant usage on schema public to "${runtimeRole}"`);
      await migration.unsafe(
        `grant select, insert, update, delete on all tables in schema public to "${runtimeRole}"`,
      );
      await migration.unsafe(`grant usage on all sequences in schema public to "${runtimeRole}"`);
    } finally {
      await migration.end();
    }

    runtimeBase.pathname = `/${database.databaseName}`;
    const runtime = postgres(runtimeBase.toString(), { max: 1, onnotice() {} });
    const actorId = `phase5-runtime-${randomUUID()}`;
    try {
      await runtime`
        insert into "user" (id, name, email)
        values (${actorId}, 'Runtime Job', ${`${actorId}@example.test`})
      `;
      const [workspace] = await runtime<{ id: string }[]>`
        insert into workspaces (personal_owner_id)
        values (${actorId})
        returning id
      `;
      const [job] = await runtime<{ id: string }[]>`
        insert into jobs (workspace_id, type, version, payload)
        values (
          ${workspace!.id},
          'asset.cleanup',
          1,
          ${runtime.json({ workspaceId: workspace!.id, assetId: randomUUID() })}
        )
        returning id
      `;
      expect(await runtime<{ id: string }[]>`select id from jobs where id = ${job!.id}`).toEqual([
        { id: job!.id },
      ]);

      await expect(runtime.unsafe(`set role "${migrationRole}"`)).rejects.toMatchObject({
        code: "42501",
      });
      await expect(
        runtime.unsafe("create table public.phase5_runtime_forbidden (id integer)"),
      ).rejects.toMatchObject({ code: "42501" });
      await expect(
        runtime`
          insert into drizzle.__drizzle_migrations (hash, created_at)
          values ('forbidden', 0)
        `,
      ).rejects.toMatchObject({ code: "42501" });
    } finally {
      await runtime.end();
    }
  }, 120_000);
});
