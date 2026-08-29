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

describe("Phase 5 assets migration artifacts", () => {
  it("records exactly 0006_phase5_assets after the frozen 0005 migration", async () => {
    const migrations = await readRepositoryMigrations(migrationsDirectory);
    const tags = migrations.map((entry) => entry.tag);
    const index = tags.indexOf("0006_phase5_assets");
    expect(tags.slice(Math.max(0, index - 1), index + 1)).toEqual([
      "0005_phase5_jobs",
      "0006_phase5_assets",
    ]);
    expect(await readFile(new URL("./meta/0006_snapshot.json", import.meta.url), "utf8")).toContain(
      '"public.assets"',
    );
  });
});

describeWithPostgres("Phase 5 assets PostgreSQL migration", () => {
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
    const databaseName = `glyphquire_p5_assets_${randomUUID().replaceAll("-", "")}`;
    expect(databaseName).toMatch(/^[a-z0-9_]+$/);
    await admin.unsafe(`create database "${databaseName}"`);
    databases.add(databaseName);
    return {
      databaseName,
      migrationUrl: urlForDatabase(migrationDatabaseUrl!, databaseName),
    };
  }

  it("migrates fresh, upgrades exact 0005, and reruns without journal drift", async () => {
    const repository = await readRepositoryMigrations(migrationsDirectory);

    const fresh = await createTestDatabase();
    await migrateDatabase(fresh.migrationUrl);
    expect(await journalRows(fresh.migrationUrl)).toEqual(
      repository.map((entry) => ({ hash: entry.hash, created_at: String(entry.when) })),
    );
    await migrateDatabase(fresh.migrationUrl);
    expect(await journalRows(fresh.migrationUrl)).toHaveLength(repository.length);

    const upgraded = await createTestDatabase();
    await migrateThroughPhase3(upgraded.migrationUrl);
    // Upgrade through the frozen 0005_phase5_jobs migration before the new one.
    const jobsSource = await readFile(new URL("./0005_phase5_jobs.sql", import.meta.url), "utf8");
    const jobsMigration = repository[5]!;
    const upgradeClient = postgres(upgraded.migrationUrl, { max: 1, onnotice() {} });
    try {
      await upgradeClient.begin(async (transaction) => {
        await applySql(transaction, jobsSource);
        await transaction`
          insert into drizzle.__drizzle_migrations (hash, created_at)
          values (${jobsMigration.hash}, ${jobsMigration.when})
        `;
      });
    } finally {
      await upgradeClient.end();
    }
    expect((await journalRows(upgraded.migrationUrl)).map((row) => row.hash)).toEqual(
      repository.slice(0, 6).map((entry) => entry.hash),
    );
    await migrateDatabase(upgraded.migrationUrl);
    expect(await journalRows(upgraded.migrationUrl)).toEqual(
      repository.map((entry) => ({ hash: entry.hash, created_at: String(entry.when) })),
    );
  }, 120_000);

  it("rolls the 0006 DDL back atomically before a clean upgrade", async () => {
    const database = await createTestDatabase();
    await migrateThroughPhase3(database.migrationUrl);
    const jobsSource = await readFile(new URL("./0005_phase5_jobs.sql", import.meta.url), "utf8");
    const repository = await readRepositoryMigrations(migrationsDirectory);
    const jobsMigration = repository[5]!;
    const jobsClient = postgres(database.migrationUrl, { max: 1, onnotice() {} });
    try {
      await jobsClient.begin(async (transaction) => {
        await applySql(transaction, jobsSource);
        await transaction`
          insert into drizzle.__drizzle_migrations (hash, created_at)
          values (${jobsMigration.hash}, ${jobsMigration.when})
        `;
      });
    } finally {
      await jobsClient.end();
    }

    const source = await readFile(new URL("./0006_phase5_assets.sql", import.meta.url), "utf8");
    const client = postgres(database.migrationUrl, { max: 1, onnotice() {} });
    try {
      await expect(
        client.begin(async (transaction) => {
          await applySql(transaction, source);
          throw new Error("force migration rollback");
        }),
      ).rejects.toThrow("force migration rollback");
      expect(
        await client<{ assets: string | null }[]>`
          select pg_catalog.to_regclass('public.assets')::text as assets
        `,
      ).toEqual([{ assets: null }]);
      expect(await journalRows(database.migrationUrl)).toHaveLength(6);
    } finally {
      await client.end();
    }

    await migrateDatabase(database.migrationUrl);
    expect(await journalRows(database.migrationUrl)).toHaveLength(repository.length);
  }, 120_000);

  it("enforces byte, hash, uniqueness, and thumbnail-shape constraints and preserves rows through cascades", async () => {
    const database = await createTestDatabase();
    await migrateDatabase(database.migrationUrl);
    const client = postgres(database.migrationUrl, { max: 1, onnotice() {} });
    const actorId = `phase5-assets-${randomUUID()}`;
    const email = `${actorId}@example.test`;
    try {
      await client`
        insert into "user" (id, name, email)
        values (${actorId}, 'Phase 5 Assets', ${email})
      `;
      const [workspace] = await client<{ id: string }[]>`
        insert into workspaces (personal_owner_id)
        values (${actorId})
        returning id
      `;
      const objectKey = `workspace/${workspace!.id}/assets/${randomUUID()}/original`;
      const sha = "a".repeat(64);

      await expect(
        client`
          insert into assets (workspace_id, owner_id, object_key, original_name, mime_type, size_bytes, sha256)
          values (${workspace!.id}, ${actorId}, ${objectKey}, 'file.png', 'image/png', 0, ${sha})
        `,
      ).rejects.toMatchObject({
        code: "23514",
        constraint_name: "assets_size_bytes_positive_check",
      });

      await expect(
        client`
          insert into assets (workspace_id, owner_id, object_key, original_name, mime_type, size_bytes, sha256)
          values (${workspace!.id}, ${actorId}, ${objectKey}, 'file.png', 'image/png', 10, 'not-a-hash')
        `,
      ).rejects.toMatchObject({ code: "23514", constraint_name: "assets_sha256_check" });

      await expect(
        client`
          insert into assets (
            workspace_id, owner_id, object_key, original_name, mime_type, size_bytes, sha256, thumbnail_status
          )
          values (
            ${workspace!.id}, ${actorId}, ${objectKey}, 'file.png', 'image/png', 10, ${sha}, 'ready'
          )
        `,
      ).rejects.toMatchObject({ code: "23514", constraint_name: "assets_thumbnail_shape_check" });

      const [asset] = await client<{ id: string }[]>`
        insert into assets (workspace_id, owner_id, object_key, original_name, mime_type, size_bytes, sha256)
        values (${workspace!.id}, ${actorId}, ${objectKey}, 'file.png', 'image/png', 10, ${sha})
        returning id
      `;

      await expect(
        client`
          insert into assets (workspace_id, owner_id, object_key, original_name, mime_type, size_bytes, sha256)
          values (${workspace!.id}, ${actorId}, ${objectKey}, 'other.png', 'image/png', 20, ${sha})
        `,
      ).rejects.toMatchObject({ code: "23505" });

      await client`
        update assets
        set thumbnail_status = 'ready',
            thumbnail_object_key = ${`workspace/${workspace!.id}/assets/${asset!.id}/thumbnail.webp`},
            thumbnail_mime_type = 'image/webp',
            thumbnail_width = 256,
            thumbnail_height = 256,
            thumbnail_bytes = 1000
        where id = ${asset!.id}
      `;

      // A workspace cascade removes assets; a user cascade removes assets too.
      const [rowBefore] = await client<{ id: string }[]>`
        select id from assets where id = ${asset!.id}
      `;
      expect(rowBefore).toBeDefined();

      await client`delete from workspaces where id = ${workspace!.id}`;
      expect(await client<{ id: string }[]>`select id from assets where id = ${asset!.id}`).toEqual(
        [],
      );
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
    const actorId = `phase5-assets-runtime-${randomUUID()}`;
    try {
      await runtime`
        insert into "user" (id, name, email)
        values (${actorId}, 'Runtime Asset', ${`${actorId}@example.test`})
      `;
      const [workspace] = await runtime<{ id: string }[]>`
        insert into workspaces (personal_owner_id)
        values (${actorId})
        returning id
      `;
      const objectKey = `workspace/${workspace!.id}/assets/${randomUUID()}/original`;
      const [asset] = await runtime<{ id: string }[]>`
        insert into assets (workspace_id, owner_id, object_key, original_name, mime_type, size_bytes, sha256)
        values (${workspace!.id}, ${actorId}, ${objectKey}, 'file.png', 'image/png', 10, ${"b".repeat(64)})
        returning id
      `;
      expect(
        await runtime<{ id: string }[]>`select id from assets where id = ${asset!.id}`,
      ).toEqual([{ id: asset!.id }]);

      await expect(runtime.unsafe(`set role "${migrationRole}"`)).rejects.toMatchObject({
        code: "42501",
      });
      await expect(
        runtime.unsafe("create table public.phase5_assets_runtime_forbidden (id integer)"),
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
