import { relations, sql } from "drizzle-orm";
import {
  check,
  char,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { user } from "./auth.js";
import { workspaces } from "./workspaces.js";

export const idempotencyRecords = pgTable(
  "idempotency_records",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    actorId: text("actor_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    operation: varchar("operation", { length: 80 }).notNull(),
    idempotencyKey: varchar("idempotency_key", { length: 200 }).notNull(),
    requestHash: char("request_hash", { length: 64 }).notNull(),
    responseCiphertext: text("response_ciphertext"),
    ownerTokenHash: char("owner_token_hash", { length: 64 }),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("idempotency_records_scope_unique").on(
      table.workspaceId,
      table.actorId,
      table.operation,
      table.idempotencyKey,
    ),
    check("idempotency_records_request_hash_check", sql`${table.requestHash} ~ '^[0-9a-f]{64}$'`),
    check(
      "idempotency_records_owner_hash_check",
      sql`${table.ownerTokenHash} is null or ${table.ownerTokenHash} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      "idempotency_records_state_shape_check",
      sql`(
          ${table.responseCiphertext} is null
          and ${table.completedAt} is null
          and ${table.ownerTokenHash} is not null
          and ${table.leaseExpiresAt} is not null
        ) or (
          ${table.responseCiphertext} is not null
          and ${table.completedAt} is not null
          and ${table.ownerTokenHash} is null
          and ${table.leaseExpiresAt} is null
        )`,
    ),
  ],
);

export const idempotencyRecordsRelations = relations(idempotencyRecords, ({ one }) => ({
  workspace: one(workspaces, {
    fields: [idempotencyRecords.workspaceId],
    references: [workspaces.id],
  }),
  actor: one(user, {
    fields: [idempotencyRecords.actorId],
    references: [user.id],
  }),
}));
