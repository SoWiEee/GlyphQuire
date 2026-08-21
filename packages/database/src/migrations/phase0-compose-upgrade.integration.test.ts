import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres, { type Sql } from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb } from "../client.js";
import { PHASE0_AUTH_TABLES, verifyMigrationBaseline } from "./verify-baseline.js";

const legacyDatabaseUrl = process.env.TEST_LEGACY_DATABASE_URL;
const migrationDatabaseUrl = process.env.TEST_MIGRATION_DATABASE_URL;
const runtimeDatabaseUrl = process.env.TEST_DATABASE_URL;
const hasUpgradeEnvironment = legacyDatabaseUrl && migrationDatabaseUrl && runtimeDatabaseUrl;
const describeWithLegacyPostgres = hasUpgradeEnvironment ? describe : describe.skip;
const migrationsDirectory = fileURLToPath(new URL("./", import.meta.url));
const roleUpgradeSqlUrl = new URL(
  "../../../../infra/postgres/upgrade/001_phase0_roles.sql",
  import.meta.url,
);

async function applySql(sql: Sql, source: string) {
  for (const statement of source.split("--> statement-breakpoint")) {
    if (statement.trim()) await sql.unsafe(statement);
  }
}

async function canConnect(databaseUrl: string) {
  const client = postgres(databaseUrl, { connect_timeout: 1, max: 1 });
  try {
    await client`select 1`;
    return true;
  } catch {
    return false;
  } finally {
    await client.end({ timeout: 0 });
  }
}

describeWithLegacyPostgres("Phase 0 local Compose role upgrade", () => {
  let legacy: Sql;

  beforeAll(() => {
    for (const rawUrl of [legacyDatabaseUrl!, migrationDatabaseUrl!, runtimeDatabaseUrl!]) {
      const url = new URL(rawUrl);
      if (!["127.0.0.1", "localhost"].includes(url.hostname)) {
        throw new Error("legacy Compose upgrade tests require a loopback PostgreSQL URL");
      }
      if (url.pathname !== "/glyphquire_dev") {
        throw new Error("legacy Compose upgrade tests require the glyphquire_dev database");
      }
    }
    legacy = postgres(legacyDatabaseUrl!, { max: 1, onnotice() {} });
  });

  afterAll(async () => {
    await legacy.end();
  });

  it("upgrades an existing legacy-owned volume idempotently and preserves least privilege", async () => {
    const publicTables = await legacy<{ table_name: string }[]>`
      select table_class.relname as table_name
      from pg_catalog.pg_class table_class
      join pg_catalog.pg_namespace namespace on namespace.oid = table_class.relnamespace
      where namespace.nspname = 'public'
        and table_class.relkind in ('r', 'p')
      order by table_class.relname
    `;
    if (publicTables.length === 0) {
      await applySql(
        legacy,
        await readFile(new URL("./0000_phase0_auth.sql", import.meta.url), "utf8"),
      );
    } else {
      expect(publicTables.map((row) => row.table_name)).toEqual(PHASE0_AUTH_TABLES);
    }

    expect(await canConnect(migrationDatabaseUrl!)).toBe(false);
    expect(await canConnect(runtimeDatabaseUrl!)).toBe(false);

    const upgradeSql = await readFile(roleUpgradeSqlUrl, "utf8");
    await legacy.unsafe(upgradeSql);
    await legacy.unsafe(upgradeSql);

    expect(await canConnect(migrationDatabaseUrl!)).toBe(true);
    expect(await canConnect(runtimeDatabaseUrl!)).toBe(true);

    const migration = postgres(migrationDatabaseUrl!, { max: 1, onnotice() {} });
    try {
      const [roles] = await migration<
        {
          migration_super: boolean;
          migration_createdb: boolean;
          migration_createrole: boolean;
          migration_inherit: boolean;
          migration_replication: boolean;
          migration_bypass_rls: boolean;
          app_super: boolean;
          app_createdb: boolean;
          app_createrole: boolean;
          app_inherit: boolean;
          app_replication: boolean;
          app_bypass_rls: boolean;
        }[]
      >`
        select
          migration.rolsuper as migration_super,
          migration.rolcreatedb as migration_createdb,
          migration.rolcreaterole as migration_createrole,
          migration.rolinherit as migration_inherit,
          migration.rolreplication as migration_replication,
          migration.rolbypassrls as migration_bypass_rls,
          app.rolsuper as app_super,
          app.rolcreatedb as app_createdb,
          app.rolcreaterole as app_createrole,
          app.rolinherit as app_inherit,
          app.rolreplication as app_replication,
          app.rolbypassrls as app_bypass_rls
        from pg_catalog.pg_roles migration
        cross join pg_catalog.pg_roles app
        where migration.rolname = 'glyphquire_migration'
          and app.rolname = 'glyphquire_app'
      `;
      expect(roles).toEqual({
        migration_super: false,
        migration_createdb: false,
        migration_createrole: false,
        migration_inherit: false,
        migration_replication: false,
        migration_bypass_rls: false,
        app_super: false,
        app_createdb: false,
        app_createrole: false,
        app_inherit: false,
        app_replication: false,
        app_bypass_rls: false,
      });

      const [ownership] = await migration<
        { database_owner: string; schema_owner: string; relation_owners: string[] }[]
      >`
        select
          pg_catalog.pg_get_userbyid(database_row.datdba) as database_owner,
          pg_catalog.pg_get_userbyid(namespace.nspowner) as schema_owner,
          array(
            select distinct pg_catalog.pg_get_userbyid(relation.relowner)
            from pg_catalog.pg_class relation
            join pg_catalog.pg_namespace relation_namespace
              on relation_namespace.oid = relation.relnamespace
            where relation_namespace.nspname = 'public'
              and relation.relkind in ('r', 'p', 'S')
          ) as relation_owners
        from pg_catalog.pg_database database_row
        cross join pg_catalog.pg_namespace namespace
        where database_row.datname = current_database()
          and namespace.nspname = 'public'
      `;
      expect(ownership).toEqual({
        database_owner: "glyphquire_migration",
        schema_owner: "glyphquire_migration",
        relation_owners: ["glyphquire_migration"],
      });
    } finally {
      await migration.end();
    }

    expect(await verifyMigrationBaseline(migrationDatabaseUrl!, migrationsDirectory)).toBe(
      "baselined",
    );
    const db = createDb(migrationDatabaseUrl!);
    try {
      await migrate(db, { migrationsFolder: migrationsDirectory });
    } finally {
      await db.$client.end();
    }

    await legacy.unsafe(upgradeSql);
    expect(await verifyMigrationBaseline(migrationDatabaseUrl!, migrationsDirectory)).toBe(
      "journaled",
    );

    const migrationAfterUpgrade = postgres(migrationDatabaseUrl!, { max: 1 });
    try {
      await migrationAfterUpgrade`create sequence public.phase0_upgrade_sequence`;
    } finally {
      await migrationAfterUpgrade.end();
    }

    const runtime = postgres(runtimeDatabaseUrl!, { max: 1 });
    const actorId = `phase0-upgrade-${randomUUID()}`;
    try {
      await runtime`
        insert into "user" (id, name, email)
        values (${actorId}, 'Upgrade Check', ${`${actorId}@example.test`})
      `;
      expect(await runtime<{ id: string }[]>`select id from "user" where id = ${actorId}`).toEqual([
        { id: actorId },
      ]);
      await runtime`update "user" set name = 'Updated' where id = ${actorId}`;
      await runtime`delete from "user" where id = ${actorId}`;

      expect(await runtime`select nextval('public.phase0_upgrade_sequence')`).toHaveLength(1);
      await expect(
        runtime`select setval('public.phase0_upgrade_sequence', 99)`,
      ).rejects.toMatchObject({ code: "42501" });
      await expect(
        runtime.unsafe("create table public.phase0_upgrade_denied (id integer)"),
      ).rejects.toMatchObject({ code: "42501" });
      await expect(
        runtime.unsafe("alter table public.workspaces add column denied text"),
      ).rejects.toMatchObject({ code: "42501" });
      await expect(runtime.unsafe("drop table public.workspace_members")).rejects.toMatchObject({
        code: "42501",
      });
      await expect(
        runtime.unsafe(
          "insert into drizzle.__drizzle_migrations (hash, created_at) values ('denied', 0)",
        ),
      ).rejects.toMatchObject({ code: "42501" });
    } finally {
      await runtime.end();
    }
  });
});
