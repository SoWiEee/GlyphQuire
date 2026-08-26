import { relations, sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  jsonb,
  pgTable,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { workspaces } from "./workspaces.js";

export type JobStatus = "pending" | "processing" | "completed" | "dead_letter";

export const jobs = pgTable(
  "jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").references(() => workspaces.id, { onDelete: "set null" }),
    type: varchar("type", { length: 80 }).notNull(),
    version: integer("version").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    status: varchar("status", { length: 16 }).$type<JobStatus>().notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(5),
    availableAt: timestamp("available_at", { withTimezone: true }).notNull().defaultNow(),
    lockedAt: timestamp("locked_at", { withTimezone: true }),
    lockedBy: varchar("locked_by", { length: 200 }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    deadLetteredAt: timestamp("dead_lettered_at", { withTimezone: true }),
    idempotencyKey: varchar("idempotency_key", { length: 200 }),
    lastError: varchar("last_error", { length: 4000 }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("jobs_idempotency_scope_idx")
      .on(
        sql`coalesce(${table.workspaceId}, '00000000-0000-0000-0000-000000000000'::uuid)`,
        table.type,
        table.idempotencyKey,
      )
      .where(sql`${table.idempotencyKey} is not null`),
    index("jobs_pending_due_idx")
      .on(table.status, table.availableAt, table.createdAt, table.id)
      .where(sql`${table.status} = 'pending'`),
    index("jobs_processing_lock_idx")
      .on(table.status, table.lockedAt)
      .where(sql`${table.status} = 'processing'`),
    check("jobs_version_positive_check", sql`${table.version} > 0`),
    check(
      "jobs_status_check",
      sql`${table.status} in ('pending', 'processing', 'completed', 'dead_letter')`,
    ),
    check("jobs_attempts_nonnegative_check", sql`${table.attempts} >= 0`),
    check("jobs_max_attempts_check", sql`${table.maxAttempts} between 1 and 20`),
    check("jobs_payload_object_check", sql`jsonb_typeof(${table.payload}) = 'object'`),
    check(
      "jobs_scope_check",
      sql`${table.workspaceId} is not null or ${table.type} in ('workspace.purge', 'account.purge', 'backup.verify')`,
    ),
    check(
      "jobs_state_shape_check",
      sql`(
          ${table.status} = 'pending'
          and ${table.lockedAt} is null
          and ${table.lockedBy} is null
          and ${table.completedAt} is null
          and ${table.deadLetteredAt} is null
        ) or (
          ${table.status} = 'processing'
          and ${table.attempts} > 0
          and ${table.lockedAt} is not null
          and ${table.lockedBy} is not null
          and ${table.completedAt} is null
          and ${table.deadLetteredAt} is null
        ) or (
          ${table.status} = 'completed'
          and ${table.attempts} > 0
          and ${table.lockedAt} is null
          and ${table.lockedBy} is null
          and ${table.completedAt} is not null
          and ${table.deadLetteredAt} is null
        ) or (
          ${table.status} = 'dead_letter'
          and ${table.attempts} > 0
          and ${table.lockedAt} is null
          and ${table.lockedBy} is null
          and ${table.completedAt} is null
          and ${table.deadLetteredAt} is not null
        )`,
    ),
  ],
);

export const jobsRelations = relations(jobs, ({ one }) => ({
  workspace: one(workspaces, {
    fields: [jobs.workspaceId],
    references: [workspaces.id],
  }),
}));
