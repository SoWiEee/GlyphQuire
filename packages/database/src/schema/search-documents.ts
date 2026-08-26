import { relations, sql } from "drizzle-orm";
import {
  check,
  customType,
  foreignKey,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { notes } from "./notes.js";
import { workspaces } from "./workspaces.js";

export const MAX_SEARCH_TEXT_BYTES = 2 * 1024 * 1024;

const tsvector = customType<{ data: string }>({
  dataType() {
    return "tsvector";
  },
});

export const searchDocuments = pgTable(
  "search_documents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    noteId: uuid("note_id").notNull(),
    revision: integer("revision").notNull(),
    title: text("title").notNull(),
    headings: text("headings").notNull().default(""),
    body: text("body").notNull().default(""),
    tags: text("tags").notNull().default(""),
    normalizedText: text("normalized_text").notNull().default(""),
    searchVector: tsvector("search_vector").generatedAlwaysAs(
      sql`to_tsvector('english', coalesce(title, '') || ' ' || coalesce(headings, '') || ' ' || coalesce(body, ''))`,
    ),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    foreignKey({
      name: "search_documents_note_workspace_fk",
      columns: [table.noteId, table.workspaceId],
      foreignColumns: [notes.id, notes.workspaceId],
    }).onDelete("cascade"),
    uniqueIndex("search_documents_note_id_unique").on(table.noteId),
    index("search_documents_workspace_updated_id_idx").on(
      table.workspaceId,
      table.updatedAt,
      table.noteId,
    ),
    check("search_documents_revision_positive_check", sql`${table.revision} > 0`),
    check(
      "search_documents_title_size_check",
      sql`octet_length(${table.title}) <= 2097152`,
    ),
    check(
      "search_documents_headings_size_check",
      sql`octet_length(${table.headings}) <= 2097152`,
    ),
    check(
      "search_documents_body_size_check",
      sql`octet_length(${table.body}) <= 2097152`,
    ),
    check(
      "search_documents_normalized_text_size_check",
      sql`octet_length(${table.normalizedText}) <= 2097152`,
    ),
  ],
);

export const searchDocumentsRelations = relations(searchDocuments, ({ one }) => ({
  workspace: one(workspaces, {
    fields: [searchDocuments.workspaceId],
    references: [workspaces.id],
  }),
  note: one(notes, {
    fields: [searchDocuments.noteId],
    references: [notes.id],
  }),
}));
