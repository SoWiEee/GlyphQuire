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
const describeWithPostgres = migrationDatabaseUrl ? describe : describe.skip;

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
  it("preserves frozen migrations and commits exactly 0000 through 0002", async () => {
    for (const [path, expectedHash] of Object.entries(frozenMigrationArtifacts)) {
      expect(await sha256(path)).toBe(expectedHash);
    }

    const migrations = await readRepositoryMigrations(migrationsDirectory);
    expect(migrations.map(({ idx, tag }) => ({ idx, tag }))).toEqual([
      { idx: 0, tag: "0000_phase0_auth" },
      { idx: 1, tag: "0001_phase2_workspaces" },
      { idx: 2, tag: "0002_phase2_notes" },
    ]);
    expect(migrations.every(({ hash }) => /^[a-f0-9]{64}$/.test(hash))).toBe(true);
    expect(new Set(migrations.map(({ when }) => when)).size).toBe(3);
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
  });
});

describeWithPostgres("note persistence database constraints", () => {
  let admin: Sql;
  let databaseName: string;
  let databaseUrl: string;
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
});
