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
import { notes } from "./notes.js";
import { workspaceMembers, workspaces } from "./workspaces.js";

export type ShareLinkScopeType = "note";

export const shareLinks = pgTable(
  "share_links",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    noteId: uuid("note_id").notNull(),
    creatorId: text("creator_id").notNull(),
    scopeType: varchar("scope_type", { length: 16 })
      .$type<ShareLinkScopeType>()
      .notNull()
      .default("note"),
    tokenHash: char("token_hash", { length: 64 }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    foreignKey({
      name: "share_links_note_workspace_fk",
      columns: [table.noteId, table.workspaceId],
      foreignColumns: [notes.id, notes.workspaceId],
    }).onDelete("cascade"),
    foreignKey({
      name: "share_links_creator_membership_fk",
      columns: [table.workspaceId, table.creatorId],
      foreignColumns: [workspaceMembers.workspaceId, workspaceMembers.userId],
    }).onDelete("cascade"),
    uniqueIndex("share_links_token_hash_unique").on(table.tokenHash),
    index("share_links_expiry_cleanup_idx").on(
      table.workspaceId,
      table.expiresAt,
      table.createdAt,
      table.id,
    ),
    index("share_links_revocation_cleanup_idx").on(
      table.workspaceId,
      table.revokedAt,
      table.createdAt,
      table.id,
    ),
    check("share_links_scope_check", sql`${table.scopeType} = 'note'`),
    check("share_links_token_hash_check", sql`${table.tokenHash} ~ '^[0-9a-f]{64}$'`),
    check(
      "share_links_expiry_check",
      sql`${table.expiresAt} is null or ${table.expiresAt} > ${table.createdAt}`,
    ),
    check(
      "share_links_revocation_check",
      sql`${table.revokedAt} is null or ${table.revokedAt} >= ${table.createdAt}`,
    ),
  ],
);

export const shareLinksRelations = relations(shareLinks, ({ one }) => ({
  workspace: one(workspaces, {
    fields: [shareLinks.workspaceId],
    references: [workspaces.id],
  }),
  note: one(notes, {
    fields: [shareLinks.noteId, shareLinks.workspaceId],
    references: [notes.id, notes.workspaceId],
  }),
  creatorMembership: one(workspaceMembers, {
    fields: [shareLinks.workspaceId, shareLinks.creatorId],
    references: [workspaceMembers.workspaceId, workspaceMembers.userId],
  }),
}));
