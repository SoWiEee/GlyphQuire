import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { getTableName } from "drizzle-orm";
import { MigrationRunner } from "./MigrationRunner.js";
import postgres, { type Sql } from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb } from "../client.js";
import { shareLinks } from "../index.js";
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
    await new MigrationRunner({ databaseUrl, migrationsDirectory }).execute(db);
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

async function applyPhase5ThroughExports(databaseUrl: string): Promise<void> {
  const migrations = await readRepositoryMigrations(migrationsDirectory);
  const client = postgres(databaseUrl, { max: 1, onnotice() {} });
  try {
    for (const migration of migrations.slice(5, 9)) {
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

describe("Phase 5 share-link schema and migration artifacts", () => {
  it("exports the canonical share_links table", () => {
    expect(getTableName(shareLinks)).toBe("share_links");
  });

  it("preserves exact migrations 0000 through 0008 and appends only 0009", async () => {
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
    ] as const;
    for (const [tag, hash] of frozen) {
      const bytes = await readFile(new URL(`./${tag}.sql`, import.meta.url));
      expect(createHash("sha256").update(bytes).digest("hex"), tag).toBe(hash);
    }

    const repository = await readRepositoryMigrations(migrationsDirectory);
    const tags = repository.map((entry) => entry.tag);
    expect(tags).toEqual(
      expect.arrayContaining(["0008_phase5_exports", "0009_phase5_share_links"]),
    );
    expect(tags.indexOf("0008_phase5_exports")).toBeLessThan(
      tags.indexOf("0009_phase5_share_links"),
    );
    const snapshot = await readFile(new URL("./meta/0009_snapshot.json", import.meta.url), "utf8");
    expect(snapshot).toContain('"public.share_links"');
  });
});

describeWithPostgres("Phase 5 share-link PostgreSQL migration", () => {
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

  async function createTestDatabase() {
    const databaseName = `glyphquire_p5_share_${randomUUID().replaceAll("-", "")}`;
    expect(databaseName).toMatch(/^[a-z0-9_]+$/u);
    await admin.unsafe(`create database "${databaseName}"`);
    databases.add(databaseName);
    return { databaseName, migrationUrl: urlForDatabase(migrationDatabaseUrl!, databaseName) };
  }

  it("migrates fresh, upgrades the exact 0004 baseline, and reruns without journal drift", async () => {
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
    expect(await journalRows(upgraded.migrationUrl)).toHaveLength(5);
    await migrateDatabase(upgraded.migrationUrl);
    expect(await journalRows(upgraded.migrationUrl)).toEqual(
      repository.map((entry) => ({ hash: entry.hash, created_at: String(entry.when) })),
    );
  }, 180_000);

  it("rolls 0009 back atomically and preserves exact pre-existing note bytes", async () => {
    const database = await createTestDatabase();
    await migrateThroughPhase3(database.migrationUrl);
    await applyPhase5ThroughExports(database.migrationUrl);
    const actorId = `share-rollback-${randomUUID()}`;
    const markdown = "---\nglyphquire-spec: 1\n---\n\n# Preserve exact share migration bytes\n";
    const client = postgres(database.migrationUrl, { max: 1, onnotice() {} });
    let noteId: string;
    try {
      await client`
        insert into "user" (id, name, email)
        values (${actorId}, 'Share rollback', ${`${actorId}@example.test`})
      `;
      const [workspace] = await client<{ id: string }[]>`
        insert into workspaces (personal_owner_id) values (${actorId}) returning id
      `;
      await client`
        insert into workspace_members (workspace_id, user_id, role)
        values (${workspace!.id}, ${actorId}, 'owner')
      `;
      const [note] = await client<{ id: string }[]>`
        insert into notes (workspace_id, title, content_markdown, content_hash, owner_id)
        values (${workspace!.id}, 'Rollback', ${markdown}, 'hash', ${actorId}) returning id
      `;
      noteId = note!.id;

      const source = await readFile(
        new URL("./0009_phase5_share_links.sql", import.meta.url),
        "utf8",
      );
      await expect(
        client.begin(async (transaction) => {
          await applySql(transaction, source);
          throw new Error("force migration rollback");
        }),
      ).rejects.toThrow("force migration rollback");
      expect(
        await client<{ table_name: string | null }[]>`
          select pg_catalog.to_regclass('public.share_links')::text as table_name
        `,
      ).toEqual([{ table_name: null }]);
      expect(
        await client<{ content_markdown: string }[]>`
        select content_markdown from notes where id = ${noteId}
      `,
      ).toEqual([{ content_markdown: markdown }]);
    } finally {
      await client.end();
    }
    await migrateDatabase(database.migrationUrl);
  }, 180_000);

  it("enforces tenant, creator-membership, scope, hash, timestamp, and uniqueness constraints", async () => {
    const database = await createTestDatabase();
    await migrateDatabase(database.migrationUrl);
    const client = postgres(database.migrationUrl, { max: 1, onnotice() {} });
    const owner = `share-schema-owner-${randomUUID()}`;
    const outsider = `share-schema-outsider-${randomUUID()}`;
    try {
      await client`
        insert into "user" (id, name, email) values
          (${owner}, 'Share owner', ${`${owner}@example.test`}),
          (${outsider}, 'Share outsider', ${`${outsider}@example.test`})
      `;
      const [workspace] = await client<{ id: string }[]>`
        insert into workspaces (personal_owner_id) values (${owner}) returning id
      `;
      const [otherWorkspace] = await client<{ id: string }[]>`
        insert into workspaces (personal_owner_id) values (${outsider}) returning id
      `;
      await client`
        insert into workspace_members (workspace_id, user_id, role) values
          (${workspace!.id}, ${owner}, 'owner'),
          (${otherWorkspace!.id}, ${outsider}, 'owner')
      `;
      const [note] = await client<{ id: string }[]>`
        insert into notes (workspace_id, title, content_markdown, content_hash, owner_id)
        values (${workspace!.id}, 'Share', '# body', 'hash', ${owner}) returning id
      `;
      const validHash = "a".repeat(64);
      const linkId = randomUUID();
      await client`
        insert into share_links (
          id, workspace_id, note_id, creator_id, scope_type, token_hash,
          created_at, expires_at
        ) values (
          ${linkId}, ${workspace!.id}, ${note!.id}, ${owner}, 'note', ${validHash},
          '2026-08-29T00:00:00.000Z', '2026-08-30T00:00:00.000Z'
        )
      `;

      await expect(client`
        insert into share_links (workspace_id, note_id, creator_id, scope_type, token_hash)
        values (${workspace!.id}, ${note!.id}, ${owner}, 'workspace', ${"b".repeat(64)})
      `).rejects.toMatchObject({ code: "23514", constraint_name: "share_links_scope_check" });
      await expect(client`
        insert into share_links (workspace_id, note_id, creator_id, token_hash)
        values (${workspace!.id}, ${note!.id}, ${owner}, 'not-a-hash')
      `).rejects.toMatchObject({ code: "23514", constraint_name: "share_links_token_hash_check" });
      await expect(client`
        insert into share_links (workspace_id, note_id, creator_id, token_hash)
        values (${otherWorkspace!.id}, ${note!.id}, ${outsider}, ${"c".repeat(64)})
      `).rejects.toMatchObject({ code: "23503", constraint_name: "share_links_note_workspace_fk" });
      await expect(client`
        insert into share_links (workspace_id, note_id, creator_id, token_hash)
        values (${workspace!.id}, ${note!.id}, ${outsider}, ${"d".repeat(64)})
      `).rejects.toMatchObject({
        code: "23503",
        constraint_name: "share_links_creator_membership_fk",
      });
      await expect(client`
        insert into share_links (
          workspace_id, note_id, creator_id, token_hash, created_at, expires_at
        ) values (
          ${workspace!.id}, ${note!.id}, ${owner}, ${"e".repeat(64)},
          '2026-08-29T00:00:00.000Z', '2026-08-29T00:00:00.000Z'
        )
      `).rejects.toMatchObject({ code: "23514", constraint_name: "share_links_expiry_check" });
      await expect(client`
        insert into share_links (workspace_id, note_id, creator_id, token_hash)
        values (${workspace!.id}, ${note!.id}, ${owner}, ${validHash})
      `).rejects.toMatchObject({ code: "23505" });

      await client`delete from notes where id = ${note!.id}`;
      expect(
        await client<{ id: string }[]>`select id from share_links where id = ${linkId}`,
      ).toEqual([]);
    } finally {
      await client.end();
    }
  }, 180_000);

  it("allows runtime DML while denying DDL, journal writes, sequence reset, and role escalation", async () => {
    const database = await createTestDatabase();
    await migrateDatabase(database.migrationUrl);
    const runtimeBase = new URL(runtimeDatabaseUrl!);
    const runtimeRole = decodeURIComponent(runtimeBase.username);
    const migrationRole = decodeURIComponent(new URL(migrationDatabaseUrl!).username);
    if (!/^[a-z_][a-z0-9_]{0,62}$/u.test(runtimeRole)) throw new Error("invalid runtime role");
    if (!/^[a-z_][a-z0-9_]{0,62}$/u.test(migrationRole)) throw new Error("invalid migration role");

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
    const actorId = `share-runtime-${randomUUID()}`;
    try {
      await runtime`
        insert into "user" (id, name, email)
        values (${actorId}, 'Share runtime', ${`${actorId}@example.test`})
      `;
      const [workspace] = await runtime<{ id: string }[]>`
        insert into workspaces (personal_owner_id) values (${actorId}) returning id
      `;
      await runtime`
        insert into workspace_members (workspace_id, user_id, role)
        values (${workspace!.id}, ${actorId}, 'owner')
      `;
      const [note] = await runtime<{ id: string }[]>`
        insert into notes (workspace_id, title, content_markdown, content_hash, owner_id)
        values (${workspace!.id}, 'Runtime', '# body', 'hash', ${actorId}) returning id
      `;
      const [link] = await runtime<{ id: string }[]>`
        insert into share_links (workspace_id, note_id, creator_id, token_hash)
        values (${workspace!.id}, ${note!.id}, ${actorId}, ${"f".repeat(64)}) returning id
      `;
      expect(link!.id).toMatch(/^[0-9a-f-]{36}$/u);

      await expect(runtime.unsafe(`set role "${migrationRole}"`)).rejects.toMatchObject({
        code: "42501",
      });
      await expect(
        runtime.unsafe("create table public.share_runtime_forbidden (id integer)"),
      ).rejects.toMatchObject({ code: "42501" });
      await expect(runtime`
        insert into drizzle.__drizzle_migrations (hash, created_at) values ('forbidden', 0)
      `).rejects.toMatchObject({ code: "42501" });
      await expect(
        runtime.unsafe("alter sequence drizzle.__drizzle_migrations_id_seq restart with 1"),
      ).rejects.toMatchObject({ code: "42501" });
    } finally {
      await runtime.end();
    }
  }, 180_000);
});
