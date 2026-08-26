import { relations, sql } from "drizzle-orm";
import {
  char,
  check,
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

export type AssetThumbnailStatus = "pending" | "ready" | "metadata_only" | "failed";

export const assets = pgTable(
  "assets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    ownerId: text("owner_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    objectKey: varchar("object_key", { length: 500 }).notNull(),
    originalName: varchar("original_name", { length: 255 }).notNull(),
    mimeType: varchar("mime_type", { length: 200 }).notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    sha256: char("sha256", { length: 64 }).notNull(),
    thumbnailStatus: varchar("thumbnail_status", { length: 20 })
      .$type<AssetThumbnailStatus>()
      .notNull()
      .default("pending"),
    thumbnailObjectKey: varchar("thumbnail_object_key", { length: 500 }),
    thumbnailMimeType: varchar("thumbnail_mime_type", { length: 200 }),
    thumbnailWidth: integer("thumbnail_width"),
    thumbnailHeight: integer("thumbnail_height"),
    thumbnailBytes: integer("thumbnail_bytes"),
    metadataJson: jsonb("metadata_json").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("assets_workspace_object_key_unique").on(table.workspaceId, table.objectKey),
    check("assets_size_bytes_positive_check", sql`${table.sizeBytes} > 0`),
    check("assets_sha256_check", sql`${table.sha256} ~ '^[0-9a-f]{64}$'`),
    check(
      "assets_thumbnail_status_check",
      sql`${table.thumbnailStatus} in ('pending', 'ready', 'metadata_only', 'failed')`,
    ),
    check(
      "assets_thumbnail_shape_check",
      sql`(
          ${table.thumbnailStatus} in ('pending', 'metadata_only', 'failed')
          and ${table.thumbnailObjectKey} is null
          and ${table.thumbnailMimeType} is null
          and ${table.thumbnailWidth} is null
          and ${table.thumbnailHeight} is null
          and ${table.thumbnailBytes} is null
        ) or (
          ${table.thumbnailStatus} = 'ready'
          and ${table.thumbnailObjectKey} is not null
          and ${table.thumbnailMimeType} is not null
          and ${table.thumbnailWidth} is not null
          and ${table.thumbnailHeight} is not null
          and ${table.thumbnailBytes} is not null
        )`,
    ),
  ],
);

export const assetsRelations = relations(assets, ({ one }) => ({
  workspace: one(workspaces, {
    fields: [assets.workspaceId],
    references: [workspaces.id],
  }),
  owner: one(user, {
    fields: [assets.ownerId],
    references: [user.id],
  }),
}));
