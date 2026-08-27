import { relations, sql } from "drizzle-orm";
import {
  char,
  check,
  foreignKey,
  index,
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

export type ExportScopeType = "workspace" | "note";
export type ExportFormat = "markdown" | "zip" | "html";
export type ExportStatus = "pending" | "processing" | "completed" | "failed" | "expired";

export const exports = pgTable(
  "exports",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    requesterId: text("requester_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    scopeType: varchar("scope_type", { length: 16 }).$type<ExportScopeType>().notNull(),
    noteId: uuid("note_id"),
    format: varchar("format", { length: 16 }).$type<ExportFormat>().notNull(),
    status: varchar("status", { length: 16 }).$type<ExportStatus>().notNull().default("pending"),
    idempotencyKey: varchar("idempotency_key", { length: 200 }).notNull(),
    requestHash: char("request_hash", { length: 64 }).notNull(),
    objectKey: varchar("object_key", { length: 500 }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    lastError: varchar("last_error", { length: 4000 }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    foreignKey({
      name: "exports_note_workspace_fk",
      columns: [table.noteId, table.workspaceId],
      foreignColumns: [notes.id, notes.workspaceId],
    }),
    uniqueIndex("exports_idempotency_scope_unique").on(
      table.workspaceId,
      table.requesterId,
      table.idempotencyKey,
    ),
    index("exports_expiry_status_idx").on(table.status, table.expiresAt, table.createdAt, table.id),
    check("exports_scope_type_check", sql`${table.scopeType} in ('workspace', 'note')`),
    check("exports_format_check", sql`${table.format} in ('markdown', 'zip', 'html')`),
    check(
      "exports_status_check",
      sql`${table.status} in ('pending', 'processing', 'completed', 'failed', 'expired')`,
    ),
    check(
      "exports_scope_shape_check",
      sql`(${table.scopeType} = 'workspace' and ${table.noteId} is null)
        or (${table.scopeType} = 'note' and ${table.noteId} is not null)`,
    ),
    check(
      "exports_object_key_check",
      sql`${table.objectKey} is null
        or ${table.objectKey} = 'workspace/' || ${table.workspaceId}::text || '/exports/' || ${table.id}::text || '/artifact'`,
    ),
    check("exports_request_hash_check", sql`${table.requestHash} ~ '^[0-9a-f]{64}$'`),
    check("exports_idempotency_key_check", sql`char_length(${table.idempotencyKey}) > 0`),
    check("exports_expiry_check", sql`${table.expiresAt} > ${table.createdAt}`),
  ],
);

export const exportsRelations = relations(exports, ({ one }) => ({
  workspace: one(workspaces, {
    fields: [exports.workspaceId],
    references: [workspaces.id],
  }),
  requester: one(user, {
    fields: [exports.requesterId],
    references: [user.id],
  }),
  note: one(notes, {
    fields: [exports.noteId, exports.workspaceId],
    references: [notes.id, notes.workspaceId],
  }),
}));
