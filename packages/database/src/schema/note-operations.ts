import { relations, sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { user } from "./auth.js";
import { notes } from "./notes.js";
import { workspaces } from "./workspaces.js";

export type NoteOperationKind =
  | "create"
  | "rename"
  | "save"
  | "delete"
  | "restore"
  | "checkpoint"
  | "restore_version";

export const noteOperations = pgTable(
  "note_operations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    noteId: uuid("note_id").notNull(),
    actorId: text("actor_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    operationId: uuid("operation_id").notNull(),
    operationKind: text("operation_kind").$type<NoteOperationKind>().notNull(),
    baseRevision: integer("base_revision"),
    requestHash: text("request_hash").notNull(),
    recordedResponse: jsonb("recorded_response").$type<Record<string, unknown>>().notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    foreignKey({
      name: "note_operations_note_workspace_fk",
      columns: [table.noteId, table.workspaceId],
      foreignColumns: [notes.id, notes.workspaceId],
    }).onDelete("cascade"),
    uniqueIndex("note_operations_create_scope_unique")
      .on(table.actorId, table.workspaceId, table.operationKind, table.operationId)
      .where(sql`${table.operationKind} = 'create'`),
    uniqueIndex("note_operations_existing_scope_unique")
      .on(table.actorId, table.workspaceId, table.noteId, table.operationKind, table.operationId)
      .where(sql`${table.operationKind} <> 'create'`),
    uniqueIndex("note_operations_job_reference_unique").on(
      table.id,
      table.workspaceId,
      table.noteId,
      table.operationId,
    ),
    check(
      "note_operations_kind_check",
      sql`${table.operationKind} in ('create', 'rename', 'save', 'delete', 'restore', 'checkpoint', 'restore_version')`,
    ),
    check(
      "note_operations_base_revision_check",
      sql`(${table.operationKind} = 'create' and ${table.baseRevision} is null)
        or (${table.operationKind} <> 'create' and ${table.baseRevision} > 0)`,
    ),
    check("note_operations_request_hash_check", sql`char_length(${table.requestHash}) > 0`),
  ],
);

export const noteOperationsRelations = relations(noteOperations, ({ one }) => ({
  workspace: one(workspaces, {
    fields: [noteOperations.workspaceId],
    references: [workspaces.id],
  }),
  note: one(notes, {
    fields: [noteOperations.noteId],
    references: [notes.id],
  }),
  actor: one(user, {
    fields: [noteOperations.actorId],
    references: [user.id],
  }),
}));
