import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import postgres from "postgres";
import { migrationEnvSchema } from "@glyphquire/shared";

export const PHASE0_AUTH_TABLES = ["account", "session", "user", "verification"] as const;

export const PHASE0_AUTH_SQL_SHA256 =
  "7fbba803d17ce335f8acc41fd7027c3c1278d4af79225c48ac6d0ab885028863";
export const PHASE0_AUTH_SNAPSHOT_SHA256 =
  "ddbdd01656f226667fc4e9b8533d946d8d57ed643d580ade86d4451a27c0be66";

const PHASE2_TABLES = [
  "account",
  "session",
  "user",
  "verification",
  "workspace_members",
  "workspaces",
] as const;

interface JournalEntry {
  idx: number;
  version: string;
  when: number;
  tag: string;
  breakpoints: boolean;
}

interface JournalFile {
  version: string;
  dialect: string;
  entries: JournalEntry[];
}

export interface RepositoryMigration extends JournalEntry {
  hash: string;
}

type FingerprintColumn = [
  table: string,
  column: string,
  ordinal: number,
  sqlType: string,
  notNull: boolean,
  defaultExpression: string | null,
];

type FingerprintForeignKey = [
  table: string,
  name: string,
  columns: string[],
  referencedTable: string,
  referencedColumns: string[],
  onUpdate: string,
  onDelete: string,
];

type FingerprintIndex = [
  table: string,
  name: string,
  method: string,
  unique: boolean,
  primary: boolean,
  columns: string[],
  expression: string | null,
  predicate: string | null,
];

type FingerprintUniqueConstraint = [
  table: string,
  name: string,
  kind: string,
  columns: string[],
  deferrable: boolean,
  initiallyDeferred: boolean,
];

interface Phase0Fingerprint {
  columns: FingerprintColumn[];
  foreignKeys: FingerprintForeignKey[];
  indexes: FingerprintIndex[];
  uniqueConstraints: FingerprintUniqueConstraint[];
  checks: [table: string, name: string, definition: string][];
}

const EXPECTED_PHASE0_FINGERPRINT: Phase0Fingerprint = {
  columns: [
    ["account", "id", 1, "text", true, null],
    ["account", "account_id", 2, "text", true, null],
    ["account", "provider_id", 3, "text", true, null],
    ["account", "user_id", 4, "text", true, null],
    ["account", "access_token", 5, "text", false, null],
    ["account", "refresh_token", 6, "text", false, null],
    ["account", "id_token", 7, "text", false, null],
    ["account", "access_token_expires_at", 8, "timestamp without time zone", false, null],
    ["account", "refresh_token_expires_at", 9, "timestamp without time zone", false, null],
    ["account", "scope", 10, "text", false, null],
    ["account", "password", 11, "text", false, null],
    ["account", "created_at", 12, "timestamp without time zone", true, "now()"],
    ["account", "updated_at", 13, "timestamp without time zone", true, "now()"],
    ["session", "id", 1, "text", true, null],
    ["session", "expires_at", 2, "timestamp without time zone", true, null],
    ["session", "token", 3, "text", true, null],
    ["session", "created_at", 4, "timestamp without time zone", true, "now()"],
    ["session", "updated_at", 5, "timestamp without time zone", true, "now()"],
    ["session", "ip_address", 6, "text", false, null],
    ["session", "user_agent", 7, "text", false, null],
    ["session", "user_id", 8, "text", true, null],
    ["user", "id", 1, "text", true, null],
    ["user", "name", 2, "text", true, null],
    ["user", "email", 3, "text", true, null],
    ["user", "email_verified", 4, "boolean", true, "false"],
    ["user", "image", 5, "text", false, null],
    ["user", "created_at", 6, "timestamp without time zone", true, "now()"],
    ["user", "updated_at", 7, "timestamp without time zone", true, "now()"],
    ["verification", "id", 1, "text", true, null],
    ["verification", "identifier", 2, "text", true, null],
    ["verification", "value", 3, "text", true, null],
    ["verification", "expires_at", 4, "timestamp without time zone", true, null],
    ["verification", "created_at", 5, "timestamp without time zone", true, "now()"],
    ["verification", "updated_at", 6, "timestamp without time zone", true, "now()"],
  ],
  foreignKeys: [
    ["account", "account_user_id_user_id_fk", ["user_id"], "user", ["id"], "a", "c"],
    ["session", "session_user_id_user_id_fk", ["user_id"], "user", ["id"], "a", "c"],
  ],
  indexes: [
    ["account", "account_pkey", "btree", true, true, ["id"], null, null],
    ["account", "account_userId_idx", "btree", false, false, ["user_id"], null, null],
    ["session", "session_pkey", "btree", true, true, ["id"], null, null],
    ["session", "session_token_unique", "btree", true, false, ["token"], null, null],
    ["session", "session_userId_idx", "btree", false, false, ["user_id"], null, null],
    ["user", "user_email_unique", "btree", true, false, ["email"], null, null],
    ["user", "user_pkey", "btree", true, true, ["id"], null, null],
    [
      "verification",
      "verification_identifier_idx",
      "btree",
      false,
      false,
      ["identifier"],
      null,
      null,
    ],
    ["verification", "verification_pkey", "btree", true, true, ["id"], null, null],
  ],
  uniqueConstraints: [
    ["account", "account_pkey", "p", ["id"], false, false],
    ["session", "session_pkey", "p", ["id"], false, false],
    ["session", "session_token_unique", "u", ["token"], false, false],
    ["user", "user_email_unique", "u", ["email"], false, false],
    ["user", "user_pkey", "p", ["id"], false, false],
    ["verification", "verification_pkey", "p", ["id"], false, false],
  ],
  checks: [],
};

const EXPECTED_PHASE2_AUTH_FINGERPRINT: Phase0Fingerprint = {
  columns: [
    ...EXPECTED_PHASE0_FINGERPRINT.columns.slice(0, 13),
    ["account", "issuer", 14, "text", true, null],
    ...EXPECTED_PHASE0_FINGERPRINT.columns.slice(13),
  ],
  foreignKeys: EXPECTED_PHASE0_FINGERPRINT.foreignKeys,
  indexes: [
    [
      "account",
      "account_issuer_accountId_uidx",
      "btree",
      true,
      false,
      ["issuer", "account_id"],
      null,
      null,
    ],
    ...EXPECTED_PHASE0_FINGERPRINT.indexes,
  ],
  uniqueConstraints: EXPECTED_PHASE0_FINGERPRINT.uniqueConstraints,
  checks: EXPECTED_PHASE0_FINGERPRINT.checks,
};

interface ColumnRow {
  table_name: string;
  column_name: string;
  ordinal_position: number;
  sql_type: string;
  not_null: boolean;
  default_expression: string | null;
}

interface ForeignKeyRow {
  table_name: string;
  constraint_name: string;
  columns: string[];
  referenced_table: string;
  referenced_columns: string[];
  on_update: string;
  on_delete: string;
}

interface IndexRow {
  table_name: string;
  index_name: string;
  method: string;
  is_unique: boolean;
  is_primary: boolean;
  columns: string[];
  expression: string | null;
  predicate: string | null;
}

interface UniqueConstraintRow {
  table_name: string;
  constraint_name: string;
  kind: string;
  columns: string[];
  is_deferrable: boolean;
  is_deferred: boolean;
}

interface CheckRow {
  table_name: string;
  constraint_name: string;
  definition: string;
}

interface MigrationRow {
  id: number;
  hash: string;
  created_at: string | number;
}

function fail(message: string): never {
  throw new Error(`Migration baseline verification failed: ${message}`);
}

function assertExactFingerprint(actual: Phase0Fingerprint) {
  if (JSON.stringify(actual) !== JSON.stringify(EXPECTED_PHASE0_FINGERPRINT)) {
    fail("the public Better Auth schema does not match the exact Phase 0 fingerprint");
  }
}

function assertExactPhase2AuthFingerprint(actual: Phase0Fingerprint) {
  if (JSON.stringify(actual) !== JSON.stringify(EXPECTED_PHASE2_AUTH_FINGERPRINT)) {
    fail("the public Better Auth schema does not match the exact Phase 2 fingerprint");
  }
}

function assertJournalPrefix(
  databaseRows: readonly MigrationRow[],
  repositoryMigrations: readonly RepositoryMigration[],
) {
  if (databaseRows.length === 0) return;
  if (databaseRows.length > repositoryMigrations.length) {
    fail("the database migration journal is ahead of the repository journal");
  }

  databaseRows.forEach((row, index) => {
    const repositoryMigration = repositoryMigrations[index];
    if (
      !repositoryMigration ||
      row.hash !== repositoryMigration.hash ||
      Number(row.created_at) !== repositoryMigration.when
    ) {
      fail("the database migration journal hash or timestamp does not match the repository");
    }
  });
}

export async function readRepositoryMigrations(
  migrationsDirectory: string,
): Promise<RepositoryMigration[]> {
  const journalPath = join(migrationsDirectory, "meta", "_journal.json");
  let journal: JournalFile;
  try {
    journal = JSON.parse(await readFile(journalPath, "utf8")) as JournalFile;
  } catch {
    return fail("the repository migration journal is missing or invalid JSON");
  }

  if (
    journal.version !== "7" ||
    journal.dialect !== "postgresql" ||
    !Array.isArray(journal.entries) ||
    journal.entries.length === 0
  ) {
    fail("the repository migration journal metadata is invalid");
  }

  const migrations: RepositoryMigration[] = [];
  for (const [position, entry] of journal.entries.entries()) {
    if (
      entry.idx !== position ||
      entry.version !== journal.version ||
      !Number.isSafeInteger(entry.when) ||
      entry.when <= 0 ||
      entry.breakpoints !== true ||
      (position > 0 && entry.when <= journal.entries[position - 1]!.when)
    ) {
      fail("the repository migration journal sequence is invalid");
    }

    let migrationSql: string;
    try {
      migrationSql = await readFile(join(migrationsDirectory, `${entry.tag}.sql`), "utf8");
    } catch {
      return fail(`the SQL file for migration index ${entry.idx} is missing`);
    }

    migrations.push({
      ...entry,
      hash: createHash("sha256").update(migrationSql).digest("hex"),
    });
  }

  if (migrations[0]?.tag !== "0000_phase0_auth") {
    fail("migration index 0000 is not the committed Phase 0 auth baseline");
  }
  if (migrations[0].hash !== PHASE0_AUTH_SQL_SHA256) {
    fail("the committed Phase 0 auth SQL hash does not match the frozen baseline");
  }

  let baselineSnapshot: Buffer;
  try {
    baselineSnapshot = await readFile(join(migrationsDirectory, "meta", "0000_snapshot.json"));
  } catch {
    return fail("the committed Phase 0 auth snapshot is missing");
  }
  if (createHash("sha256").update(baselineSnapshot).digest("hex") !== PHASE0_AUTH_SNAPSHOT_SHA256) {
    fail("the committed Phase 0 auth snapshot hash does not match the frozen baseline");
  }
  return migrations;
}

async function readPhase0Fingerprint(sql: postgres.TransactionSql): Promise<Phase0Fingerprint> {
  const columns = await sql<ColumnRow[]>`
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
      and table_class.relkind in ('r', 'p')
      and table_class.relname in ('account', 'session', 'user', 'verification')
      and attribute.attnum > 0
      and not attribute.attisdropped
    order by table_class.relname, attribute.attnum
  `;

  const foreignKeys = await sql<ForeignKeyRow[]>`
    select
      source_table.relname as table_name,
      constraint_row.conname as constraint_name,
      array(
        select source_attribute.attname
        from unnest(constraint_row.conkey) with ordinality as source_key(attnum, position)
        join pg_catalog.pg_attribute source_attribute
          on source_attribute.attrelid = source_table.oid
          and source_attribute.attnum = source_key.attnum
        order by source_key.position
      ) as columns,
      target_table.relname as referenced_table,
      array(
        select target_attribute.attname
        from unnest(constraint_row.confkey) with ordinality as target_key(attnum, position)
        join pg_catalog.pg_attribute target_attribute
          on target_attribute.attrelid = target_table.oid
          and target_attribute.attnum = target_key.attnum
        order by target_key.position
      ) as referenced_columns,
      constraint_row.confupdtype::text as on_update,
      constraint_row.confdeltype::text as on_delete
    from pg_catalog.pg_constraint constraint_row
    join pg_catalog.pg_class source_table on source_table.oid = constraint_row.conrelid
    join pg_catalog.pg_namespace namespace on namespace.oid = source_table.relnamespace
    join pg_catalog.pg_class target_table on target_table.oid = constraint_row.confrelid
    where namespace.nspname = 'public'
      and source_table.relname in ('account', 'session', 'user', 'verification')
      and constraint_row.contype = 'f'
    order by source_table.relname, constraint_row.conname
  `;

  const indexes = await sql<IndexRow[]>`
    select
      table_class.relname as table_name,
      index_class.relname as index_name,
      access_method.amname as method,
      index_row.indisunique as is_unique,
      index_row.indisprimary as is_primary,
      array(
        select attribute.attname
        from unnest(index_row.indkey) with ordinality as index_key(attnum, position)
        join pg_catalog.pg_attribute attribute
          on attribute.attrelid = table_class.oid
          and attribute.attnum = index_key.attnum
        where index_key.position <= index_row.indnkeyatts
        order by index_key.position
      ) as columns,
      pg_catalog.pg_get_expr(index_row.indexprs, index_row.indrelid) as expression,
      pg_catalog.pg_get_expr(index_row.indpred, index_row.indrelid) as predicate
    from pg_catalog.pg_index index_row
    join pg_catalog.pg_class table_class on table_class.oid = index_row.indrelid
    join pg_catalog.pg_namespace namespace on namespace.oid = table_class.relnamespace
    join pg_catalog.pg_class index_class on index_class.oid = index_row.indexrelid
    join pg_catalog.pg_am access_method on access_method.oid = index_class.relam
    where namespace.nspname = 'public'
      and table_class.relname in ('account', 'session', 'user', 'verification')
      and index_row.indisvalid
      and index_row.indisready
    order by table_class.relname, index_class.relname
  `;

  const uniqueConstraints = await sql<UniqueConstraintRow[]>`
    select
      table_class.relname as table_name,
      constraint_row.conname as constraint_name,
      constraint_row.contype::text as kind,
      array(
        select attribute.attname
        from unnest(constraint_row.conkey) with ordinality as constraint_key(attnum, position)
        join pg_catalog.pg_attribute attribute
          on attribute.attrelid = table_class.oid
          and attribute.attnum = constraint_key.attnum
        order by constraint_key.position
      ) as columns,
      constraint_row.condeferrable as is_deferrable,
      constraint_row.condeferred as is_deferred
    from pg_catalog.pg_constraint constraint_row
    join pg_catalog.pg_class table_class on table_class.oid = constraint_row.conrelid
    join pg_catalog.pg_namespace namespace on namespace.oid = table_class.relnamespace
    where namespace.nspname = 'public'
      and table_class.relname in ('account', 'session', 'user', 'verification')
      and constraint_row.contype in ('p', 'u')
    order by table_class.relname, constraint_row.conname
  `;

  const checks = await sql<CheckRow[]>`
    select
      table_class.relname as table_name,
      constraint_row.conname as constraint_name,
      pg_catalog.pg_get_constraintdef(constraint_row.oid, true) as definition
    from pg_catalog.pg_constraint constraint_row
    join pg_catalog.pg_class table_class on table_class.oid = constraint_row.conrelid
    join pg_catalog.pg_namespace namespace on namespace.oid = table_class.relnamespace
    where namespace.nspname = 'public'
      and table_class.relname in ('account', 'session', 'user', 'verification')
      and constraint_row.contype = 'c'
    order by table_class.relname, constraint_row.conname
  `;

  return {
    columns: columns.map((row) => [
      row.table_name,
      row.column_name,
      Number(row.ordinal_position),
      row.sql_type,
      row.not_null,
      row.default_expression,
    ]),
    foreignKeys: foreignKeys.map((row) => [
      row.table_name,
      row.constraint_name,
      [...row.columns],
      row.referenced_table,
      [...row.referenced_columns],
      row.on_update,
      row.on_delete,
    ]),
    indexes: indexes.map((row) => [
      row.table_name,
      row.index_name,
      row.method,
      row.is_unique,
      row.is_primary,
      [...row.columns],
      row.expression,
      row.predicate,
    ]),
    uniqueConstraints: uniqueConstraints.map((row) => [
      row.table_name,
      row.constraint_name,
      row.kind,
      [...row.columns],
      row.is_deferrable,
      row.is_deferred,
    ]),
    checks: checks.map((row) => [row.table_name, row.constraint_name, row.definition]),
  };
}

export type BaselineVerificationResult = "empty" | "baselined" | "journaled";

export async function verifyMigrationBaseline(
  databaseUrl: string,
  migrationsDirectory = dirname(fileURLToPath(import.meta.url)),
): Promise<BaselineVerificationResult> {
  const repositoryMigrations = await readRepositoryMigrations(migrationsDirectory);
  const baselineMigration = repositoryMigrations[0]!;
  const client = postgres(databaseUrl, { max: 1, onnotice() {} });

  try {
    return await client.begin(async (sql) => {
      await sql`select pg_catalog.pg_advisory_xact_lock(1949308616)`;

      const migrationTable = await sql<{ relation_name: string | null }[]>`
        select pg_catalog.to_regclass('drizzle.__drizzle_migrations')::text as relation_name
      `;
      let migrationRows: MigrationRow[] = [];
      if (migrationTable[0]?.relation_name) {
        migrationRows = [
          ...(await sql<MigrationRow[]>`
            select id, hash, created_at
            from drizzle.__drizzle_migrations
            order by created_at, id
          `),
        ];
        assertJournalPrefix(migrationRows, repositoryMigrations);
      }

      const publicTables = await sql<{ table_name: string }[]>`
        select table_class.relname as table_name
        from pg_catalog.pg_class table_class
        join pg_catalog.pg_namespace namespace on namespace.oid = table_class.relnamespace
        where namespace.nspname = 'public'
          and table_class.relkind in ('r', 'p')
        order by table_class.relname
      `;
      const tableNames = publicTables.map((row) => row.table_name);

      if (migrationRows.length > 0) {
        if (migrationRows.length === 1) {
          assertExactFingerprint(await readPhase0Fingerprint(sql));
          if (JSON.stringify(tableNames) !== JSON.stringify(PHASE0_AUTH_TABLES)) {
            fail("a database journaled only through Phase 0 has unexpected public tables");
          }
        } else {
          assertExactPhase2AuthFingerprint(await readPhase0Fingerprint(sql));
          if (
            migrationRows.length === 2 &&
            JSON.stringify(tableNames) !== JSON.stringify(PHASE2_TABLES)
          ) {
            fail("a database journaled through Phase 2 has unexpected public tables");
          }
        }
        return "journaled";
      }

      if (tableNames.length === 0) return "empty";
      if (JSON.stringify(tableNames) !== JSON.stringify(PHASE0_AUTH_TABLES)) {
        fail("an unjournaled database is neither empty nor an exact Phase 0 database");
      }

      assertExactFingerprint(await readPhase0Fingerprint(sql));

      await sql`create schema if not exists drizzle`;
      await sql`
        create table if not exists drizzle.__drizzle_migrations (
          id serial primary key,
          hash text not null,
          created_at bigint
        )
      `;
      await sql`
        insert into drizzle.__drizzle_migrations (hash, created_at)
        values (${baselineMigration.hash}, ${baselineMigration.when})
      `;

      const baselinedRows = await sql<MigrationRow[]>`
        select id, hash, created_at
        from drizzle.__drizzle_migrations
        order by created_at, id
      `;
      assertJournalPrefix(baselinedRows, repositoryMigrations.slice(0, 1));
      if (baselinedRows.length !== 1) {
        fail("the database did not record exactly the Phase 0 baseline migration");
      }
      return "baselined";
    });
  } finally {
    await client.end();
  }
}

async function main() {
  const parsed = migrationEnvSchema.safeParse(process.env);
  if (!parsed.success) {
    fail("MIGRATION_DATABASE_URL is required and must be a valid URL");
  }

  const result = await verifyMigrationBaseline(parsed.data.MIGRATION_DATABASE_URL);
  console.log(`Migration baseline verified: ${result}`);
}

const executedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null;
if (executedPath === import.meta.url) {
  await main();
}
