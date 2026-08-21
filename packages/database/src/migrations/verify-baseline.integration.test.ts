import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres, { type Sql } from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb } from "../client.js";
import { readRepositoryMigrations, verifyMigrationBaseline } from "./verify-baseline.js";

const migrationDatabaseUrl = process.env.TEST_MIGRATION_DATABASE_URL;
const describeWithPostgres = migrationDatabaseUrl ? describe : describe.skip;
const migrationsDirectory = fileURLToPath(new URL("./", import.meta.url));
const phase0SqlPath = new URL("./0000_phase0_auth.sql", import.meta.url);
const credentialPasswordHash =
  "94c9f555be93e894924615c0b2bae671:f711b1d1ba1270ac984d224d5f74efe5aa8426c01658b6e8904018c5336c4181b6b3d5bbf5eab91eeea7b151e8b9f55d6d844af847a2891102ab2062d69bcc3f";

function urlForDatabase(databaseName: string) {
  const url = new URL(migrationDatabaseUrl!);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

async function applySql(sql: Sql, source: string) {
  for (const statement of source.split("--> statement-breakpoint")) {
    if (statement.trim()) await sql.unsafe(statement);
  }
}

async function applyPhase0(databaseUrl: string) {
  const client = postgres(databaseUrl, { max: 1, onnotice() {} });
  try {
    await applySql(client, await readFile(phase0SqlPath, "utf8"));
  } finally {
    await client.end();
  }
}

async function migrateDatabase(databaseUrl: string) {
  await verifyMigrationBaseline(databaseUrl, migrationsDirectory);
  const db = createDb(databaseUrl);
  try {
    await migrate(db, { migrationsFolder: migrationsDirectory });
  } finally {
    await db.$client.end();
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

async function phase2ArtifactState(databaseUrl: string) {
  const client = postgres(databaseUrl, { max: 1 });
  try {
    const [state] = await client<
      {
        issuer_column: boolean;
        workspaces_table: string | null;
        members_table: string | null;
      }[]
    >`
      select
        exists (
          select 1
          from pg_catalog.pg_attribute attribute
          where attribute.attrelid = 'public.account'::regclass
            and attribute.attname = 'issuer'
            and not attribute.attisdropped
        ) as issuer_column,
        pg_catalog.to_regclass('public.workspaces')::text as workspaces_table,
        pg_catalog.to_regclass('public.workspace_members')::text as members_table
    `;
    return state;
  } finally {
    await client.end();
  }
}

async function authCatalog(databaseUrl: string) {
  const client = postgres(databaseUrl, { max: 1 });
  try {
    const columns = await client<
      {
        table_name: string;
        column_name: string;
        ordinal_position: number;
        sql_type: string;
        not_null: boolean;
        default_expression: string | null;
      }[]
    >`
      select
        table_class.relname as table_name,
        attribute.attname as column_name,
        attribute.attnum as ordinal_position,
        pg_catalog.format_type(attribute.atttypid, attribute.atttypmod) as sql_type,
        attribute.attnotnull as not_null,
        pg_catalog.pg_get_expr(default_value.adbin, default_value.adrelid) as default_expression
      from pg_catalog.pg_class table_class
      join pg_catalog.pg_namespace namespace on namespace.oid = table_class.relnamespace
      join pg_catalog.pg_attribute attribute on attribute.attrelid = table_class.oid
      left join pg_catalog.pg_attrdef default_value
        on default_value.adrelid = table_class.oid
        and default_value.adnum = attribute.attnum
      where namespace.nspname = 'public'
        and table_class.relname in ('account', 'session', 'user', 'verification')
        and attribute.attnum > 0
        and not attribute.attisdropped
      order by table_class.relname, attribute.attnum
    `;
    const constraints = await client<
      { table_name: string; constraint_name: string; definition: string }[]
    >`
      select
        table_class.relname as table_name,
        constraint_row.conname as constraint_name,
        pg_catalog.pg_get_constraintdef(constraint_row.oid, true) as definition
      from pg_catalog.pg_constraint constraint_row
      join pg_catalog.pg_class table_class on table_class.oid = constraint_row.conrelid
      join pg_catalog.pg_namespace namespace on namespace.oid = table_class.relnamespace
      where namespace.nspname = 'public'
        and table_class.relname in ('account', 'session', 'user', 'verification')
      order by table_class.relname, constraint_row.conname
    `;
    const indexes = await client<{ table_name: string; index_name: string; definition: string }[]>`
      select
        table_class.relname as table_name,
        index_class.relname as index_name,
        pg_catalog.pg_get_indexdef(index_class.oid) as definition
      from pg_catalog.pg_index index_row
      join pg_catalog.pg_class table_class on table_class.oid = index_row.indrelid
      join pg_catalog.pg_namespace namespace on namespace.oid = table_class.relnamespace
      join pg_catalog.pg_class index_class on index_class.oid = index_row.indexrelid
      where namespace.nspname = 'public'
        and table_class.relname in ('account', 'session', 'user', 'verification')
      order by table_class.relname, index_class.relname
    `;
    return { columns: [...columns], constraints: [...constraints], indexes: [...indexes] };
  } finally {
    await client.end();
  }
}

describeWithPostgres("migration baseline issuer upgrade", () => {
  let admin: Sql;
  const databases = new Set<string>();

  beforeAll(() => {
    admin = postgres(migrationDatabaseUrl!, { max: 1 });
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
  });

  async function createTestDatabase() {
    const databaseName = `glyphquire_t2_${randomUUID().replaceAll("-", "")}`;
    expect(databaseName).toMatch(/^[a-z0-9_]+$/);
    await admin.unsafe(`create database "${databaseName}"`);
    databases.add(databaseName);
    return urlForDatabase(databaseName);
  }

  async function insertLegacyCredential(
    databaseUrl: string,
    options: { duplicate?: boolean } = {},
  ) {
    const client = postgres(databaseUrl, { max: 1 });
    const userId = `legacy-${randomUUID()}`;
    const email = `${userId}@example.test`;
    try {
      await client`
        insert into "user" (id, name, email)
        values (${userId}, 'Legacy User', ${email})
      `;
      await client`
        insert into account (id, account_id, provider_id, user_id, password)
        values (${`account-${randomUUID()}`}, ${userId}, 'credential', ${userId}, ${credentialPasswordHash})
      `;
      if (options.duplicate) {
        await client`
          insert into account (id, account_id, provider_id, user_id, password)
          values (${`account-${randomUUID()}`}, ${userId}, 'credential', ${userId}, ${credentialPasswordHash})
        `;
      }
    } finally {
      await client.end();
    }
    return { userId, email };
  }

  it("produces the same final auth catalog for fresh and credential-upgraded databases and reruns", async () => {
    const freshUrl = await createTestDatabase();
    const upgradedUrl = await createTestDatabase();

    await migrateDatabase(freshUrl);
    await migrateDatabase(freshUrl);

    await applyPhase0(upgradedUrl);
    const legacy = await insertLegacyCredential(upgradedUrl);
    expect(await verifyMigrationBaseline(upgradedUrl, migrationsDirectory)).toBe("baselined");
    expect(await journalRows(upgradedUrl)).toHaveLength(1);
    await migrateDatabase(upgradedUrl);
    await migrateDatabase(upgradedUrl);

    const upgradedClient = postgres(upgradedUrl, { max: 1 });
    try {
      const [identity] = await upgradedClient<{ issuer: string; password: string | null }[]>`
        select issuer, password
        from account
        where user_id = ${legacy.userId}
      `;
      expect(identity).toEqual({
        issuer: "local:credential",
        password: credentialPasswordHash,
      });
    } finally {
      await upgradedClient.end();
    }

    const repositoryMigrations = await readRepositoryMigrations(migrationsDirectory);
    const expectedJournal = repositoryMigrations.map((entry) => ({
      hash: entry.hash,
      created_at: String(entry.when),
    }));
    expect(await journalRows(freshUrl)).toEqual(expectedJournal);
    expect(await journalRows(upgradedUrl)).toEqual(expectedJournal);
    expect(await authCatalog(upgradedUrl)).toEqual(await authCatalog(freshUrl));
  });

  it("fails closed when a legacy OAuth account has no trustworthy issuer", async () => {
    const databaseUrl = await createTestDatabase();
    await applyPhase0(databaseUrl);
    const client = postgres(databaseUrl, { max: 1 });
    const userId = `oauth-${randomUUID()}`;
    try {
      await client`
        insert into "user" (id, name, email)
        values (${userId}, 'OAuth User', ${`${userId}@example.test`})
      `;
      await client`
        insert into account (id, account_id, provider_id, user_id)
        values (${`account-${randomUUID()}`}, 'remote-subject', 'github', ${userId})
      `;
    } finally {
      await client.end();
    }

    await expect(migrateDatabase(databaseUrl)).rejects.toThrow(
      "cannot infer issuer for legacy account rows",
    );
    expect(await journalRows(databaseUrl)).toHaveLength(1);
    expect(await phase2ArtifactState(databaseUrl)).toEqual({
      issuer_column: false,
      workspaces_table: null,
      members_table: null,
    });
  });

  it("fails closed when credential backfill would create a duplicate identity", async () => {
    const databaseUrl = await createTestDatabase();
    await applyPhase0(databaseUrl);
    await insertLegacyCredential(databaseUrl, { duplicate: true });

    await expect(migrateDatabase(databaseUrl)).rejects.toThrow("duplicate account identity");
    expect(await journalRows(databaseUrl)).toHaveLength(1);
    expect(await phase2ArtifactState(databaseUrl)).toEqual({
      issuer_column: false,
      workspaces_table: null,
      members_table: null,
    });
  });
});
