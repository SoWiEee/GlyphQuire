import { relations, sql } from "drizzle-orm";
import {
  boolean,
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

export const themes = pgTable(
  "themes",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id").references(() => workspaces.id, { onDelete: "cascade" }),
    name: varchar("name", { length: 200 }).notNull(),
    version: varchar("version", { length: 50 }).notNull(),
    tokens: jsonb("tokens").default({}).notNull(),
    darkTokens: jsonb("dark_tokens"),
    components: jsonb("components"),
    isSystem: boolean("is_system").default(false).notNull(),
    revision: integer("revision").default(1).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [
    uniqueIndex("themes_workspace_name_unique")
      .on(table.workspaceId, table.name)
      .where(sql`${table.workspaceId} IS NOT NULL`),
    index("themes_workspace_id_idx").on(table.workspaceId),
    check("themes_revision_positive_check", sql`${table.revision} > 0`),
    check(
      "themes_system_workspace_null_check",
      sql`(${table.isSystem} = true AND ${table.workspaceId} IS NULL) OR (${table.isSystem} = false AND ${table.workspaceId} IS NOT NULL)`,
    ),
    check("themes_name_length_check", sql`char_length(${table.name}) between 1 and 200`),
  ],
);

export const themesRelations = relations(themes, ({ one }) => ({
  workspace: one(workspaces, {
    fields: [themes.workspaceId],
    references: [workspaces.id],
  }),
}));

export const userThemes = pgTable(
  "user_themes",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    themeId: uuid("theme_id")
      .notNull()
      .references(() => themes.id, { onDelete: "cascade" }),
    customOverrides: jsonb("custom_overrides"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [uniqueIndex("user_themes_user_workspace_unique").on(table.userId, table.workspaceId)],
);

export const userThemesRelations = relations(userThemes, ({ one }) => ({
  user: one(user, { fields: [userThemes.userId], references: [user.id] }),
  workspace: one(workspaces, { fields: [userThemes.workspaceId], references: [workspaces.id] }),
  theme: one(themes, { fields: [userThemes.themeId], references: [themes.id] }),
}));
