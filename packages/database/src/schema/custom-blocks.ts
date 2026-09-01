import { relations, sql } from "drizzle-orm";
import {
  check,
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
import { workspaces } from "./workspaces.js";

export type CustomBlockVersionStatus = "draft" | "published";
export type CustomBlockVersionOperationKind = "create" | "update-draft" | "publish";
export type CustomBlockOperationKind = CustomBlockVersionOperationKind | "delete-draft";

export const customBlocks = pgTable(
  "custom_blocks",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    name: varchar("name", { length: 64 }).notNull(),
    revision: integer("revision").default(1).notNull(),
    createdBy: text("created_by")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [
    uniqueIndex("custom_blocks_workspace_name_unique").on(table.workspaceId, table.name),
    index("custom_blocks_workspace_idx").on(table.workspaceId),
    check("custom_blocks_name_check", sql`${table.name} ~ '^[a-z][a-z0-9-]{0,63}$'`),
    check("custom_blocks_revision_positive_check", sql`${table.revision} > 0`),
  ],
);

export const customBlockVersions = pgTable(
  "custom_block_versions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    customBlockId: uuid("custom_block_id")
      .notNull()
      .references(() => customBlocks.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    status: varchar("status", { length: 9 }).$type<CustomBlockVersionStatus>().notNull(),
    definition: jsonb("definition").notNull(),
    createdBy: text("created_by")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    operationId: text("operation_id").notNull(),
    operationKind: varchar("operation_kind", { length: 12 })
      .$type<CustomBlockVersionOperationKind>()
      .notNull(),
    publishedAt: timestamp("published_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("custom_block_versions_block_version_unique").on(
      table.customBlockId,
      table.version,
    ),
    index("custom_block_versions_block_status_idx").on(table.customBlockId, table.status),
    check("custom_block_versions_version_positive_check", sql`${table.version} > 0`),
    check("custom_block_versions_status_check", sql`${table.status} in ('draft', 'published')`),
    check(
      "custom_block_versions_operation_kind_check",
      sql`${table.operationKind} in ('create', 'update-draft', 'publish')`,
    ),
    check(
      "custom_block_versions_published_at_check",
      sql`(${table.status} = 'published' and ${table.publishedAt} is not null) or (${table.status} = 'draft' and ${table.publishedAt} is null)`,
    ),
  ],
);

export const customBlocksRelations = relations(customBlocks, ({ one, many }) => ({
  workspace: one(workspaces, { fields: [customBlocks.workspaceId], references: [workspaces.id] }),
  creator: one(user, { fields: [customBlocks.createdBy], references: [user.id] }),
  versions: many(customBlockVersions),
}));

export const customBlockVersionsRelations = relations(customBlockVersions, ({ one }) => ({
  block: one(customBlocks, {
    fields: [customBlockVersions.customBlockId],
    references: [customBlocks.id],
  }),
  creator: one(user, { fields: [customBlockVersions.createdBy], references: [user.id] }),
}));
