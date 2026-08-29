import { sql } from "drizzle-orm";
import { check, index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid, varchar } from "drizzle-orm/pg-core";

export type AccountDeletionStatus = "pending" | "processing" | "completed" | "failed";
export type AccountDeletionManifest = Record<string, unknown>;

export const accountDeletions = pgTable(
  "account_deletions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: text("account_id").notNull(),
    confirmedAt: timestamp("confirmed_at", { withTimezone: true }).notNull(),
    executeAfter: timestamp("execute_after", { withTimezone: true }).notNull(),
    status: varchar("status", { length: 16 })
      .$type<AccountDeletionStatus>()
      .notNull()
      .default("pending"),
    workspaceIds: jsonb("workspace_ids").$type<string[]>().notNull().default([]),
    idempotencyKey: varchar("idempotency_key", { length: 200 }).notNull(),
    manifest: jsonb("manifest").$type<AccountDeletionManifest>().notNull().default({}),
    sanitizedError: varchar("sanitized_error", { length: 4000 }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    uniqueIndex("account_deletions_idempotency_unique").on(table.accountId, table.idempotencyKey),
    uniqueIndex("account_deletions_active_account_unique")
      .on(table.accountId)
      .where(sql`${table.status} in ('pending', 'processing', 'failed')`),
    index("account_deletions_due_idx").on(table.status, table.executeAfter, table.createdAt, table.id),
    check(
      "account_deletions_status_check",
      sql`${table.status} in ('pending', 'processing', 'completed', 'failed')`,
    ),
    check(
      "account_deletions_workspace_ids_check",
      sql`jsonb_typeof(${table.workspaceIds}) = 'array' and octet_length(${table.workspaceIds}::text) <= 65536`,
    ),
    check("account_deletions_manifest_check", sql`jsonb_typeof(${table.manifest}) = 'object' and octet_length(${table.manifest}::text) <= 1048576`),
    check("account_deletions_idempotency_key_check", sql`char_length(${table.idempotencyKey}) > 0`),
    check("account_deletions_execute_after_check", sql`${table.executeAfter} >= ${table.confirmedAt}`),
  ],
);
