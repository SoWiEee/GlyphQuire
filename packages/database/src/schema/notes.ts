import { relations, sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { user } from "./auth.js";
import { workspaces } from "./workspaces.js";

export type NoteVisibility = "private";

export const notes = pgTable(
  "notes",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    contentMarkdown: text("content_markdown").notNull(),
    revision: integer("revision").default(1).notNull(),
    contentHash: text("content_hash").notNull(),
    ownerId: text("owner_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    schemaVersion: integer("schema_version").default(1).notNull(),
    visibility: text("visibility").$type<NoteVisibility>().default("private").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
    deletedAt: timestamp("deleted_at"),
  },
  (table) => [
    uniqueIndex("notes_id_workspace_id_unique").on(table.id, table.workspaceId),
    index("notes_workspace_deleted_updated_id_idx").on(
      table.workspaceId,
      table.deletedAt,
      table.updatedAt,
      table.id,
    ),
    index("notes_workspace_id_revision_visibility_deleted_idx").on(
      table.workspaceId,
      table.id,
      table.revision,
      table.visibility,
      table.deletedAt,
    ),
    check("notes_visibility_private_check", sql`${table.visibility} = 'private'`),
    check("notes_revision_positive_check", sql`${table.revision} > 0`),
    check("notes_schema_version_positive_check", sql`${table.schemaVersion} > 0`),
    check("notes_title_length_check", sql`char_length(${table.title}) between 1 and 200`),
    check("notes_markdown_size_check", sql`octet_length(${table.contentMarkdown}) <= 2097152`),
  ],
);

export const notesRelations = relations(notes, ({ one }) => ({
  workspace: one(workspaces, {
    fields: [notes.workspaceId],
    references: [workspaces.id],
  }),
  owner: one(user, {
    fields: [notes.ownerId],
    references: [user.id],
  }),
}));
