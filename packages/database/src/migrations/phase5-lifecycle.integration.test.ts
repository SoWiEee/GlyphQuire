import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { getTableName } from "drizzle-orm";
import { MigrationRunner } from "./MigrationRunner.js";
import { getTableConfig } from "drizzle-orm/pg-core";
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
    await new MigrationRunner({ databaseUrl: url, migrationsDirectory }).execute(db);
  } finally {
    await db.$client.end();
  }
}

async function migrateThrough(url: string, migrationCount: number): Promise<void> {
  const migrations = await readRepositoryMigrations(migrationsDirectory);
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
    for (const migration of migrations.slice(0, migrationCount)) {
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

async function migrateThroughPhase3(url: string): Promise<void> {
  const migrations = await readRepositoryMigrations(migrationsDirectory);
  expect(migrations.slice(0, 5).map((entry) => entry.tag)).toEqual([
    "0000_phase0_auth",
    "0001_phase2_workspaces",
    "0002_phase2_notes",
    "0003_phase2_rate_limits",
    "0004_phase3_themes",
  ]);
  await migrateThrough(url, 5);
}

async function migrateThrough0009(url: string): Promise<void> {
  const migrations = await readRepositoryMigrations(migrationsDirectory);
  expect(migrations.slice(0, 10).at(-1)?.tag).toBe("0009_phase5_share_links");
  await migrateThrough(url, 10);
}

async function journalRows(url: string) {
  const client = postgres(url, { max: 1 });
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

describe("Phase 5 lifecycle migration artifacts", () => {
  it("exports both durable coordinator tables", () => {
    expect(getTableName(workspaceDeletions)).toBe("workspace_deletions");
    expect(getTableName(accountDeletions)).toBe("account_deletions");
    expect(getTableConfig(workspaceDeletions).checks.map((entry) => entry.name)).toContain(
      "workspace_deletions_active_identity_check",
    );
    expect(getTableConfig(accountDeletions).checks.map((entry) => entry.name)).toContain(
      "account_deletions_account_id_check",
    );
  });

  it("preserves migrations 0000 through 0009 byte-for-byte and records lifecycle as 0010", async () => {
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
    const tags = repository.map((entry) => entry.tag);
    expect(tags.indexOf("0009_phase5_share_links")).toBeLessThan(
      tags.indexOf("0010_phase5_lifecycle"),
    );
    const snapshot = JSON.parse(
      await readFile(new URL("./meta/0010_snapshot.json", import.meta.url), "utf8"),
    ) as {
      id: string;
      prevId: string;
      tables: Record<string, { checkConstraints: Record<string, unknown> }>;
    };
    expect(snapshot.id).toBe("bbc01f47-f9ab-45bd-9f8e-01ea99719492");
    expect(snapshot.prevId).toBe("0edb4655-6cd0-43ba-8cd8-1d0e594218ee");
    expect(repository.find((entry) => entry.tag === "0010_phase5_lifecycle")).toMatchObject({
      idx: 10,
      tag: "0010_phase5_lifecycle",
      when: 1788014916377,
    });
    expect(snapshot.tables["public.workspace_deletions"]?.checkConstraints).toHaveProperty(
      "workspace_deletions_active_identity_check",
    );
    expect(snapshot.tables["public.account_deletions"]?.checkConstraints).toHaveProperty(
      "account_deletions_account_id_check",
    );
  });
});

describeWithPostgres("Phase 5 lifecycle PostgreSQL migration", () => {
  let admin: Sql;
  const databases = new Set<string>();

  beforeAll(() => {
    assertLoopback(migrationDatabaseUrl!);
    assertLoopback(runtimeDatabaseUrl!);
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
    return { name, url: databaseUrl(migrationDatabaseUrl!, name) };
  }

  it("migrates fresh, upgrades exact 0004, and reruns with exact journal hashes", async () => {
    const repository = await readRepositoryMigrations(migrationsDirectory);
    const fresh = await disposable();
    const expectedJournal = repository.map((entry) => ({
      hash: entry.hash,
      created_at: String(entry.when),
    }));
    await migrateDatabase(fresh.url);
    expect(await journalRows(fresh.url)).toEqual(expectedJournal);
    await migrateDatabase(fresh.url);
    expect(await journalRows(fresh.url)).toEqual(expectedJournal);

    const upgraded = await disposable();
    await migrateThroughPhase3(upgraded.url);
    expect(await journalRows(upgraded.url)).toEqual(expectedJournal.slice(0, 5));
    await migrateDatabase(upgraded.url);
    expect(await journalRows(upgraded.url)).toEqual(expectedJournal);
    await migrateDatabase(upgraded.url);
    expect(await journalRows(upgraded.url)).toEqual(expectedJournal);
  }, 180_000);

  it("rolls 0010 back atomically without changing pre-existing rows", async () => {
    const url = await disposable();
    await migrateThrough0009(url.url);
    const client = postgres(url.url, { max: 1, onnotice() {} });
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
        await client<{ table_name: string | null; validator: string | null }[]>`
          select
            pg_catalog.to_regclass('public.workspace_deletions')::text as table_name,
            pg_catalog.to_regprocedure(
              'public.is_bounded_canonical_uuid_array(jsonb,integer)'
            )::text as validator
        `,
      ).toEqual([{ table_name: null, validator: null }]);
    } finally {
      await client.end();
    }
  }, 120_000);

  it("enforces grace, attribution, identifier bounds, retained audits, and uniqueness", async () => {
    const database = await disposable();
    await migrateDatabase(database.url);
    const client = postgres(database.url, { max: 1, onnotice() {} });
    const firstActor = `lifecycle-constraints-a-${randomUUID()}`;
    const secondActor = `lifecycle-constraints-b-${randomUUID()}`;
    const confirmedAt = "2026-08-29T00:00:00.000Z";
    const executeAfter = "2026-08-30T00:00:00.000Z";
    const tooEarly = "2026-08-29T23:59:59.999Z";
    try {
      await client`
        insert into "user" (id, name, email) values
          (${firstActor}, 'Lifecycle constraints A', ${`${firstActor}@example.test`}),
          (${secondActor}, 'Lifecycle constraints B', ${`${secondActor}@example.test`})
      `;
      const [firstWorkspace] = await client<{ id: string }[]>`
        insert into workspaces (personal_owner_id) values (${firstActor}) returning id
      `;
      const [secondWorkspace] = await client<{ id: string }[]>`
        insert into workspaces (personal_owner_id) values (${secondActor}) returning id
      `;

      for (const status of ["pending", "processing", "failed"] as const) {
        await expect(client`
          insert into workspace_deletions (
            workspace_id, requested_by, confirmed_at, execute_after, status, idempotency_key
          ) values (
            ${firstWorkspace!.id}, ${firstActor}, ${confirmedAt}, ${tooEarly},
            ${status}, ${`workspace-too-early-${status}`}
          )
        `).rejects.toMatchObject({
          code: "23514",
          constraint_name: "workspace_deletions_execute_after_check",
        });
        await expect(client`
          insert into account_deletions (
            account_id, confirmed_at, execute_after, status, workspace_ids, idempotency_key
          ) values (
            ${`account-too-early-${status}`}, ${confirmedAt}, ${tooEarly}, ${status},
            ${client.json([])}, ${`account-too-early-${status}`}
          )
        `).rejects.toMatchObject({
          code: "23514",
          constraint_name: "account_deletions_execute_after_check",
        });
      }

      await expect(client`
        insert into workspace_deletions (
          workspace_id, requested_by, confirmed_at, execute_after, status, idempotency_key
        ) values (null, ${firstActor}, ${confirmedAt}, ${executeAfter}, 'failed', 'missing-workspace')
      `).rejects.toMatchObject({
        code: "23514",
        constraint_name: "workspace_deletions_active_identity_check",
      });
      await expect(client`
        insert into workspace_deletions (
          workspace_id, requested_by, confirmed_at, execute_after, status, idempotency_key
        ) values (
          ${firstWorkspace!.id}, null, ${confirmedAt}, ${executeAfter}, 'processing',
          'missing-requester'
        )
      `).rejects.toMatchObject({
        code: "23514",
        constraint_name: "workspace_deletions_active_identity_check",
      });

      const retainedId = randomUUID();
      await client`
        insert into workspace_deletions (
          id, workspace_id, requested_by, confirmed_at, execute_after, status, idempotency_key
        ) values (
          ${retainedId}, ${secondWorkspace!.id}, ${secondActor}, ${confirmedAt}, ${tooEarly},
          'completed', 'retained-terminal'
        )
      `;
      await client`delete from "user" where id = ${secondActor}`;
      expect(
        await client<{ workspace_id: string | null; requested_by: string | null }[]>`
          select workspace_id, requested_by from workspace_deletions where id = ${retainedId}
        `,
      ).toEqual([{ workspace_id: null, requested_by: null }]);

      await client`
        insert into workspace_deletions (
          workspace_id, requested_by, confirmed_at, execute_after, status, idempotency_key
        ) values (
          ${firstWorkspace!.id}, ${firstActor}, ${confirmedAt}, ${executeAfter}, 'pending',
          'workspace-active'
        )
      `;
      await expect(
        client`delete from workspaces where id = ${firstWorkspace!.id}`,
      ).rejects.toMatchObject({
        code: "23514",
        constraint_name: "workspace_deletions_active_identity_check",
      });
      await expect(client`
        insert into workspace_deletions (
          workspace_id, requested_by, confirmed_at, execute_after, status, idempotency_key
        ) values (
          ${firstWorkspace!.id}, ${firstActor}, ${confirmedAt}, ${executeAfter}, 'failed',
          'workspace-active-duplicate'
        )
      `).rejects.toMatchObject({
        code: "23505",
        constraint_name: "workspace_deletions_active_workspace_unique",
      });
      await expect(client`
        insert into workspace_deletions (
          workspace_id, requested_by, confirmed_at, execute_after, status, idempotency_key
        ) values (
          ${firstWorkspace!.id}, ${firstActor}, ${confirmedAt}, ${tooEarly}, 'completed',
          'workspace-active'
        )
      `).rejects.toMatchObject({
        code: "23505",
        constraint_name: "workspace_deletions_idempotency_unique",
      });

      const canonicalWorkspaceIds = [randomUUID(), randomUUID()];
      await client`
        insert into account_deletions (
          account_id, confirmed_at, execute_after, status, workspace_ids, idempotency_key
        ) values (
          'opaque-account', ${confirmedAt}, ${executeAfter}, 'pending',
          ${client.json(canonicalWorkspaceIds)}, 'account-active'
        )
      `;
      for (const [accountId, workspaceIds] of [
        ["invalid-uppercase", [canonicalWorkspaceIds[0]!.toUpperCase()]],
        ["invalid-nil", ["00000000-0000-0000-0000-000000000000"]],
        ["invalid-duplicate", [canonicalWorkspaceIds[0]!, canonicalWorkspaceIds[0]!]],
        ["invalid-shape", { workspaceId: canonicalWorkspaceIds[0] }],
      ] as const) {
        await expect(client`
          insert into account_deletions (
            account_id, confirmed_at, execute_after, status, workspace_ids, idempotency_key
          ) values (
            ${accountId}, ${confirmedAt}, ${executeAfter}, 'pending',
            ${client.json(workspaceIds)}, ${accountId}
          )
        `).rejects.toMatchObject({
          code: "23514",
          constraint_name: "account_deletions_workspace_ids_check",
        });
      }
      await expect(client`
        insert into account_deletions (
          account_id, confirmed_at, execute_after, status, workspace_ids, idempotency_key
        ) values (
          'too-many-workspaces', ${confirmedAt}, ${executeAfter}, 'pending',
          ${client.json(Array.from({ length: 1001 }, () => randomUUID()))}, 'too-many-workspaces'
        )
      `).rejects.toMatchObject({
        code: "23514",
        constraint_name: "account_deletions_workspace_ids_check",
      });
      await expect(client`
        insert into account_deletions (
          account_id, confirmed_at, execute_after, status, workspace_ids, idempotency_key
        ) values (
          '', ${confirmedAt}, ${executeAfter}, 'pending', ${client.json([])},
          ${`invalid-account-${randomUUID()}`}
        )
      `).rejects.toMatchObject({
        code: "23514",
        constraint_name: "account_deletions_account_id_check",
      });
      for (const accountId of ["x".repeat(201), "😀".repeat(51)]) {
        await expect(client`
          insert into account_deletions (
            account_id, confirmed_at, execute_after, status, workspace_ids, idempotency_key
          ) values (
            ${accountId}, ${confirmedAt}, ${executeAfter}, 'pending', ${client.json([])},
            ${`invalid-account-${randomUUID()}`}
          )
        `).rejects.toMatchObject({
          code: expect.stringMatching(/^(22001|23514)$/u),
        });
      }
      await expect(client`
        insert into account_deletions (
          account_id, confirmed_at, execute_after, status, workspace_ids, idempotency_key
        ) values (
          'opaque-account', ${confirmedAt}, ${executeAfter}, 'failed', ${client.json([])},
          'account-active-duplicate'
        )
      `).rejects.toMatchObject({
        code: "23505",
        constraint_name: "account_deletions_active_account_unique",
      });
      await client`
        insert into account_deletions (
          account_id, confirmed_at, execute_after, status, workspace_ids, idempotency_key
        ) values (
          'idempotency-account', ${confirmedAt}, ${executeAfter}, 'completed', ${client.json([])},
          'same-key'
        )
      `;
      await expect(client`
        insert into account_deletions (
          account_id, confirmed_at, execute_after, status, workspace_ids, idempotency_key
        ) values (
          'idempotency-account', ${confirmedAt}, ${executeAfter}, 'completed', ${client.json([])},
          'same-key'
        )
      `).rejects.toMatchObject({
        code: "23505",
        constraint_name: "account_deletions_idempotency_unique",
      });
    } finally {
      await client.end();
    }
  }, 180_000);

  it("allows lifecycle DML while denying runtime DDL, journal writes, and sequence reset", async () => {
    const database = await disposable();
    await migrateDatabase(database.url);
    const runtimeBase = new URL(runtimeDatabaseUrl!);
    const runtimeRole = decodeURIComponent(runtimeBase.username);
    const migrationRole = decodeURIComponent(new URL(migrationDatabaseUrl!).username);
    if (!/^[a-z_][a-z0-9_]{0,62}$/u.test(runtimeRole)) throw new Error("invalid runtime role");
    if (!/^[a-z_][a-z0-9_]{0,62}$/u.test(migrationRole)) {
      throw new Error("invalid migration role");
    }

    await admin.unsafe(`grant connect on database "${database.name}" to "${runtimeRole}"`);
    const migration = postgres(database.url, { max: 1, onnotice() {} });
    try {
      await migration.unsafe(`grant usage on schema public to "${runtimeRole}"`);
      await migration.unsafe(
        `grant select, insert, update, delete on all tables in schema public to "${runtimeRole}"`,
      );
      await migration.unsafe(`grant usage on all sequences in schema public to "${runtimeRole}"`);
    } finally {
      await migration.end();
    }

    runtimeBase.pathname = `/${database.name}`;
    const runtime = postgres(runtimeBase.toString(), { max: 1, onnotice() {} });
    const actorId = `lifecycle-runtime-${randomUUID()}`;
    try {
      await runtime`
        insert into "user" (id, name, email)
        values (${actorId}, 'Lifecycle runtime', ${`${actorId}@example.test`})
      `;
      const [workspace] = await runtime<{ id: string }[]>`
        insert into workspaces (personal_owner_id) values (${actorId}) returning id
      `;
      const [deletion] = await runtime<{ id: string }[]>`
        insert into workspace_deletions (
          workspace_id, requested_by, confirmed_at, execute_after, status, idempotency_key
        ) values (
          ${workspace!.id}, ${actorId}, now(), now() + interval '1 day', 'pending',
          'runtime-valid'
        ) returning id
      `;
      expect(deletion!.id).toMatch(/^[0-9a-f-]{36}$/u);

      await expect(runtime.unsafe(`set role "${migrationRole}"`)).rejects.toMatchObject({
        code: "42501",
      });
      await expect(
        runtime.unsafe("create table public.lifecycle_runtime_forbidden (id integer)"),
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
