import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { getTableName } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres, { type Sql } from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb } from "../client.js";
import { accountDeletions, workspaceDeletions } from "../index.js";
import { readRepositoryMigrations, verifyMigrationBaseline } from "./verify-baseline.js";

const migrationDatabaseUrl = process.env.TEST_MIGRATION_DATABASE_URL;
const runtimeDatabaseUrl = process.env.TEST_DATABASE_URL;
const describeWithPostgres = migrationDatabaseUrl && runtimeDatabaseUrl ? describe : describe.skip;
const migrationsDirectory = fileURLToPath(new URL("./", import.meta.url));

function databaseUrl(base: string, name: string): string {
  const parsed = new URL(base);
  parsed.pathname = `/${name}`;
  return parsed.toString();
}

function assertLoopback(value: string): void {
  if (!["127.0.0.1", "localhost", "[::1]"].includes(new URL(value).hostname)) {
    throw new Error("Lifecycle migration tests require loopback PostgreSQL");
  }
}

async function applySql(client: Pick<Sql, "unsafe">, source: string): Promise<void> {
  for (const statement of source.split("--> statement-breakpoint")) {
    if (statement.trim()) await client.unsafe(statement);
  }
}

async function migrateDatabase(url: string): Promise<void> {
  await verifyMigrationBaseline(url, migrationsDirectory);
  const db = createDb(url);
  try {
    await migrate(db, { migrationsFolder: migrationsDirectory });
  } finally {
    await db.$client.end();
  }
}

async function migrateThrough0009(url: string): Promise<void> {
  const migrations = await readRepositoryMigrations(migrationsDirectory);
  expect(migrations.slice(0, 10).at(-1)?.tag).toBe("0009_phase5_share_links");
  const client = postgres(url, { max: 1, onnotice() {} });
  try {
    await client`create schema drizzle`;
    await client`
      create table drizzle.__drizzle_migrations (
        id serial primary key,
        hash text not null,
        created_at bigint
      )
    `;
    for (const migration of migrations.slice(0, 10)) {
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

describe("Phase 5 lifecycle migration artifacts", () => {
  it("exports both durable coordinator tables", () => {
    expect(getTableName(workspaceDeletions)).toBe("workspace_deletions");
    expect(getTableName(accountDeletions)).toBe("account_deletions");
  });

  it("preserves migrations 0000 through 0009 byte-for-byte and appends only 0010", async () => {
    const frozen = [
      ["0000_phase0_auth", "7fbba803d17ce335f8acc41fd7027c3c1278d4af79225c48ac6d0ab885028863"],
      [
        "0001_phase2_workspaces",
        "c0aac84d7bb3fd4766604dfa46d2f0df18b5b4f027e42e5ec6696e9386f1f162",
      ],
      ["0002_phase2_notes", "7d4bb87aae2f390f35070ed3e696a92222d2613bef64de573f3314eddbae3f3c"],
      [
        "0003_phase2_rate_limits",
        "6b612d6e34faad76b973a6fb0701168d28b34f78921be444c26e6485b3e61562",
      ],
      ["0004_phase3_themes", "49cdc8578e087d7c20db0e5d3cd55d6a11fd33767892bebe278a6d8b2f8c169e"],
      ["0005_phase5_jobs", "6891de73469132b56f1b9292ab2a2b4fcc73c29095ef5373c901adc3da13bdd8"],
      ["0006_phase5_assets", "8def4960a411f9f49fc1ee035065325bc9a5563bca2ac8d759c170e5a23b7285"],
      ["0007_phase5_search", "5a764469e55745b1daffb4fcc66d7ebf54e08d8bea823192d71a0b1b6d42873a"],
      ["0008_phase5_exports", "9a6ad7ed95a5e65b0dc0e2daba5e3720c28e822752b32ff254565e754b42b14e"],
      [
        "0009_phase5_share_links",
        "cad40a10a1f8649a73b60b45d4cd27b2c8e03771d323028a90c451eaa8385fab",
      ],
    ] as const;
    for (const [tag, hash] of frozen) {
      const bytes = await readFile(new URL(`./${tag}.sql`, import.meta.url));
      expect(createHash("sha256").update(bytes).digest("hex"), tag).toBe(hash);
    }
    const repository = await readRepositoryMigrations(migrationsDirectory);
    expect(repository.map((entry) => entry.tag).slice(-2)).toEqual([
      "0009_phase5_share_links",
      "0010_phase5_lifecycle",
    ]);
    const snapshot = await readFile(new URL("./meta/0010_snapshot.json", import.meta.url), "utf8");
    expect(snapshot).toContain('"public.workspace_deletions"');
    expect(snapshot).toContain('"public.account_deletions"');
  });
});

describeWithPostgres("Phase 5 lifecycle PostgreSQL migration", () => {
  let admin: Sql;
  const databases = new Set<string>();

  beforeAll(() => {
    assertLoopback(migrationDatabaseUrl!);
    assertLoopback(runtimeDatabaseUrl!);
    admin = postgres(migrationDatabaseUrl!, { max: 1, onnotice() {} });
  });

  afterAll(async () => {
    for (const name of databases) {
      await admin`
        select pg_catalog.pg_terminate_backend(pid)
        from pg_catalog.pg_stat_activity
        where datname = ${name} and pid <> pg_catalog.pg_backend_pid()
      `;
      await admin.unsafe(`drop database "${name}"`);
    }
    await admin.end();
  }, 60_000);

  async function disposable() {
    const name = `glyphquire_p5_lifecycle_${randomUUID().replaceAll("-", "")}`;
    expect(name).toMatch(/^[a-z0-9_]+$/u);
    await admin.unsafe(`create database "${name}"`);
    databases.add(name);
    return databaseUrl(migrationDatabaseUrl!, name);
  }

  it("migrates fresh, upgrades exact 0009, and reruns without journal drift", async () => {
    const repository = await readRepositoryMigrations(migrationsDirectory);
    const fresh = await disposable();
    await migrateDatabase(fresh);
    await migrateDatabase(fresh);
    const freshClient = postgres(fresh, { max: 1 });
    expect(
      await freshClient<
        { count: string }[]
      >`select count(*)::text as count from drizzle.__drizzle_migrations`,
    ).toEqual([{ count: String(repository.length) }]);
    await freshClient.end();

    const upgraded = await disposable();
    await migrateThrough0009(upgraded);
    await migrateDatabase(upgraded);
    const upgradedClient = postgres(upgraded, { max: 1 });
    expect(
      await upgradedClient<
        { count: string }[]
      >`select count(*)::text as count from drizzle.__drizzle_migrations`,
    ).toEqual([{ count: String(repository.length) }]);
    await upgradedClient.end();
  }, 180_000);

  it("rolls 0010 back atomically without changing pre-existing rows", async () => {
    const url = await disposable();
    await migrateThrough0009(url);
    const client = postgres(url, { max: 1, onnotice() {} });
    const actorId = `lifecycle-rollback-${randomUUID()}`;
    try {
      await client`
        insert into "user" (id, name, email)
        values (${actorId}, 'Lifecycle rollback', ${`${actorId}@example.test`})
      `;
      const [workspace] = await client<{ id: string }[]>`
        insert into workspaces (personal_owner_id) values (${actorId}) returning id
      `;
      const source = await readFile(
        new URL("./0010_phase5_lifecycle.sql", import.meta.url),
        "utf8",
      );
      await expect(
        client.begin(async (transaction) => {
          await applySql(transaction, source);
          throw new Error("force rollback");
        }),
      ).rejects.toThrow("force rollback");
      expect(await client`select id from workspaces where id = ${workspace!.id}`).toHaveLength(1);
      expect(
        await client<{ table_name: string | null }[]>`
          select pg_catalog.to_regclass('public.workspace_deletions')::text as table_name
        `,
      ).toEqual([{ table_name: null }]);
    } finally {
      await client.end();
    }
  }, 120_000);
});
