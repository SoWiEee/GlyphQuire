import { relations, sql } from "drizzle-orm";
import {
  check,
  index,
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

export type WorkspaceDeletionStatus = "pending" | "processing" | "completed" | "failed";
export type WorkspaceDeletionManifest = Record<string, unknown>;

export const workspaceDeletions = pgTable(
  "workspace_deletions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").references(() => workspaces.id, {
      onDelete: "set null",
    }),
    requestedBy: text("requested_by").references(() => user.id, { onDelete: "set null" }),
    confirmedAt: timestamp("confirmed_at", { withTimezone: true }).notNull(),
    executeAfter: timestamp("execute_after", { withTimezone: true }).notNull(),
    status: varchar("status", { length: 16 })
      .$type<WorkspaceDeletionStatus>()
      .notNull()
      .default("pending"),
    idempotencyKey: varchar("idempotency_key", { length: 200 }).notNull(),
    manifest: jsonb("manifest").$type<WorkspaceDeletionManifest>().notNull().default({}),
    sanitizedError: varchar("sanitized_error", { length: 4000 }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    uniqueIndex("workspace_deletions_idempotency_unique").on(
      table.workspaceId,
      table.idempotencyKey,
    ),
    uniqueIndex("workspace_deletions_active_workspace_unique")
      .on(table.workspaceId)
      .where(
        sql`${table.workspaceId} is not null and ${table.status} in ('pending', 'processing', 'failed')`,
      ),
    index("workspace_deletions_due_idx").on(
      table.status,
      table.executeAfter,
      table.createdAt,
      table.id,
    ),
    check(
      "workspace_deletions_status_check",
      sql`${table.status} in ('pending', 'processing', 'completed', 'failed')`,
    ),
    check(
      "workspace_deletions_manifest_check",
      sql`jsonb_typeof(${table.manifest}) = 'object' and octet_length(${table.manifest}::text) <= 1048576`,
    ),
    check("workspace_deletions_idempotency_key_check", sql`char_length(${table.idempotencyKey}) > 0`),
    check("workspace_deletions_execute_after_check", sql`${table.executeAfter} >= ${table.confirmedAt}`),
  ],
);

export const workspaceDeletionsRelations = relations(workspaceDeletions, ({ one }) => ({
  workspace: one(workspaces, {
    fields: [workspaceDeletions.workspaceId],
    references: [workspaces.id],
  }),
  requester: one(user, {
    fields: [workspaceDeletions.requestedBy],
    references: [user.id],
  }),
}));
