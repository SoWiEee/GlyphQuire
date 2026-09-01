import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { getTableName } from "drizzle-orm";
import { MigrationRunner } from "./MigrationRunner.js";
import postgres, { type Sql } from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb } from "../client.js";
import { exports as transferExports, importResources, imports } from "../index.js";
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

async function migrateThroughPhase5Search(databaseUrl: string): Promise<void> {
  const migrations = await readRepositoryMigrations(migrationsDirectory);
  const client = postgres(databaseUrl, { max: 1, onnotice() {} });
  try {
    for (const migration of migrations.slice(5, 8)) {
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

async function migrateThrough0010(databaseUrl: string): Promise<void> {
  const migrations = await readRepositoryMigrations(migrationsDirectory);
  expect(migrations.slice(0, 11).at(-1)?.tag).toBe("0010_phase5_lifecycle");
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
    for (const migration of migrations.slice(0, 11)) {
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

function sourceObjectKey(workspaceId: string, importId: string): string {
  return `workspace/${workspaceId}/imports/${importId}/source`;
}

function resourceObjectKey(workspaceId: string, importId: string, resourceId: string): string {
  return `workspace/${workspaceId}/imports/${importId}/resources/${resourceId}`;
}

function exportObjectKey(workspaceId: string, exportId: string): string {
  return `workspace/${workspaceId}/exports/${exportId}/artifact`;
}

describe("Phase 5 transfer schema and migration artifacts", () => {
  it("exports the three backend transfer tables", () => {
    expect(getTableName(imports)).toBe("imports");
    expect(getTableName(importResources)).toBe("import_resources");
    expect(getTableName(transferExports)).toBe("exports");
  });

  it("preserves the exact committed bytes of migrations 0000 through 0007", async () => {
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
      ["0007_phase5_search", "5a764469e55745b1daffb4fcc66d7ebf54e08d8bea823192d71a0b1b6d42873a"],
    ] as const;

    for (const [tag, hash] of expected) {
      const source = await readFile(new URL(`./${tag}.sql`, import.meta.url));
      expect(createHash("sha256").update(source).digest("hex"), tag).toBe(hash);
    }
  });

  it("records the 0008 export and 0009 share migrations after the frozen 0007 migration", async () => {
    const migrations = await readRepositoryMigrations(migrationsDirectory);
    const tags = migrations.map((entry) => entry.tag);
    expect(tags).toEqual(
      expect.arrayContaining([
        "0007_phase5_search",
        "0008_phase5_exports",
        "0009_phase5_share_links",
      ]),
    );
    expect(tags.indexOf("0007_phase5_search")).toBeLessThan(tags.indexOf("0008_phase5_exports"));
    expect(tags.indexOf("0008_phase5_exports")).toBeLessThan(
      tags.indexOf("0009_phase5_share_links"),
    );
    const snapshot = await readFile(new URL("./meta/0008_snapshot.json", import.meta.url), "utf8");
    expect(snapshot).toContain('"public.imports"');
    expect(snapshot).toContain('"public.import_resources"');
    expect(snapshot).toContain('"public.exports"');
  });

  it("preserves migrations through 0010 and keeps the export-format check in 0011", async () => {
    const frozen = [
      ["0008_phase5_exports", "9a6ad7ed95a5e65b0dc0e2daba5e3720c28e822752b32ff254565e754b42b14e"],
      [
        "0009_phase5_share_links",
        "cad40a10a1f8649a73b60b45d4cd27b2c8e03771d323028a90c451eaa8385fab",
      ],
      ["0010_phase5_lifecycle", "a9dd8e0fb7640e1f19ec8aac42f5b1a6c414f1ee2be10ec1c8ee09f707afba21"],
    ] as const;
    for (const [tag, expectedHash] of frozen) {
      const bytes = await readFile(new URL(`./${tag}.sql`, import.meta.url));
      expect(createHash("sha256").update(bytes).digest("hex"), tag).toBe(expectedHash);
    }

    const repository = await readRepositoryMigrations(migrationsDirectory);
    const tags = repository.map((entry) => entry.tag);
    const lifecycleIndex = tags.indexOf("0010_phase5_lifecycle");
    const exportFormatsIndex = tags.indexOf("0011_phase5_export_formats");
    expect(lifecycleIndex).toBeGreaterThanOrEqual(0);
    expect(exportFormatsIndex).toBe(lifecycleIndex + 1);
    const snapshot = JSON.parse(
      await readFile(new URL("./meta/0011_snapshot.json", import.meta.url), "utf8"),
    ) as {
      prevId: string;
      tables: Record<string, { checkConstraints: Record<string, { value: string }> }>;
    };
    expect(snapshot.prevId).toBe("bbc01f47-f9ab-45bd-9f8e-01ea99719492");
    expect(
      snapshot.tables["public.exports"]?.checkConstraints.exports_format_check?.value,
    ).toContain("'plain-text', 'ast-json'");
  });
});

describeWithPostgres("Phase 5 transfer PostgreSQL migration", () => {
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
    const databaseName = `glyphquire_p5_transfer_${randomUUID().replaceAll("-", "")}`;
    expect(databaseName).toMatch(/^[a-z0-9_]+$/);
    await admin.unsafe(`create database "${databaseName}"`);
    databases.add(databaseName);
    return {
      databaseName,
      migrationUrl: urlForDatabase(migrationDatabaseUrl!, databaseName),
    };
  }

  it("migrates fresh, upgrades exact 0007, and reruns without journal drift", async () => {
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
    await migrateThroughPhase5Search(upgraded.migrationUrl);
    expect(await journalRows(upgraded.migrationUrl)).toEqual(
      repository.slice(0, 8).map((entry) => ({
        hash: entry.hash,
        created_at: String(entry.when),
      })),
    );
    await migrateDatabase(upgraded.migrationUrl);
    expect(await journalRows(upgraded.migrationUrl)).toEqual(
      repository.map((entry) => ({ hash: entry.hash, created_at: String(entry.when) })),
    );
  }, 120_000);

  it("upgrades exact 0010 atomically, permits both new formats, and reruns without drift", async () => {
    const repository = await readRepositoryMigrations(migrationsDirectory);
    const database = await createTestDatabase();
    await migrateThrough0010(database.migrationUrl);
    expect(await journalRows(database.migrationUrl)).toEqual(
      repository.slice(0, 11).map((entry) => ({
        hash: entry.hash,
        created_at: String(entry.when),
      })),
    );

    const actorId = `phase5-export-format-upgrade-${randomUUID()}`;
    const client = postgres(database.migrationUrl, { max: 1, onnotice() {} });
    let workspaceId: string;
    try {
      await client`
        insert into "user" (id, name, email)
        values (${actorId}, 'Export format upgrade', ${`${actorId}@example.test`})
      `;
      const [workspace] = await client<{ id: string }[]>`
        insert into workspaces (personal_owner_id) values (${actorId}) returning id
      `;
      workspaceId = workspace!.id;
      const rejectedId = randomUUID();
      await expect(client`
        insert into exports (
          id, workspace_id, requester_id, scope_type, format, status,
          idempotency_key, request_hash, expires_at
        ) values (
          ${rejectedId}, ${workspaceId}, ${actorId}, 'workspace', 'plain-text', 'pending',
          'before-0011', ${"1".repeat(64)}, now() + interval '1 day'
        )
      `).rejects.toMatchObject({ code: "23514", constraint_name: "exports_format_check" });

      const migration = await readFile(
        new URL("./0011_phase5_export_formats.sql", import.meta.url),
        "utf8",
      );
      await expect(
        client.begin(async (transaction) => {
          await applySql(transaction, migration);
          throw new Error("force 0011 rollback");
        }),
      ).rejects.toThrow("force 0011 rollback");
      await expect(client`
        insert into exports (
          id, workspace_id, requester_id, scope_type, format, status,
          idempotency_key, request_hash, expires_at
        ) values (
          ${randomUUID()}, ${workspaceId}, ${actorId}, 'workspace', 'ast-json', 'pending',
          'rolled-back-0011', ${"2".repeat(64)}, now() + interval '1 day'
        )
      `).rejects.toMatchObject({ code: "23514", constraint_name: "exports_format_check" });
    } finally {
      await client.end();
    }

    await migrateDatabase(database.migrationUrl);
    const verify = postgres(database.migrationUrl, { max: 1, onnotice() {} });
    try {
      for (const [format, key, hash] of [
        ["plain-text", "after-0011-plain", "3".repeat(64)],
        ["ast-json", "after-0011-ast", "4".repeat(64)],
      ] as const) {
        await verify`
          insert into exports (
            id, workspace_id, requester_id, scope_type, format, status,
            idempotency_key, request_hash, expires_at
          ) values (
            ${randomUUID()}, ${workspaceId}, ${actorId}, 'workspace', ${format}, 'pending',
            ${key}, ${hash}, now() + interval '1 day'
          )
        `;
      }
      expect(
        await verify<{ format: string }[]>`
          select format from exports where requester_id = ${actorId} order by format
        `,
      ).toEqual([{ format: "ast-json" }, { format: "plain-text" }]);
    } finally {
      await verify.end();
    }
    await migrateDatabase(database.migrationUrl);
    expect(await journalRows(database.migrationUrl)).toHaveLength(repository.length);
  }, 120_000);

  it("rolls 0008 back atomically and preserves pre-existing note bytes before a clean upgrade", async () => {
    const repository = await readRepositoryMigrations(migrationsDirectory);
    const database = await createTestDatabase();
    await migrateThroughPhase3(database.migrationUrl);
    await migrateThroughPhase5Search(database.migrationUrl);

    const actorId = `phase5-transfer-rollback-${randomUUID()}`;
    const markdown = "---\nglyphquire-spec: 1\n---\n\n# Preserve these bytes\n";
    const seed = postgres(database.migrationUrl, { max: 1, onnotice() {} });
    let noteId: string;
    try {
      await seed`
        insert into "user" (id, name, email)
        values (${actorId}, 'Phase 5 Transfer', ${`${actorId}@example.test`})
      `;
      const [workspace] = await seed<{ id: string }[]>`
        insert into workspaces (personal_owner_id)
        values (${actorId})
        returning id
      `;
      const [note] = await seed<{ id: string }[]>`
        insert into notes (workspace_id, title, content_markdown, content_hash, owner_id)
        values (${workspace!.id}, 'Rollback note', ${markdown}, 'hash', ${actorId})
        returning id
      `;
      noteId = note!.id;
    } finally {
      await seed.end();
    }

    const source = await readFile(new URL("./0008_phase5_exports.sql", import.meta.url), "utf8");
    const client = postgres(database.migrationUrl, { max: 1, onnotice() {} });
    try {
      await expect(
        client.begin(async (transaction) => {
          await applySql(transaction, source);
          throw new Error("force migration rollback");
        }),
      ).rejects.toThrow("force migration rollback");
      expect(
        await client<
          { imports: string | null; resources: string | null; exports: string | null }[]
        >`
          select
            pg_catalog.to_regclass('public.imports')::text as imports,
            pg_catalog.to_regclass('public.import_resources')::text as resources,
            pg_catalog.to_regclass('public.exports')::text as exports
        `,
      ).toEqual([{ imports: null, resources: null, exports: null }]);
      expect(await journalRows(database.migrationUrl)).toHaveLength(repository.slice(0, 8).length);
      expect(
        await client<{ content_markdown: string }[]>`
          select content_markdown from notes where id = ${noteId}
        `,
      ).toEqual([{ content_markdown: markdown }]);
    } finally {
      await client.end();
    }

    await migrateDatabase(database.migrationUrl);
    const verify = postgres(database.migrationUrl, { max: 1, onnotice() {} });
    try {
      expect(
        await verify<{ content_markdown: string }[]>`
          select content_markdown from notes where id = ${noteId}
        `,
      ).toEqual([{ content_markdown: markdown }]);
    } finally {
      await verify.end();
    }
  }, 120_000);

  it("enforces transfer scope, replay, object-key ownership, ledger, and state constraints", async () => {
    const database = await createTestDatabase();
    await migrateDatabase(database.migrationUrl);
    const client = postgres(database.migrationUrl, { max: 1, onnotice() {} });
    const actorId = `phase5-transfer-${randomUUID()}`;
    const otherActorId = `phase5-transfer-other-${randomUUID()}`;
    try {
      await client`
        insert into "user" (id, name, email)
        values
          (${actorId}, 'Phase 5 Transfer', ${`${actorId}@example.test`}),
          (${otherActorId}, 'Phase 5 Transfer Other', ${`${otherActorId}@example.test`})
      `;
      const [workspace] = await client<{ id: string }[]>`
        insert into workspaces (personal_owner_id) values (${actorId}) returning id
      `;
      const [otherWorkspace] = await client<{ id: string }[]>`
        insert into workspaces (personal_owner_id) values (${otherActorId}) returning id
      `;
      const [note] = await client<{ id: string }[]>`
        insert into notes (workspace_id, title, content_markdown, content_hash, owner_id)
        values (${workspace!.id}, 'Import target', 'body', 'hash', ${actorId})
        returning id
      `;

      const importId = randomUUID();
      await expect(
        client`
          insert into imports (
            id, workspace_id, actor_id, source_object_key, status, expires_at,
            idempotency_key, request_hash
          ) values (
            ${importId}, ${workspace!.id}, ${actorId}, 'attacker/key', 'staging',
            now() + interval '1 day', 'import-key', ${"a".repeat(64)}
          )
        `,
      ).rejects.toMatchObject({
        code: "23514",
        constraint_name: "imports_source_object_key_check",
      });

      await expect(
        client`
          insert into imports (
            id, workspace_id, actor_id, target_note_id, source_object_key, status,
            expires_at, idempotency_key, request_hash
          ) values (
            ${importId}, ${workspace!.id}, ${actorId}, ${note!.id},
            ${sourceObjectKey(workspace!.id, importId)}, 'staging',
            now() + interval '1 day', 'import-key', ${"a".repeat(64)}
          )
        `,
      ).rejects.toMatchObject({
        code: "23514",
        constraint_name: "imports_target_revision_shape_check",
      });

      await client`
        insert into imports (
          id, workspace_id, actor_id, target_note_id, base_revision, source_object_key,
          status, expires_at, idempotency_key, request_hash
        ) values (
          ${importId}, ${workspace!.id}, ${actorId}, ${note!.id}, 1,
          ${sourceObjectKey(workspace!.id, importId)}, 'staging',
          now() + interval '1 day', 'import-key', ${"a".repeat(64)}
        )
      `;

      const duplicateImportId = randomUUID();
      await expect(
        client`
          insert into imports (
            id, workspace_id, actor_id, source_object_key, status, expires_at,
            idempotency_key, request_hash
          ) values (
            ${duplicateImportId}, ${workspace!.id}, ${actorId},
            ${sourceObjectKey(workspace!.id, duplicateImportId)}, 'staging',
            now() + interval '1 day', 'import-key', ${"b".repeat(64)}
          )
        `,
      ).rejects.toMatchObject({ code: "23505" });

      const otherImportId = randomUUID();
      await client`
        insert into imports (
          id, workspace_id, actor_id, source_object_key, status, expires_at,
          idempotency_key, request_hash
        ) values (
          ${otherImportId}, ${otherWorkspace!.id}, ${otherActorId},
          ${sourceObjectKey(otherWorkspace!.id, otherImportId)}, 'staging',
          now() + interval '1 day', 'other-import-key', ${"c".repeat(64)}
        )
      `;

      const resourceId = randomUUID();
      await expect(
        client`
          insert into import_resources (id, import_id, workspace_id, object_key, state)
          values (
            ${resourceId}, ${importId}, ${otherWorkspace!.id},
            ${resourceObjectKey(otherWorkspace!.id, importId, resourceId)}, 'declared'
          )
        `,
      ).rejects.toMatchObject({
        code: "23503",
        constraint_name: "import_resources_import_workspace_fk",
      });

      await expect(
        client`
          insert into import_resources (id, import_id, workspace_id, object_key, state)
          values (${resourceId}, ${importId}, ${workspace!.id}, 'attacker/key', 'declared')
        `,
      ).rejects.toMatchObject({
        code: "23514",
        constraint_name: "import_resources_object_key_check",
      });

      await expect(
        client`
          insert into import_resources (id, import_id, workspace_id, object_key, state)
          values (
            ${resourceId}, ${importId}, ${workspace!.id},
            ${resourceObjectKey(workspace!.id, importId, resourceId)}, 'promoted'
          )
        `,
      ).rejects.toMatchObject({
        code: "23514",
        constraint_name: "import_resources_promoted_asset_check",
      });

      await client`
        insert into import_resources (id, import_id, workspace_id, object_key, state)
        values (
          ${resourceId}, ${importId}, ${workspace!.id},
          ${resourceObjectKey(workspace!.id, importId, resourceId)}, 'uploaded'
        )
      `;

      const exportId = randomUUID();
      await expect(
        client`
          insert into exports (
            id, workspace_id, requester_id, scope_type, format, status,
            idempotency_key, request_hash, expires_at
          ) values (
            ${exportId}, ${workspace!.id}, ${actorId}, 'note', 'zip', 'pending',
            'export-key', ${"d".repeat(64)}, now() + interval '1 day'
          )
        `,
      ).rejects.toMatchObject({
        code: "23514",
        constraint_name: "exports_scope_shape_check",
      });

      await client`
        insert into exports (
          id, workspace_id, requester_id, scope_type, note_id, format, status,
          idempotency_key, request_hash, expires_at
        ) values (
          ${exportId}, ${workspace!.id}, ${actorId}, 'note', ${note!.id}, 'zip', 'pending',
          'export-key', ${"d".repeat(64)}, now() + interval '1 day'
        )
      `;
      await expect(
        client`
          update exports set object_key = 'attacker/key' where id = ${exportId}
        `,
      ).rejects.toMatchObject({
        code: "23514",
        constraint_name: "exports_object_key_check",
      });
      await client`
        update exports
        set object_key = ${exportObjectKey(workspace!.id, exportId)}, status = 'completed'
        where id = ${exportId}
      `;

      const duplicateExportId = randomUUID();
      await expect(
        client`
          insert into exports (
            id, workspace_id, requester_id, scope_type, format, status,
            idempotency_key, request_hash, expires_at
          ) values (
            ${duplicateExportId}, ${workspace!.id}, ${actorId}, 'workspace', 'html', 'pending',
            'export-key', ${"e".repeat(64)}, now() + interval '1 day'
          )
        `,
      ).rejects.toMatchObject({ code: "23505" });

      await client`delete from imports where id = ${importId}`;
      expect(
        await client<{ id: string }[]>`
          select id from import_resources where id = ${resourceId}
        `,
      ).toEqual([]);
    } finally {
      await client.end();
    }
  }, 120_000);

  it("allows runtime transfer DML while denying role escalation, DDL, and journal writes", async () => {
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
    const actorId = `phase5-transfer-runtime-${randomUUID()}`;
    try {
      await runtime`
        insert into "user" (id, name, email)
        values (${actorId}, 'Runtime Transfer', ${`${actorId}@example.test`})
      `;
      const [workspace] = await runtime<{ id: string }[]>`
        insert into workspaces (personal_owner_id) values (${actorId}) returning id
      `;
      const importId = randomUUID();
      await runtime`
        insert into imports (
          id, workspace_id, actor_id, source_object_key, status, expires_at,
          idempotency_key, request_hash
        ) values (
          ${importId}, ${workspace!.id}, ${actorId},
          ${sourceObjectKey(workspace!.id, importId)}, 'staging',
          now() + interval '1 day', 'runtime-import', ${"f".repeat(64)}
        )
      `;
      const resourceId = randomUUID();
      await runtime`
        insert into import_resources (id, import_id, workspace_id, object_key, state)
        values (
          ${resourceId}, ${importId}, ${workspace!.id},
          ${resourceObjectKey(workspace!.id, importId, resourceId)}, 'declared'
        )
      `;
      expect(
        await runtime<{ id: string }[]>`select id from imports where id = ${importId}`,
      ).toEqual([{ id: importId }]);

      const exportId = randomUUID();
      await runtime`
        insert into exports (
          id, workspace_id, requester_id, scope_type, format, status,
          idempotency_key, request_hash, expires_at
        ) values (
          ${exportId}, ${workspace!.id}, ${actorId}, 'workspace', 'ast-json', 'pending',
          'runtime-ast-json', ${"9".repeat(64)}, now() + interval '1 day'
        )
      `;
      expect(
        await runtime<{ format: string }[]>`select format from exports where id = ${exportId}`,
      ).toEqual([{ format: "ast-json" }]);

      await expect(runtime.unsafe(`set role "${migrationRole}"`)).rejects.toMatchObject({
        code: "42501",
      });
      await expect(
        runtime.unsafe("create table public.phase5_transfer_runtime_forbidden (id integer)"),
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
