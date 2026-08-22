import { sql } from "drizzle-orm";
import { check, index, integer, pgTable, text, timestamp } from "drizzle-orm/pg-core";

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
    check("rate_limit_buckets_request_count_positive_check", sql`${table.requestCount} > 0`),
  ],
);
