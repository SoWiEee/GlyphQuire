import { relations, sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  pgTable,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { imports } from "./imports.js";

export type ImportResourceState = "declared" | "uploaded" | "promoted" | "cleaned";

export const importResources = pgTable(
  "import_resources",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    importId: uuid("import_id").notNull(),
    workspaceId: uuid("workspace_id").notNull(),
    assetId: uuid("asset_id"),
    objectKey: varchar("object_key", { length: 500 }).notNull(),
    state: varchar("state", { length: 16 })
      .$type<ImportResourceState>()
      .notNull()
      .default("declared"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    foreignKey({
      name: "import_resources_import_workspace_fk",
      columns: [table.importId, table.workspaceId],
      foreignColumns: [imports.id, imports.workspaceId],
    }).onDelete("cascade"),
    uniqueIndex("import_resources_object_key_unique").on(table.objectKey),
    index("import_resources_import_state_idx").on(
      table.importId,
      table.workspaceId,
      table.state,
      table.createdAt,
      table.id,
    ),
    check(
      "import_resources_state_check",
      sql`${table.state} in ('declared', 'uploaded', 'promoted', 'cleaned')`,
    ),
    check(
      "import_resources_object_key_check",
      sql`${table.objectKey} = 'workspace/' || ${table.workspaceId}::text || '/imports/' || ${table.importId}::text || '/resources/' || ${table.id}::text`,
    ),
    check(
      "import_resources_promoted_asset_check",
      sql`${table.state} <> 'promoted' or ${table.assetId} is not null`,
    ),
  ],
);

export const importResourcesRelations = relations(importResources, ({ one }) => ({
  import: one(imports, {
    fields: [importResources.importId, importResources.workspaceId],
    references: [imports.id, imports.workspaceId],
  }),
}));
