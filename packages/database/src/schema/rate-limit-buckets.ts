import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

export const rateLimitBuckets = pgTable(
  "rate_limit_buckets",
  {
    bucketKey: text("bucket_key").primaryKey(),
    windowStartedAt: timestamp("window_started_at", { mode: "date", withTimezone: true }).notNull(),
    requestCount: integer("request_count").notNull(),
    updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true }).notNull(),
  },
  (table) => [
    index("rate_limit_buckets_window_started_at_idx").on(table.windowStartedAt),
    check(
      "rate_limit_buckets_key_size_check",
      sql`octet_length(${table.bucketKey}) between 1 and 255`,
    ),
    check("rate_limit_buckets_request_count_nonnegative_check", sql`${table.requestCount} >= 0`),
  ],
);

export const rateLimitReservations = pgTable(
  "rate_limit_reservations",
  {
    reservationId: uuid("reservation_id").primaryKey(),
    bucketKey: text("bucket_key").notNull(),
    windowStartedAt: timestamp("window_started_at", {
      mode: "date",
      withTimezone: true,
    }).notNull(),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).notNull(),
    releasedAt: timestamp("released_at", { mode: "date", withTimezone: true }),
  },
  (table) => [
    foreignKey({
      name: "rate_limit_reservations_bucket_fk",
      columns: [table.bucketKey],
      foreignColumns: [rateLimitBuckets.bucketKey],
    }).onDelete("cascade"),
    index("rate_limit_reservations_bucket_window_idx").on(table.bucketKey, table.windowStartedAt),
  ],
);
