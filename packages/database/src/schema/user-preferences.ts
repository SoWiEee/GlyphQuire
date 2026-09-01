import { relations, sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { user } from "./auth.js";
import { themes } from "./themes.js";

export type ThemePreferenceMode = "light" | "dark";

export const userPreferences = pgTable(
  "user_preferences",
  {
    userId: text("user_id")
      .primaryKey()
      .references(() => user.id, { onDelete: "cascade" }),
    themeId: uuid("theme_id").references(() => themes.id, { onDelete: "set null" }),
    mode: varchar("mode", { length: 5 }).$type<ThemePreferenceMode>().default("light").notNull(),
    customOverrides: jsonb("custom_overrides")
      .$type<Record<string, unknown>>()
      .default({})
      .notNull(),
    variantOverrides: jsonb("variant_overrides")
      .$type<Record<string, unknown>>()
      .default({})
      .notNull(),
    revision: integer("revision").default(1).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [
    index("user_preferences_theme_id_idx").on(table.themeId),
    check("user_preferences_mode_check", sql`${table.mode} in ('light', 'dark')`),
    check("user_preferences_revision_positive_check", sql`${table.revision} > 0`),
    check(
      "user_preferences_custom_overrides_object_check",
      sql`jsonb_typeof(${table.customOverrides}) = 'object'`,
    ),
    check(
      "user_preferences_variant_overrides_object_check",
      sql`jsonb_typeof(${table.variantOverrides}) = 'object'`,
    ),
  ],
);

export const userPreferencesRelations = relations(userPreferences, ({ one }) => ({
  user: one(user, { fields: [userPreferences.userId], references: [user.id] }),
  theme: one(themes, { fields: [userPreferences.themeId], references: [themes.id] }),
}));
