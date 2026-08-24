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
import { user } from "./auth.js";
import { notes } from "./notes.js";
import { workspaces } from "./workspaces.js";

export type SnapshotReason = "autosave" | "checkpoint" | "restore" | "migration" | "import";

export const noteVersions = pgTable(
  "note_versions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    noteId: uuid("note_id").notNull(),
    revision: integer("revision").notNull(),
    schemaVersion: integer("schema_version").notNull(),
    contentMarkdown: text("content_markdown").notNull(),
    contentHash: text("content_hash").notNull(),
    reason: text("reason").$type<SnapshotReason>().notNull(),
    createdById: text("created_by_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    foreignKey({
      name: "note_versions_note_workspace_fk",
      columns: [table.noteId, table.workspaceId],
      foreignColumns: [notes.id, notes.workspaceId],
    }).onDelete("cascade"),
    uniqueIndex("note_versions_note_revision_unique").on(table.noteId, table.revision),
    index("note_versions_workspace_note_revision_idx").on(
      table.workspaceId,
      table.noteId,
      table.revision,
    ),
    check("note_versions_revision_positive_check", sql`${table.revision} > 0`),
    check("note_versions_schema_version_positive_check", sql`${table.schemaVersion} > 0`),
    check(
      "note_versions_reason_check",
      sql`${table.reason} in ('autosave', 'checkpoint', 'restore', 'migration', 'import')`,
    ),
    check(
      "note_versions_markdown_size_check",
      sql`octet_length(${table.contentMarkdown}) <= 2097152`,
    ),
  ],
);

export const noteVersionsRelations = relations(noteVersions, ({ one }) => ({
  workspace: one(workspaces, {
    fields: [noteVersions.workspaceId],
    references: [workspaces.id],
  }),
  note: one(notes, {
    fields: [noteVersions.noteId],
    references: [notes.id],
  }),
  createdBy: one(user, {
    fields: [noteVersions.createdById],
    references: [user.id],
  }),
}));
