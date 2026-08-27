import { createHash, randomUUID } from "node:crypto";
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

/**
 * Advances a phase-3-frozen database through the frozen 0005 and 0006
 * migrations, leaving it positioned exactly before 0007_phase5_search so
 * tests can exercise the search migration's own DDL and rollback behavior
 * against real predecessor tables (workspaces, notes).
 */
async function migrateThroughPhase5Assets(databaseUrl: string): Promise<void> {
  const migrations = await readRepositoryMigrations(migrationsDirectory);
  const client = postgres(databaseUrl, { max: 1, onnotice() {} });
  try {
    for (const migration of migrations.slice(5, 7)) {
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

describe("Phase 5 search migration artifacts", () => {
  it("preserves the exact committed bytes of migrations 0000 through 0006", async () => {
    const expected = [
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
    ] as const;

    for (const [tag, hash] of expected) {
      const source = await readFile(new URL(`./${tag}.sql`, import.meta.url));
      expect(createHash("sha256").update(source).digest("hex"), tag).toBe(hash);
    }
  });

  it("records exactly 0007_phase5_search after the frozen 0006 migration", async () => {
    const migrations = await readRepositoryMigrations(migrationsDirectory);
    expect(migrations.map((entry) => entry.tag).slice(-2)).toEqual([
      "0006_phase5_assets",
      "0007_phase5_search",
    ]);
    expect(await readFile(new URL("./meta/0007_snapshot.json", import.meta.url), "utf8")).toContain(
      '"public.search_documents"',
    );
    const source = await readFile(new URL("./0007_phase5_search.sql", import.meta.url), "utf8");
    expect(source).toContain("CREATE EXTENSION IF NOT EXISTS pg_trgm;");
    expect(source).toContain(
      'CREATE INDEX "search_documents_tsv_idx" ON "search_documents" USING gin ("search_vector");',
    );
    expect(source).toContain(
      'CREATE INDEX "search_documents_normalized_trgm_idx" ON "search_documents" USING gin ("normalized_text" gin_trgm_ops);',
    );
  });
});

describeWithPostgres("Phase 5 search PostgreSQL migration", () => {
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
    const databaseName = `glyphquire_p5_search_${randomUUID().replaceAll("-", "")}`;
    expect(databaseName).toMatch(/^[a-z0-9_]+$/);
    await admin.unsafe(`create database "${databaseName}"`);
    databases.add(databaseName);
    return {
      databaseName,
      migrationUrl: urlForDatabase(migrationDatabaseUrl!, databaseName),
    };
  }

  it("migrates fresh, upgrades exact 0004 and exact 0006, and reruns without journal drift", async () => {
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
    expect((await journalRows(upgraded.migrationUrl)).map((row) => row.hash)).toEqual(
      repository.slice(0, 5).map((entry) => entry.hash),
    );
    await migrateDatabase(upgraded.migrationUrl);
    expect(await journalRows(upgraded.migrationUrl)).toEqual(
      repository.map((entry) => ({ hash: entry.hash, created_at: String(entry.when) })),
    );

    const upgradedFrom0006 = await createTestDatabase();
    await migrateThroughPhase3(upgradedFrom0006.migrationUrl);
    await migrateThroughPhase5Assets(upgradedFrom0006.migrationUrl);
    expect(await journalRows(upgradedFrom0006.migrationUrl)).toEqual(
      repository.slice(0, 7).map((entry) => ({
        hash: entry.hash,
        created_at: String(entry.when),
      })),
    );
    await migrateDatabase(upgradedFrom0006.migrationUrl);
    expect(await journalRows(upgradedFrom0006.migrationUrl)).toEqual(
      repository.map((entry) => ({ hash: entry.hash, created_at: String(entry.when) })),
    );
  }, 120_000);

  it("rolls the 0007 DDL back atomically before a clean upgrade, preserving existing notes", async () => {
    const repository = await readRepositoryMigrations(migrationsDirectory);
    const database = await createTestDatabase();
    await migrateThroughPhase3(database.migrationUrl);
    await migrateThroughPhase5Assets(database.migrationUrl);

    const actorId = `phase5-search-rollback-${randomUUID()}`;
    const seedClient = postgres(database.migrationUrl, { max: 1, onnotice() {} });
    let noteId: string;
    try {
      await seedClient`
        insert into "user" (id, name, email)
        values (${actorId}, 'Phase 5 Search', ${`${actorId}@example.test`})
      `;
      const [workspace] = await seedClient<{ id: string }[]>`
        insert into workspaces (personal_owner_id)
        values (${actorId})
        returning id
      `;
      const [note] = await seedClient<{ id: string }[]>`
        insert into notes (workspace_id, title, content_markdown, content_hash, owner_id)
        values (${workspace!.id}, 'Rollback note', 'body', 'hash', ${actorId})
        returning id
      `;
      noteId = note!.id;
    } finally {
      await seedClient.end();
    }

    const source = await readFile(new URL("./0007_phase5_search.sql", import.meta.url), "utf8");
    const client = postgres(database.migrationUrl, { max: 1, onnotice() {} });
    try {
      await expect(
        client.begin(async (transaction) => {
          await applySql(transaction, source);
          throw new Error("force migration rollback");
        }),
      ).rejects.toThrow("force migration rollback");
      expect(
        await client<{ search_documents: string | null }[]>`
          select pg_catalog.to_regclass('public.search_documents')::text as search_documents
        `,
      ).toEqual([{ search_documents: null }]);
      expect(await journalRows(database.migrationUrl)).toHaveLength(repository.length - 1);
      expect(await client<{ id: string }[]>`select id from notes where id = ${noteId}`).toEqual([
        { id: noteId },
      ]);
    } finally {
      await client.end();
    }

    await migrateDatabase(database.migrationUrl);
    expect(await journalRows(database.migrationUrl)).toHaveLength(repository.length);
    const verifyClient = postgres(database.migrationUrl, { max: 1, onnotice() {} });
    try {
      expect(
        await verifyClient<{ id: string }[]>`select id from notes where id = ${noteId}`,
      ).toEqual([{ id: noteId }]);
    } finally {
      await verifyClient.end();
    }
  }, 120_000);

  it("enforces revision and size constraints, upserts on stale revision, and cascades with the source note", async () => {
    const database = await createTestDatabase();
    await migrateDatabase(database.migrationUrl);
    const client = postgres(database.migrationUrl, { max: 1, onnotice() {} });
    const actorId = `phase5-search-${randomUUID()}`;
    try {
      await client`
        insert into "user" (id, name, email)
        values (${actorId}, 'Phase 5 Search', ${`${actorId}@example.test`})
      `;
      const [workspace] = await client<{ id: string }[]>`
        insert into workspaces (personal_owner_id)
        values (${actorId})
        returning id
      `;
      const [note] = await client<{ id: string }[]>`
        insert into notes (workspace_id, title, content_markdown, content_hash, owner_id)
        values (${workspace!.id}, 'Searchable note', 'body', 'hash', ${actorId})
        returning id
      `;

      const constraints = await client<{ constraint_name: string }[]>`
        select catalog_constraint.conname as constraint_name
        from pg_catalog.pg_constraint catalog_constraint
        where catalog_constraint.conrelid = 'public.search_documents'::regclass
        order by catalog_constraint.conname
      `;
      expect(constraints.map((constraint) => constraint.constraint_name)).toContain(
        "search_documents_tags_size_check",
      );

      await expect(
        client`
          insert into search_documents (workspace_id, note_id, revision, title, body)
          values (${workspace!.id}, ${note!.id}, 0, 'Title', 'Body')
        `,
      ).rejects.toMatchObject({
        code: "23514",
        constraint_name: "search_documents_revision_positive_check",
      });

      const searchableTag = `taxonomy${randomUUID().replaceAll("-", "")}`;
      const [row] = await client<{ id: string; revision: number; title: string }[]>`
        insert into search_documents (workspace_id, note_id, revision, title, body, tags)
        values (${workspace!.id}, ${note!.id}, 3, 'Title v3', 'Body v3', ${searchableTag})
        returning id, revision, title
      `;
      expect(row).toMatchObject({ revision: 3, title: "Title v3" });
      expect(
        await client<{ matches: boolean }[]>`
          select search_vector @@ plainto_tsquery('english', ${searchableTag}) as matches
          from search_documents
          where note_id = ${note!.id}
        `,
      ).toEqual([{ matches: true }]);

      // Stale-revision upsert is a no-op: revision 1 must not overwrite revision 3.
      await client`
        insert into search_documents (workspace_id, note_id, revision, title, body)
        values (${workspace!.id}, ${note!.id}, 1, 'Stale title', 'Stale body')
        on conflict (note_id) do update
          set revision = excluded.revision, title = excluded.title, body = excluded.body
          where search_documents.revision < excluded.revision
      `;
      expect(
        await client<{ revision: number; title: string }[]>`
          select revision, title from search_documents where note_id = ${note!.id}
        `,
      ).toEqual([{ revision: 3, title: "Title v3" }]);

      // A newer revision does overwrite.
      await client`
        insert into search_documents (workspace_id, note_id, revision, title, body)
        values (${workspace!.id}, ${note!.id}, 5, 'Title v5', 'Body v5')
        on conflict (note_id) do update
          set revision = excluded.revision, title = excluded.title, body = excluded.body
          where search_documents.revision < excluded.revision
      `;
      expect(
        await client<{ revision: number; title: string }[]>`
          select revision, title from search_documents where note_id = ${note!.id}
        `,
      ).toEqual([{ revision: 5, title: "Title v5" }]);

      const duplicateNoteId = randomUUID();
      await expect(
        client`
          insert into search_documents (workspace_id, note_id, revision, title, body)
          values (${workspace!.id}, ${note!.id}, 6, 'Duplicate', 'Body')
        `,
      ).rejects.toMatchObject({ code: "23505" });
      void duplicateNoteId;

      const generated = await client<{ has_vector: boolean }[]>`
        select (search_vector is not null) as has_vector
        from search_documents where note_id = ${note!.id}
      `;
      expect(generated).toEqual([{ has_vector: true }]);

      await client`delete from notes where id = ${note!.id}`;
      expect(
        await client<{ id: string }[]>`select id from search_documents where note_id = ${note!.id}`,
      ).toEqual([]);
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
    const actorId = `phase5-search-runtime-${randomUUID()}`;
    try {
      await runtime`
        insert into "user" (id, name, email)
        values (${actorId}, 'Runtime Search', ${`${actorId}@example.test`})
      `;
      const [workspace] = await runtime<{ id: string }[]>`
        insert into workspaces (personal_owner_id)
        values (${actorId})
        returning id
      `;
      const [note] = await runtime<{ id: string }[]>`
        insert into notes (workspace_id, title, content_markdown, content_hash, owner_id)
        values (${workspace!.id}, 'Runtime note', 'body', 'hash', ${actorId})
        returning id
      `;
      const [row] = await runtime<{ id: string }[]>`
        insert into search_documents (workspace_id, note_id, revision, title, body)
        values (${workspace!.id}, ${note!.id}, 1, 'Runtime title', 'Runtime body')
        returning id
      `;
      expect(
        await runtime<{ id: string }[]>`select id from search_documents where id = ${row!.id}`,
      ).toEqual([{ id: row!.id }]);

      await expect(runtime.unsafe(`set role "${migrationRole}"`)).rejects.toMatchObject({
        code: "42501",
      });
      await expect(
        runtime.unsafe("create table public.phase5_search_runtime_forbidden (id integer)"),
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
