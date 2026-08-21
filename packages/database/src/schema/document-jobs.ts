import { relations, sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { noteOperations } from "./note-operations.js";
import { notes } from "./notes.js";
import { workspaces } from "./workspaces.js";

export type DocumentJobKind = "upsert" | "delete";
export type DocumentJobStatus = "pending" | "processing" | "completed" | "dead_letter";

export const documentJobs = pgTable(
  "document_jobs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    noteId: uuid("note_id").notNull(),
    noteOperationId: uuid("note_operation_id").notNull(),
    operationId: uuid("operation_id").notNull(),
    revision: integer("revision").notNull(),
    kind: text("kind").$type<DocumentJobKind>().notNull(),
    status: text("status").$type<DocumentJobStatus>().default("pending").notNull(),
    attempts: integer("attempts").default(0).notNull(),
    availableAt: timestamp("available_at").defaultNow().notNull(),
    lockedAt: timestamp("locked_at"),
    lockedBy: text("locked_by"),
    completedAt: timestamp("completed_at"),
    deadLetteredAt: timestamp("dead_lettered_at"),
    lastError: text("last_error"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [
    foreignKey({
      name: "document_jobs_note_workspace_fk",
      columns: [table.noteId, table.workspaceId],
      foreignColumns: [notes.id, notes.workspaceId],
    }).onDelete("cascade"),
    foreignKey({
      name: "document_jobs_operation_identity_fk",
      columns: [table.noteOperationId, table.workspaceId, table.noteId, table.operationId],
      foreignColumns: [
        noteOperations.id,
        noteOperations.workspaceId,
        noteOperations.noteId,
        noteOperations.operationId,
      ],
    }).onDelete("cascade"),
    uniqueIndex("document_jobs_identity_unique").on(
      table.noteId,
      table.revision,
      table.operationId,
    ),
    index("document_jobs_workspace_note_revision_idx").on(
      table.workspaceId,
      table.noteId,
      table.revision,
    ),
    index("document_jobs_pending_due_idx")
      .on(table.status, table.availableAt, table.createdAt, table.id)
      .where(sql`${table.status} = 'pending'`),
    index("document_jobs_processing_lock_idx")
      .on(table.status, table.lockedAt)
      .where(sql`${table.status} = 'processing'`),
    check("document_jobs_revision_positive_check", sql`${table.revision} > 0`),
    check("document_jobs_kind_check", sql`${table.kind} in ('upsert', 'delete')`),
    check(
      "document_jobs_status_check",
      sql`${table.status} in ('pending', 'processing', 'completed', 'dead_letter')`,
    ),
    check("document_jobs_attempts_nonnegative_check", sql`${table.attempts} >= 0`),
    check(
      "document_jobs_state_shape_check",
      sql`(
          ${table.status} = 'pending'
          and ${table.lockedAt} is null
          and ${table.lockedBy} is null
          and ${table.completedAt} is null
          and ${table.deadLetteredAt} is null
        ) or (
          ${table.status} = 'processing'
          and ${table.attempts} > 0
          and ${table.lockedAt} is not null
          and ${table.lockedBy} is not null
          and ${table.completedAt} is null
          and ${table.deadLetteredAt} is null
        ) or (
          ${table.status} = 'completed'
          and ${table.attempts} > 0
          and ${table.lockedAt} is null
          and ${table.lockedBy} is null
          and ${table.completedAt} is not null
          and ${table.deadLetteredAt} is null
        ) or (
          ${table.status} = 'dead_letter'
          and ${table.attempts} > 0
          and ${table.lockedAt} is null
          and ${table.lockedBy} is null
          and ${table.completedAt} is null
          and ${table.deadLetteredAt} is not null
        )`,
    ),
  ],
);

export const documentJobsRelations = relations(documentJobs, ({ one }) => ({
  workspace: one(workspaces, {
    fields: [documentJobs.workspaceId],
    references: [workspaces.id],
  }),
  note: one(notes, {
    fields: [documentJobs.noteId],
    references: [notes.id],
  }),
  operation: one(noteOperations, {
    fields: [documentJobs.noteOperationId],
    references: [noteOperations.id],
  }),
}));
