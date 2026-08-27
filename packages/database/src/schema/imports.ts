import { relations, sql } from "drizzle-orm";
import {
  char,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { user } from "./auth.js";
import { notes } from "./notes.js";
import { workspaces } from "./workspaces.js";

export type ImportStatus =
  "staging" | "pending" | "processing" | "completed" | "failed" | "expired";

export type ImportCompensationStatus = "none" | "required" | "running" | "completed" | "failed";

export type ImportManifest = Record<string, unknown>;

export const imports = pgTable(
  "imports",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    actorId: text("actor_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    targetNoteId: uuid("target_note_id"),
    baseRevision: integer("base_revision"),
    sourceObjectKey: varchar("source_object_key", { length: 500 }).notNull(),
    status: varchar("status", { length: 16 }).$type<ImportStatus>().notNull().default("staging"),
    compensationStatus: varchar("compensation_status", { length: 16 })
      .$type<ImportCompensationStatus>()
      .notNull()
      .default("none"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    idempotencyKey: varchar("idempotency_key", { length: 200 }).notNull(),
    requestHash: char("request_hash", { length: 64 }).notNull(),
    manifest: jsonb("manifest").$type<ImportManifest>().notNull().default({}),
    lastError: varchar("last_error", { length: 4000 }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    foreignKey({
      name: "imports_target_note_workspace_fk",
      columns: [table.targetNoteId, table.workspaceId],
      foreignColumns: [notes.id, notes.workspaceId],
    }),
    uniqueIndex("imports_id_workspace_id_unique").on(table.id, table.workspaceId),
    uniqueIndex("imports_idempotency_scope_unique").on(
      table.workspaceId,
      table.actorId,
      table.idempotencyKey,
    ),
    index("imports_staging_cleanup_idx").on(
      table.status,
      table.compensationStatus,
      table.expiresAt,
      table.createdAt,
      table.id,
    ),
    check(
      "imports_status_check",
      sql`${table.status} in ('staging', 'pending', 'processing', 'completed', 'failed', 'expired')`,
    ),
    check(
      "imports_compensation_status_check",
      sql`${table.compensationStatus} in ('none', 'required', 'running', 'completed', 'failed')`,
    ),
    check(
      "imports_target_revision_shape_check",
      sql`(${table.targetNoteId} is null and ${table.baseRevision} is null)
        or (${table.targetNoteId} is not null and ${table.baseRevision} is not null and ${table.baseRevision} > 0)`,
    ),
    check(
      "imports_source_object_key_check",
      sql`${table.sourceObjectKey} = 'workspace/' || ${table.workspaceId}::text || '/imports/' || ${table.id}::text || '/source'`,
    ),
    check("imports_request_hash_check", sql`${table.requestHash} ~ '^[0-9a-f]{64}$'`),
    check("imports_idempotency_key_check", sql`char_length(${table.idempotencyKey}) > 0`),
    check(
      "imports_manifest_check",
      sql`jsonb_typeof(${table.manifest}) = 'object' and octet_length(${table.manifest}::text) <= 1048576`,
    ),
    check("imports_expiry_check", sql`${table.expiresAt} > ${table.createdAt}`),
  ],
);

export const importsRelations = relations(imports, ({ one }) => ({
  workspace: one(workspaces, {
    fields: [imports.workspaceId],
    references: [workspaces.id],
  }),
  actor: one(user, {
    fields: [imports.actorId],
    references: [user.id],
  }),
  targetNote: one(notes, {
    fields: [imports.targetNoteId, imports.workspaceId],
    references: [notes.id, notes.workspaceId],
  }),
}));
