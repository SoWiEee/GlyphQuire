import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { getTableConfig, type AnyPgTable } from "drizzle-orm/pg-core";
import postgres, { type Sql } from "postgres";
import { afterAll, beforeAll, describe, expect, expectTypeOf, it } from "vitest";
import {
  documentJobs as exportedDocumentJobs,
  notes as exportedNotes,
  noteOperations as exportedNoteOperations,
  noteVersions as exportedNoteVersions,
  type DocumentJob,
  type NewDocumentJob,
  type NewNote,
  type NewNoteOperation,
  type NewNoteVersion,
  type Note,
  type NoteOperation,
  type NoteVersion,
} from "../index.js";
import { createDb } from "../client.js";
import {
  readRepositoryMigrations,
  verifyMigrationBaseline,
} from "../migrations/verify-baseline.js";
import { documentJobs } from "./document-jobs.js";
import { noteOperations } from "./note-operations.js";
import { noteVersions } from "./note-versions.js";
import { notes } from "./notes.js";

const migrationsDirectory = fileURLToPath(new URL("../migrations/", import.meta.url));
const migrationDatabaseUrl = process.env.TEST_MIGRATION_DATABASE_URL;
const runtimeDatabaseUrl = process.env.TEST_DATABASE_URL;
const describeWithPostgres = migrationDatabaseUrl ? describe : describe.skip;
const itWithRuntimePostgres = runtimeDatabaseUrl ? it : it.skip;

const frozenMigrationArtifacts = {
  "0000_phase0_auth.sql": "7fbba803d17ce335f8acc41fd7027c3c1278d4af79225c48ac6d0ab885028863",
  "0001_phase2_workspaces.sql": "c0aac84d7bb3fd4766604dfa46d2f0df18b5b4f027e42e5ec6696e9386f1f162",
  "meta/0000_snapshot.json": "ddbdd01656f226667fc4e9b8533d946d8d57ed643d580ade86d4451a27c0be66",
  "meta/0001_snapshot.json": "34bd5364fd4c17657b6caeaf1c6b04090274b1a01b04055c133c7fb384008519",
} as const;

function config(table: AnyPgTable) {
  return getTableConfig(table);
}

function columnNames(table: AnyPgTable) {
  return config(table).columns.map((column) => column.name);
}

function indexDefinition(table: AnyPgTable, name: string) {
  const tableIndex = config(table).indexes.find((index) => index.config.name === name);
  return {
    unique: tableIndex?.config.unique,
    columns: tableIndex?.config.columns.map((column) =>
      "name" in column ? column.name : undefined,
    ),
    partial: tableIndex?.config.where !== undefined,
  };
}

function foreignKeyNames(table: AnyPgTable) {
  return config(table).foreignKeys.map((foreignKey) => foreignKey.getName());
}

function checkNames(table: AnyPgTable) {
  return config(table).checks.map((constraint) => constraint.name);
}

function assertRandomUuidPrimaryKey(table: AnyPgTable) {
  const id = config(table).columns.find((column) => column.name === "id");
  expect(id?.getSQLType()).toBe("uuid");
  expect(id?.primary).toBe(true);
  expect(id?.hasDefault).toBe(true);
}

async function sha256(relativePath: string) {
  return createHash("sha256")
    .update(await readFile(new URL(`../migrations/${relativePath}`, import.meta.url)))
    .digest("hex");
}

type DocumentJobFixture = {
  actorId: string;
  workspaceId: string;
  noteId: string;
  noteOperationId: string;
  operationId: string;
  jobId: string;
};

async function insertDocumentJobFixture(sql: Sql): Promise<DocumentJobFixture> {
  const actorId = `job-actor-${randomUUID()}`;
  const operationId = randomUUID();
  const contentHash = "f".repeat(64);

  await sql`
    insert into "user" (id, name, email)
    values (${actorId}, 'Job Actor', ${`${actorId}@example.test`})
  `;
  const [workspace] = await sql<{ id: string }[]>`
    insert into workspaces (personal_owner_id)
    values (${actorId})
    returning id
  `;
  await sql`
    insert into workspace_members (workspace_id, user_id, role)
    values (${workspace!.id}, ${actorId}, 'owner')
  `;
  const [note] = await sql<{ id: string }[]>`
    insert into notes (
      workspace_id, title, content_markdown, revision, content_hash,
      owner_id, schema_version, visibility
    )
    values (${workspace!.id}, 'Outbox note', '', 1, ${contentHash}, ${actorId}, 1, 'private')
    returning id
  `;
  const [operation] = await sql<{ id: string }[]>`
    insert into note_operations (
      workspace_id, note_id, actor_id, operation_id, operation_kind,
      base_revision, request_hash, recorded_response
    )
    values (
      ${workspace!.id}, ${note!.id}, ${actorId}, ${operationId}, 'create',
      null, ${"e".repeat(64)}, ${sql.json({ noteId: note!.id, revision: 1 })}
    )
    returning id
  `;
  const [job] = await sql<{ id: string }[]>`
    insert into document_jobs (
      workspace_id, note_id, note_operation_id, operation_id, revision, kind
    )
    values (
      ${workspace!.id}, ${note!.id}, ${operation!.id}, ${operationId}, 1, 'upsert'
    )
    returning id
  `;

  return {
    actorId,
    workspaceId: workspace!.id,
    noteId: note!.id,
    noteOperationId: operation!.id,
    operationId,
    jobId: job!.id,
  };
}

async function claimDocumentJob(sql: Sql, fixture: DocumentJobFixture, attempts = 1) {
  await sql`
    update document_jobs
    set
      status = 'processing',
      attempts = ${attempts},
      locked_at = now(),
      locked_by = 'dispatcher-1',
      last_error = null,
      updated_at = now()
    where id = ${fixture.jobId}
  `;
}

describe("note persistence schema", () => {
  it("re-exports only backend persistence tables and inferred row contracts", () => {
    expect(exportedNotes).toBe(notes);
    expect(exportedNoteVersions).toBe(noteVersions);
    expect(exportedNoteOperations).toBe(noteOperations);
    expect(exportedDocumentJobs).toBe(documentJobs);

    expectTypeOf<Note>().toEqualTypeOf<typeof notes.$inferSelect>();
    expectTypeOf<NewNote>().toEqualTypeOf<typeof notes.$inferInsert>();
    expectTypeOf<NoteVersion>().toEqualTypeOf<typeof noteVersions.$inferSelect>();
    expectTypeOf<NewNoteVersion>().toEqualTypeOf<typeof noteVersions.$inferInsert>();
    expectTypeOf<NoteOperation>().toEqualTypeOf<typeof noteOperations.$inferSelect>();
    expectTypeOf<NewNoteOperation>().toEqualTypeOf<typeof noteOperations.$inferInsert>();
    expectTypeOf<DocumentJob>().toEqualTypeOf<typeof documentJobs.$inferSelect>();
    expectTypeOf<NewDocumentJob>().toEqualTypeOf<typeof documentJobs.$inferInsert>();
  });

  it("uses random UUID primary keys and carries workspace identity on every resource", () => {
    for (const table of [notes, noteVersions, noteOperations, documentJobs]) {
      assertRandomUuidPrimaryKey(table);
      expect(columnNames(table)).toContain("workspace_id");
    }

    expect(foreignKeyNames(notes)).toEqual(
      expect.arrayContaining(["notes_workspace_id_workspaces_id_fk", "notes_owner_id_user_id_fk"]),
    );
    expect(foreignKeyNames(noteVersions)).toEqual(
      expect.arrayContaining([
        "note_versions_workspace_id_workspaces_id_fk",
        "note_versions_created_by_id_user_id_fk",
        "note_versions_note_workspace_fk",
      ]),
    );
    expect(foreignKeyNames(noteOperations)).toEqual(
      expect.arrayContaining([
        "note_operations_workspace_id_workspaces_id_fk",
        "note_operations_actor_id_user_id_fk",
        "note_operations_note_workspace_fk",
      ]),
    );
    expect(foreignKeyNames(documentJobs)).toEqual(
      expect.arrayContaining([
        "document_jobs_workspace_id_workspaces_id_fk",
        "document_jobs_note_workspace_fk",
        "document_jobs_operation_identity_fk",
      ]),
    );
  });

  it("stores canonical note source with private-only visibility and guarded revisions", () => {
    expect(columnNames(notes)).toEqual(
      expect.arrayContaining([
        "title",
        "content_markdown",
        "revision",
        "content_hash",
        "owner_id",
        "schema_version",
        "visibility",
        "deleted_at",
      ]),
    );
    expect(checkNames(notes)).toEqual(
      expect.arrayContaining([
        "notes_visibility_private_check",
        "notes_revision_positive_check",
        "notes_schema_version_positive_check",
        "notes_title_length_check",
        "notes_markdown_size_check",
      ]),
    );
    expect(indexDefinition(notes, "notes_id_workspace_id_unique")).toEqual({
      unique: true,
      columns: ["id", "workspace_id"],
      partial: false,
    });
    expect(indexDefinition(notes, "notes_workspace_deleted_updated_id_idx").columns).toEqual([
      "workspace_id",
      "deleted_at",
      "updated_at",
      "id",
    ]);
    expect(
      indexDefinition(notes, "notes_workspace_id_revision_visibility_deleted_idx").columns,
    ).toEqual(["workspace_id", "id", "revision", "visibility", "deleted_at"]);
  });

  it("defines immutable, uniquely revisioned snapshots with exact Markdown metadata", () => {
    expect(columnNames(noteVersions)).toEqual(
      expect.arrayContaining([
        "note_id",
        "workspace_id",
        "revision",
        "schema_version",
        "content_markdown",
        "content_hash",
        "reason",
        "created_by_id",
      ]),
    );
    expect(checkNames(noteVersions)).toEqual(
      expect.arrayContaining([
        "note_versions_revision_positive_check",
        "note_versions_schema_version_positive_check",
        "note_versions_reason_check",
        "note_versions_markdown_size_check",
      ]),
    );
    expect(indexDefinition(noteVersions, "note_versions_note_revision_unique")).toEqual({
      unique: true,
      columns: ["note_id", "revision"],
      partial: false,
    });
    expect(
      indexDefinition(noteVersions, "note_versions_workspace_note_revision_idx").columns,
    ).toEqual(["workspace_id", "note_id", "revision"]);
  });

  it("defines separate create and existing-note idempotency scopes", () => {
    expect(columnNames(noteOperations)).toEqual(
      expect.arrayContaining([
        "workspace_id",
        "note_id",
        "actor_id",
        "operation_id",
        "operation_kind",
        "base_revision",
        "request_hash",
        "recorded_response",
      ]),
    );
    expect(checkNames(noteOperations)).toEqual(
      expect.arrayContaining([
        "note_operations_kind_check",
        "note_operations_base_revision_check",
        "note_operations_request_hash_check",
      ]),
    );
    expect(indexDefinition(noteOperations, "note_operations_create_scope_unique")).toEqual({
      unique: true,
      columns: ["actor_id", "workspace_id", "operation_kind", "operation_id"],
      partial: true,
    });
    expect(indexDefinition(noteOperations, "note_operations_existing_scope_unique")).toEqual({
      unique: true,
      columns: ["actor_id", "workspace_id", "note_id", "operation_kind", "operation_id"],
      partial: true,
    });
  });

  it("defines a durable, constrained, and efficiently claimable document outbox", () => {
    expect(columnNames(documentJobs)).toEqual(
      expect.arrayContaining([
        "workspace_id",
        "note_id",
        "note_operation_id",
        "operation_id",
        "revision",
        "kind",
        "status",
        "attempts",
        "available_at",
        "locked_at",
        "locked_by",
        "completed_at",
        "dead_lettered_at",
        "last_error",
      ]),
    );
    expect(checkNames(documentJobs)).toEqual(
      expect.arrayContaining([
        "document_jobs_revision_positive_check",
        "document_jobs_kind_check",
        "document_jobs_status_check",
        "document_jobs_attempts_nonnegative_check",
        "document_jobs_state_shape_check",
      ]),
    );
    expect(indexDefinition(documentJobs, "document_jobs_identity_unique")).toEqual({
      unique: true,
      columns: ["note_id", "revision", "operation_id"],
      partial: false,
    });
    expect(indexDefinition(documentJobs, "document_jobs_pending_due_idx")).toMatchObject({
      columns: ["status", "available_at", "created_at", "id"],
      partial: true,
    });
    expect(indexDefinition(documentJobs, "document_jobs_processing_lock_idx")).toMatchObject({
      columns: ["status", "locked_at"],
      partial: true,
    });
  });
});

describe("note persistence migration", () => {
  it("preserves the frozen 0000 through 0002 migration prefix", async () => {
    for (const [path, expectedHash] of Object.entries(frozenMigrationArtifacts)) {
      expect(await sha256(path)).toBe(expectedHash);
    }

    const migrations = await readRepositoryMigrations(migrationsDirectory);
    expect(migrations.slice(0, 3).map(({ idx, tag }) => ({ idx, tag }))).toEqual([
      { idx: 0, tag: "0000_phase0_auth" },
      { idx: 1, tag: "0001_phase2_workspaces" },
      { idx: 2, tag: "0002_phase2_notes" },
    ]);
    expect(migrations.slice(0, 3).every(({ hash }) => /^[a-f0-9]{64}$/.test(hash))).toBe(true);
    expect(new Set(migrations.slice(0, 3).map(({ when }) => when)).size).toBe(3);
  });

  it("enforces tenant binding, monotonic current revisions, and immutable records in SQL", async () => {
    const migrationSql = await readFile(
      new URL("../migrations/0002_phase2_notes.sql", import.meta.url),
      "utf8",
    );

    expect(migrationSql).toContain('CONSTRAINT "note_versions_note_workspace_fk"');
    expect(migrationSql).toContain('CONSTRAINT "note_operations_note_workspace_fk"');
    expect(migrationSql).toContain('CONSTRAINT "document_jobs_note_workspace_fk"');
    expect(migrationSql).toContain('CONSTRAINT "document_jobs_operation_identity_fk"');
    expect(migrationSql.indexOf('CREATE UNIQUE INDEX "notes_id_workspace_id_unique"')).toBeLessThan(
      migrationSql.indexOf('ADD CONSTRAINT "note_versions_note_workspace_fk"'),
    );
    expect(
      migrationSql.indexOf('CREATE UNIQUE INDEX "note_operations_job_reference_unique"'),
    ).toBeLessThan(migrationSql.indexOf('ADD CONSTRAINT "document_jobs_operation_identity_fk"'));
    expect(migrationSql).toMatch(/CREATE TRIGGER "notes_revision_guard"[\s\S]+BEFORE UPDATE/);
    expect(migrationSql).toMatch(/NEW\."workspace_id" IS DISTINCT FROM OLD\."workspace_id"/);
    expect(migrationSql).toMatch(/NEW\."owner_id" IS DISTINCT FROM OLD\."owner_id"/);
    expect(migrationSql).toMatch(/NEW\."revision" <> OLD\."revision" \+ 1/);
    expect(migrationSql).toMatch(
      /CREATE TRIGGER "note_versions_immutable"[\s\S]+BEFORE UPDATE OR DELETE/,
    );
    expect(migrationSql).toMatch(
      /CREATE TRIGGER "note_operations_immutable"[\s\S]+BEFORE UPDATE OR DELETE/,
    );
    expect(migrationSql).toMatch(
      /CREATE TRIGGER "document_jobs_update_guard"[\s\S]+BEFORE UPDATE OR DELETE/,
    );
    expect(migrationSql).toContain(`IF TG_OP = 'DELETE' THEN`);
    expect(migrationSql).toContain(`RAISE EXCEPTION 'document jobs cannot be deleted'`);
    for (const identityColumn of [
      "id",
      "workspace_id",
      "note_id",
      "note_operation_id",
      "operation_id",
      "revision",
      "kind",
      "created_at",
    ]) {
      expect(migrationSql).toContain(
        `NEW."${identityColumn}" IS DISTINCT FROM OLD."${identityColumn}"`,
      );
    }
    expect(migrationSql).toMatch(/OLD\."status" IN \('completed', 'dead_letter'\)/);
    expect(migrationSql).toMatch(/NEW\."attempts" < OLD\."attempts"/);
    expect(migrationSql).toMatch(
      /OLD\."status" = 'pending'[\s\S]+NEW\."status" IN \('pending', 'processing'\)/,
    );
    expect(migrationSql).toMatch(
      /OLD\."status" = 'processing'[\s\S]+NEW\."status" IN \('processing', 'pending', 'completed', 'dead_letter'\)/,
    );
  });
});

describeWithPostgres("note persistence database constraints", () => {
  let admin: Sql;
  let databaseName: string;
  let databaseUrl: string;
  let runtimeTestDatabaseUrl: string | undefined;
  let runtimeRole: string | undefined;
  let databaseCreated = false;

  beforeAll(async () => {
    const url = new URL(migrationDatabaseUrl!);
    if (!["127.0.0.1", "localhost"].includes(url.hostname)) {
      throw new Error("note persistence integration tests require a loopback PostgreSQL URL");
    }

    admin = postgres(migrationDatabaseUrl!, { max: 1, onnotice() {} });
    databaseName = `glyphquire_t3_${randomUUID().replaceAll("-", "")}`;
    expect(databaseName).toMatch(/^[a-z0-9_]+$/);
    await admin.unsafe(`create database "${databaseName}"`);
    databaseCreated = true;
    url.pathname = `/${databaseName}`;
    databaseUrl = url.toString();

    await verifyMigrationBaseline(databaseUrl, migrationsDirectory);
    const db = createDb(databaseUrl);
    try {
      await migrate(db, { migrationsFolder: migrationsDirectory });
    } finally {
      await db.$client.end();
    }

    if (runtimeDatabaseUrl) {
      const runtimeUrl = new URL(runtimeDatabaseUrl);
      if (!["127.0.0.1", "localhost"].includes(runtimeUrl.hostname)) {
        throw new Error("note persistence runtime tests require a loopback PostgreSQL URL");
      }
      if ((runtimeUrl.port || "5432") !== (url.port || "5432")) {
        throw new Error("migration and runtime PostgreSQL URLs must target the same server");
      }

      runtimeRole = decodeURIComponent(runtimeUrl.username);
      if (!/^[a-z_][a-z0-9_]{0,62}$/.test(runtimeRole)) {
        throw new Error("runtime PostgreSQL role must use a simple unquoted identifier");
      }

      await admin.unsafe(`grant connect on database "${databaseName}" to "${runtimeRole}"`);
      const migrationSql = postgres(databaseUrl, { max: 1, onnotice() {} });
      try {
        await migrationSql.unsafe(`grant usage on schema public to "${runtimeRole}"`);
        await migrationSql.unsafe(
          `grant select, insert, update, delete on all tables in schema public to "${runtimeRole}"`,
        );
        await migrationSql.unsafe(
          `grant usage on all sequences in schema public to "${runtimeRole}"`,
        );
      } finally {
        await migrationSql.end();
      }

      runtimeUrl.pathname = `/${databaseName}`;
      runtimeTestDatabaseUrl = runtimeUrl.toString();
    }
  });

  afterAll(async () => {
    if (admin && databaseCreated) {
      await admin`
        select pg_catalog.pg_terminate_backend(activity.pid)
        from pg_catalog.pg_stat_activity activity
        where activity.datname = ${databaseName}
          and activity.pid <> pg_catalog.pg_backend_pid()
      `;
      await admin.unsafe(`drop database "${databaseName}"`);
    }
    if (admin) await admin.end();
  });

  it("rejects cross-workspace, revision, immutability, idempotency, and outbox abuses", async () => {
    const sql = postgres(databaseUrl, { max: 1, onnotice() {} });
    const actorId = `actor-${randomUUID()}`;
    const otherActorId = `actor-${randomUUID()}`;
    const requestHash = "a".repeat(64);
    const contentHash = "b".repeat(64);

    try {
      await sql`
        insert into "user" (id, name, email)
        values
          (${actorId}, 'Actor', ${`${actorId}@example.test`}),
          (${otherActorId}, 'Other', ${`${otherActorId}@example.test`})
      `;
      const [workspace] = await sql<{ id: string }[]>`
        insert into workspaces (personal_owner_id)
        values (${actorId})
        returning id
      `;
      const [otherWorkspace] = await sql<{ id: string }[]>`
        insert into workspaces (personal_owner_id)
        values (${otherActorId})
        returning id
      `;
      await sql`
        insert into workspace_members (workspace_id, user_id, role)
        values
          (${workspace!.id}, ${actorId}, 'owner'),
          (${otherWorkspace!.id}, ${otherActorId}, 'owner')
      `;

      const [note] = await sql<{ id: string }[]>`
        insert into notes (
          workspace_id, title, content_markdown, revision, content_hash,
          owner_id, schema_version, visibility
        )
        values (${workspace!.id}, 'First', '# exact\n', 1, ${contentHash}, ${actorId}, 1, 'private')
        returning id
      `;
      const [otherNote] = await sql<{ id: string }[]>`
        insert into notes (
          workspace_id, title, content_markdown, revision, content_hash,
          owner_id, schema_version, visibility
        )
        values (
          ${workspace!.id}, 'Second', '# second\n', 1, ${contentHash}, ${actorId}, 1, 'private'
        )
        returning id
      `;
      const [storedNote] = await sql<
        { content_markdown: string; content_hash: string; schema_version: number }[]
      >`
        select content_markdown, content_hash, schema_version
        from notes
        where id = ${note!.id}
      `;
      expect(storedNote).toEqual({
        content_markdown: "# exact\n",
        content_hash: contentHash,
        schema_version: 1,
      });

      await expect(
        sql`
          insert into notes (
            workspace_id, title, content_markdown, revision, content_hash,
            owner_id, schema_version, visibility
          )
          values (
            ${workspace!.id}, 'Visible', '', 1, ${contentHash}, ${actorId}, 1, 'workspace'
          )
        `,
      ).rejects.toMatchObject({ code: "23514" });
      await expect(
        sql`
          insert into notes (
            workspace_id, title, content_markdown, revision, content_hash,
            owner_id, schema_version, visibility
          )
          values (${workspace!.id}, 'Zero', '', 0, ${contentHash}, ${actorId}, 1, 'private')
        `,
      ).rejects.toMatchObject({ code: "23514" });
      await expect(sql`update notes set revision = 3 where id = ${note!.id}`).rejects.toMatchObject(
        { code: "23514" },
      );
      await sql`update notes set revision = 2, updated_at = now() where id = ${note!.id}`;
      await expect(sql`update notes set revision = 1 where id = ${note!.id}`).rejects.toMatchObject(
        { code: "23514" },
      );
      await expect(
        sql`
          update notes
          set workspace_id = ${otherWorkspace!.id}, revision = 3
          where id = ${note!.id}
        `,
      ).rejects.toMatchObject({ code: "23514" });

      await expect(
        sql`
          insert into note_versions (
            workspace_id, note_id, revision, schema_version, content_markdown,
            content_hash, reason, created_by_id
          )
          values (
            ${otherWorkspace!.id}, ${note!.id}, 1, 1, '# exact\n',
            ${contentHash}, 'checkpoint', ${actorId}
          )
        `,
      ).rejects.toMatchObject({ code: "23503" });
      const [version] = await sql<{ id: string }[]>`
        insert into note_versions (
          workspace_id, note_id, revision, schema_version, content_markdown,
          content_hash, reason, created_by_id
        )
        values (
          ${workspace!.id}, ${note!.id}, 1, 1, '# exact\n',
          ${contentHash}, 'checkpoint', ${actorId}
        )
        returning id
      `;
      await expect(
        sql`
          insert into note_versions (
            workspace_id, note_id, revision, schema_version, content_markdown,
            content_hash, reason, created_by_id
          )
          values (
            ${workspace!.id}, ${note!.id}, 1, 1, 'changed',
            ${contentHash}, 'autosave', ${actorId}
          )
        `,
      ).rejects.toMatchObject({ code: "23505" });
      await expect(
        sql`update note_versions set content_markdown = 'tampered' where id = ${version!.id}`,
      ).rejects.toMatchObject({ code: "55000" });
      await expect(sql`delete from note_versions where id = ${version!.id}`).rejects.toMatchObject({
        code: "55000",
      });

      const createOperationId = randomUUID();
      await expect(
        sql`
          insert into note_operations (
            workspace_id, note_id, actor_id, operation_id, operation_kind,
            base_revision, request_hash, recorded_response
          )
          values (
            ${otherWorkspace!.id}, ${note!.id}, ${actorId}, ${randomUUID()}, 'rename',
            1, ${requestHash}, ${sql.json({ noteId: note!.id, revision: 2 })}
          )
        `,
      ).rejects.toMatchObject({ code: "23503" });
      const [createOperation] = await sql<{ id: string }[]>`
        insert into note_operations (
          workspace_id, note_id, actor_id, operation_id, operation_kind,
          base_revision, request_hash, recorded_response
        )
        values (
          ${workspace!.id}, ${note!.id}, ${actorId}, ${createOperationId}, 'create',
          null, ${requestHash}, ${sql.json({ noteId: note!.id, revision: 1 })}
        )
        returning id
      `;
      await expect(
        sql`
          insert into note_operations (
            workspace_id, note_id, actor_id, operation_id, operation_kind,
            base_revision, request_hash, recorded_response
          )
          values (
            ${workspace!.id}, ${otherNote!.id}, ${actorId}, ${createOperationId}, 'create',
            null, ${"c".repeat(64)}, ${sql.json({ noteId: otherNote!.id, revision: 1 })}
          )
        `,
      ).rejects.toMatchObject({ code: "23505" });

      const mutationOperationId = randomUUID();
      const [mutationOperation] = await sql<{ id: string }[]>`
        insert into note_operations (
          workspace_id, note_id, actor_id, operation_id, operation_kind,
          base_revision, request_hash, recorded_response
        )
        values (
          ${workspace!.id}, ${note!.id}, ${actorId}, ${mutationOperationId}, 'rename',
          1, ${requestHash}, ${sql.json({ noteId: note!.id, revision: 2 })}
        )
        returning id
      `;
      await expect(
        sql`
          insert into note_operations (
            workspace_id, note_id, actor_id, operation_id, operation_kind,
            base_revision, request_hash, recorded_response
          )
          values (
            ${workspace!.id}, ${note!.id}, ${actorId}, ${mutationOperationId}, 'rename',
            1, ${"d".repeat(64)}, ${sql.json({ noteId: note!.id, revision: 2 })}
          )
        `,
      ).rejects.toMatchObject({ code: "23505" });
      await sql`
        insert into note_operations (
          workspace_id, note_id, actor_id, operation_id, operation_kind,
          base_revision, request_hash, recorded_response
        )
        values (
          ${workspace!.id}, ${otherNote!.id}, ${actorId}, ${mutationOperationId}, 'rename',
          1, ${requestHash}, ${sql.json({ noteId: otherNote!.id, revision: 2 })}
        )
      `;
      await expect(
        sql`update note_operations set request_hash = ${"e".repeat(64)} where id = ${createOperation!.id}`,
      ).rejects.toMatchObject({ code: "55000" });
      await expect(
        sql`delete from note_operations where id = ${createOperation!.id}`,
      ).rejects.toMatchObject({ code: "55000" });

      const [job] = await sql<{ id: string }[]>`
        insert into document_jobs (
          workspace_id, note_id, note_operation_id, operation_id, revision, kind
        )
        values (
          ${workspace!.id}, ${note!.id}, ${mutationOperation!.id},
          ${mutationOperationId}, 2, 'upsert'
        )
        returning id
      `;
      await expect(
        sql`
          insert into document_jobs (
            workspace_id, note_id, note_operation_id, operation_id, revision, kind
          )
          values (
            ${otherWorkspace!.id}, ${note!.id}, ${mutationOperation!.id},
            ${mutationOperationId}, 3, 'upsert'
          )
        `,
      ).rejects.toMatchObject({ code: "23503" });
      await expect(
        sql`
          insert into document_jobs (
            workspace_id, note_id, note_operation_id, operation_id, revision, kind
          )
          values (
            ${workspace!.id}, ${note!.id}, ${mutationOperation!.id},
            ${mutationOperationId}, 0, 'upsert'
          )
        `,
      ).rejects.toMatchObject({ code: "23514" });
      await expect(
        sql`
          insert into document_jobs (
            workspace_id, note_id, note_operation_id, operation_id, revision, kind
          )
          values (
            ${workspace!.id}, ${note!.id}, ${mutationOperation!.id},
            ${mutationOperationId}, 2, 'upsert'
          )
        `,
      ).rejects.toMatchObject({ code: "23505" });
      await expect(
        sql`update document_jobs set status = 'processing' where id = ${job!.id}`,
      ).rejects.toMatchObject({ code: "23514" });
      await sql`
        update document_jobs
        set status = 'processing', attempts = 1, locked_at = now(), locked_by = 'dispatcher-1'
        where id = ${job!.id}
      `;
      await sql`
        update document_jobs
        set status = 'completed', locked_at = null, locked_by = null, completed_at = now()
        where id = ${job!.id}
      `;
    } finally {
      await sql.end();
    }
  });

  it("rejects reopening or otherwise updating a completed document job", async () => {
    const sql = postgres(databaseUrl, { max: 1, onnotice() {} });
    try {
      const fixture = await insertDocumentJobFixture(sql);
      await claimDocumentJob(sql, fixture);
      await sql`
        update document_jobs
        set
          status = 'completed',
          locked_at = null,
          locked_by = null,
          completed_at = now(),
          updated_at = now()
        where id = ${fixture.jobId}
      `;

      await expect(
        sql`
          update document_jobs
          set
            status = 'pending',
            completed_at = null,
            available_at = now(),
            updated_at = now()
          where id = ${fixture.jobId}
        `,
      ).rejects.toMatchObject({ code: "55000" });
      await expect(
        sql`
          update document_jobs
          set last_error = 'late mutation'
          where id = ${fixture.jobId}
        `,
      ).rejects.toMatchObject({ code: "55000" });
    } finally {
      await sql.end();
    }
  });

  it("rejects identity mutation that would free the original unique job identity", async () => {
    const sql = postgres(databaseUrl, { max: 1, onnotice() {} });
    try {
      const fixture = await insertDocumentJobFixture(sql);

      await expect(
        sql`
          with moved_job as (
            update document_jobs
            set revision = 2, kind = 'delete'
            where id = ${fixture.jobId}
            returning workspace_id, note_id, note_operation_id, operation_id
          )
          insert into document_jobs (
            workspace_id, note_id, note_operation_id, operation_id, revision, kind
          )
          select workspace_id, note_id, note_operation_id, operation_id, 1, 'upsert'
          from moved_job
        `,
      ).rejects.toMatchObject({ code: "55000" });

      const [state] = await sql<{ count: number; revisions: number[]; kinds: string[] }[]>`
        select
          count(*)::integer as count,
          array_agg(revision order by revision)::integer[] as revisions,
          array_agg(kind order by revision)::text[] as kinds
        from document_jobs
        where note_id = ${fixture.noteId}
          and operation_id = ${fixture.operationId}
      `;
      expect(state).toEqual({ count: 1, revisions: [1], kinds: ["upsert"] });
    } finally {
      await sql.end();
    }
  });

  it("rejects reopening or otherwise updating a dead-letter document job", async () => {
    const sql = postgres(databaseUrl, { max: 1, onnotice() {} });
    try {
      const fixture = await insertDocumentJobFixture(sql);
      await claimDocumentJob(sql, fixture);
      await sql`
        update document_jobs
        set
          status = 'dead_letter',
          locked_at = null,
          locked_by = null,
          dead_lettered_at = now(),
          last_error = 'terminal failure',
          updated_at = now()
        where id = ${fixture.jobId}
      `;

      await expect(
        sql`
          update document_jobs
          set
            status = 'pending',
            dead_lettered_at = null,
            available_at = now(),
            updated_at = now()
          where id = ${fixture.jobId}
        `,
      ).rejects.toMatchObject({ code: "55000" });
      await expect(
        sql`
          update document_jobs
          set last_error = 'rewritten failure'
          where id = ${fixture.jobId}
        `,
      ).rejects.toMatchObject({ code: "55000" });
    } finally {
      await sql.end();
    }
  });

  it("rejects attempts regression and direct pending completion", async () => {
    const sql = postgres(databaseUrl, { max: 1, onnotice() {} });
    try {
      const processingFixture = await insertDocumentJobFixture(sql);
      await claimDocumentJob(sql, processingFixture, 2);
      await expect(
        sql`
          update document_jobs
          set attempts = 1, updated_at = now()
          where id = ${processingFixture.jobId}
        `,
      ).rejects.toMatchObject({ code: "23514" });

      const pendingFixture = await insertDocumentJobFixture(sql);
      await expect(
        sql`
          update document_jobs
          set
            status = 'completed',
            attempts = 1,
            completed_at = now(),
            updated_at = now()
          where id = ${pendingFixture.jobId}
        `,
      ).rejects.toMatchObject({ code: "23514" });
    } finally {
      await sql.end();
    }
  });

  it("permits scheduling, claim, heartbeat, reclaim, retry, re-claim, and terminal paths", async () => {
    const sql = postgres(databaseUrl, { max: 1, onnotice() {} });
    try {
      const completedFixture = await insertDocumentJobFixture(sql);
      await sql`
        update document_jobs
        set available_at = now() + interval '1 second', last_error = 'scheduled', updated_at = now()
        where id = ${completedFixture.jobId}
      `;
      await claimDocumentJob(sql, completedFixture);
      await sql`
        update document_jobs
        set locked_at = locked_at + interval '1 millisecond', updated_at = now()
        where id = ${completedFixture.jobId}
      `;
      await sql`
        update document_jobs
        set attempts = 2, locked_at = now(), locked_by = 'dispatcher-2', updated_at = now()
        where id = ${completedFixture.jobId}
      `;
      await sql`
        update document_jobs
        set
          status = 'pending',
          available_at = now() + interval '2 seconds',
          locked_at = null,
          locked_by = null,
          last_error = 'retryable',
          updated_at = now()
        where id = ${completedFixture.jobId}
      `;
      await sql`
        update document_jobs
        set
          status = 'processing',
          attempts = 3,
          locked_at = now(),
          locked_by = 'dispatcher-3',
          last_error = null,
          updated_at = now()
        where id = ${completedFixture.jobId}
      `;
      await sql`
        update document_jobs
        set
          status = 'completed',
          locked_at = null,
          locked_by = null,
          completed_at = now(),
          updated_at = now()
        where id = ${completedFixture.jobId}
      `;

      const deadLetterFixture = await insertDocumentJobFixture(sql);
      await claimDocumentJob(sql, deadLetterFixture);
      await sql`
        update document_jobs
        set
          status = 'dead_letter',
          locked_at = null,
          locked_by = null,
          dead_lettered_at = now(),
          last_error = 'terminal failure',
          updated_at = now()
        where id = ${deadLetterFixture.jobId}
      `;

      const rows = await sql<
        { id: string; status: string; attempts: number; last_error: string | null }[]
      >`
        select id, status, attempts, last_error
        from document_jobs
        where id in (${completedFixture.jobId}, ${deadLetterFixture.jobId})
        order by id
      `;
      expect(rows).toEqual(
        [
          {
            id: completedFixture.jobId,
            status: "completed",
            attempts: 3,
            last_error: null,
          },
          {
            id: deadLetterFixture.jobId,
            status: "dead_letter",
            attempts: 1,
            last_error: "terminal failure",
          },
        ].sort((left, right) => left.id.localeCompare(right.id)),
      );
    } finally {
      await sql.end();
    }
  });

  itWithRuntimePostgres("enforces the update guard for the runtime DML role", async () => {
    const sql = postgres(runtimeTestDatabaseUrl!, { max: 1, onnotice() {} });
    try {
      const [privileges] = await sql<
        {
          role_name: string;
          can_update: boolean;
          can_delete: boolean;
          owns_table: boolean;
        }[]
      >`
        select
          current_user as role_name,
          has_table_privilege(current_user, 'public.document_jobs', 'UPDATE') as can_update,
          has_table_privilege(current_user, 'public.document_jobs', 'DELETE') as can_delete,
          pg_catalog.pg_get_userbyid(table_class.relowner) = current_user as owns_table
        from pg_catalog.pg_class table_class
        where table_class.oid = 'public.document_jobs'::regclass
      `;
      expect(privileges).toEqual({
        role_name: runtimeRole,
        can_update: true,
        can_delete: true,
        owns_table: false,
      });

      const fixture = await insertDocumentJobFixture(sql);
      await claimDocumentJob(sql, fixture);
      await sql`
        update document_jobs
        set
          status = 'completed',
          locked_at = null,
          locked_by = null,
          completed_at = now(),
          updated_at = now()
        where id = ${fixture.jobId}
      `;
      await expect(
        sql`
          update document_jobs
          set status = 'pending', completed_at = null, available_at = now(), updated_at = now()
          where id = ${fixture.jobId}
        `,
      ).rejects.toMatchObject({ code: "55000" });
    } finally {
      await sql.end();
    }
  });

  itWithRuntimePostgres(
    "rejects completed-job deletion before its unique identity can be reused",
    async () => {
      const sql = postgres(runtimeTestDatabaseUrl!, { max: 1, onnotice() {} });
      try {
        const fixture = await insertDocumentJobFixture(sql);
        await claimDocumentJob(sql, fixture);
        await sql`
          update document_jobs
          set
            status = 'completed',
            locked_at = null,
            locked_by = null,
            completed_at = now(),
            updated_at = now()
          where id = ${fixture.jobId}
        `;

        await expect(
          sql`
            with deleted_job as (
              delete from document_jobs
              where id = ${fixture.jobId}
              returning workspace_id, note_id, note_operation_id, operation_id, revision, kind
            )
            insert into document_jobs (
              workspace_id, note_id, note_operation_id, operation_id, revision, kind
            )
            select workspace_id, note_id, note_operation_id, operation_id, revision, kind
            from deleted_job
          `,
        ).rejects.toMatchObject({
          code: "55000",
          message: "document jobs cannot be deleted",
        });

        const [storedJob] = await sql<{ id: string; status: string }[]>`
          select id, status
          from document_jobs
          where note_id = ${fixture.noteId}
            and revision = 1
            and operation_id = ${fixture.operationId}
        `;
        expect(storedJob).toEqual({ id: fixture.jobId, status: "completed" });
        await expect(
          sql`
            insert into document_jobs (
              workspace_id, note_id, note_operation_id, operation_id, revision, kind
            )
            values (
              ${fixture.workspaceId}, ${fixture.noteId}, ${fixture.noteOperationId},
              ${fixture.operationId}, 1, 'upsert'
            )
          `,
        ).rejects.toMatchObject({
          code: "23505",
          constraint_name: "document_jobs_identity_unique",
        });
      } finally {
        await sql.end();
      }
    },
  );

  itWithRuntimePostgres(
    "rejects runtime deletion of pending, processing, and dead-letter jobs",
    async () => {
      const sql = postgres(runtimeTestDatabaseUrl!, { max: 1, onnotice() {} });
      try {
        const pendingFixture = await insertDocumentJobFixture(sql);
        const processingFixture = await insertDocumentJobFixture(sql);
        await claimDocumentJob(sql, processingFixture);
        const deadLetterFixture = await insertDocumentJobFixture(sql);
        await claimDocumentJob(sql, deadLetterFixture);
        await sql`
          update document_jobs
          set
            status = 'dead_letter',
            locked_at = null,
            locked_by = null,
            dead_lettered_at = now(),
            last_error = 'terminal failure',
            updated_at = now()
          where id = ${deadLetterFixture.jobId}
        `;

        const targets = [
          { state: "pending", fixture: pendingFixture },
          { state: "processing", fixture: processingFixture },
          { state: "dead_letter", fixture: deadLetterFixture },
        ];
        const outcomes: { state: string; code: string; message: string }[] = [];
        for (const target of targets) {
          try {
            await sql`delete from document_jobs where id = ${target.fixture.jobId}`;
            outcomes.push({ state: target.state, code: "resolved", message: "" });
          } catch (error) {
            const databaseError = error as Error & { code?: string };
            outcomes.push({
              state: target.state,
              code: databaseError.code ?? "unknown",
              message: databaseError.message,
            });
          }
        }

        expect(outcomes).toEqual(
          targets.map(({ state }) => ({
            state,
            code: "55000",
            message: "document jobs cannot be deleted",
          })),
        );
        const storedJobs = await sql<{ id: string; status: string }[]>`
          select id, status
          from document_jobs
          where id in (
            ${pendingFixture.jobId}, ${processingFixture.jobId}, ${deadLetterFixture.jobId}
          )
          order by status
        `;
        expect(storedJobs).toEqual(
          [
            { id: pendingFixture.jobId, status: "pending" },
            { id: processingFixture.jobId, status: "processing" },
            { id: deadLetterFixture.jobId, status: "dead_letter" },
          ].sort((left, right) => left.status.localeCompare(right.status)),
        );
      } finally {
        await sql.end();
      }
    },
  );
});
