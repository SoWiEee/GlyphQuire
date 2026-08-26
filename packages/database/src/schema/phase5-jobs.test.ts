import { describe, expect, expectTypeOf, it } from "vitest";
import { getTableConfig } from "drizzle-orm/pg-core";
import {
  idempotencyRecords as exportedIdempotencyRecords,
  jobs as exportedJobs,
  type IdempotencyRecord,
  type Job,
  type NewIdempotencyRecord,
  type NewJob,
} from "../index.js";
import { idempotencyRecords } from "./idempotency-records.js";
import { jobs } from "./jobs.js";

describe("generic jobs schema", () => {
  it("exports inferred generic job and idempotency record contracts", () => {
    expect(exportedJobs).toBe(jobs);
    expect(exportedIdempotencyRecords).toBe(idempotencyRecords);
    expectTypeOf<Job>().toEqualTypeOf<typeof jobs.$inferSelect>();
    expectTypeOf<NewJob>().toEqualTypeOf<typeof jobs.$inferInsert>();
    expectTypeOf<IdempotencyRecord>().toEqualTypeOf<typeof idempotencyRecords.$inferSelect>();
    expectTypeOf<NewIdempotencyRecord>().toEqualTypeOf<typeof idempotencyRecords.$inferInsert>();
  });

  it("persists the bounded queue state and nullable routing workspace", () => {
    const config = getTableConfig(jobs);
    const columns = config.columns.map((column) => column.name);
    expect(columns).toEqual([
      "id",
      "workspace_id",
      "type",
      "version",
      "payload",
      "status",
      "attempts",
      "max_attempts",
      "available_at",
      "locked_at",
      "locked_by",
      "completed_at",
      "dead_lettered_at",
      "idempotency_key",
      "last_error",
      "created_at",
      "updated_at",
    ]);
    expect(config.columns.find((column) => column.name === "workspace_id")?.notNull).toBe(false);
    expect(config.columns.find((column) => column.name === "max_attempts")?.default).toBe(5);
    expect(
      config.foreignKeys.find((foreignKey) => foreignKey.getName().includes("workspace"))?.onDelete,
    ).toBe("set null");
    expect(config.checks.map((check) => check.name)).toEqual(
      expect.arrayContaining([
        "jobs_version_positive_check",
        "jobs_status_check",
        "jobs_attempts_nonnegative_check",
        "jobs_max_attempts_check",
        "jobs_payload_object_check",
        "jobs_scope_check",
        "jobs_state_shape_check",
      ]),
    );
    expect(config.indexes.map((index) => index.config.name)).toEqual(
      expect.arrayContaining([
        "jobs_idempotency_scope_idx",
        "jobs_pending_due_idx",
        "jobs_processing_lock_idx",
      ]),
    );
  });

  it("stores only encrypted completed responses or active hashed leases", () => {
    const config = getTableConfig(idempotencyRecords);
    expect(config.columns.map((column) => column.name)).toEqual([
      "id",
      "workspace_id",
      "actor_id",
      "operation",
      "idempotency_key",
      "request_hash",
      "response_ciphertext",
      "owner_token_hash",
      "lease_expires_at",
      "completed_at",
      "created_at",
    ]);
    expect(config.checks.map((check) => check.name)).toEqual(
      expect.arrayContaining([
        "idempotency_records_state_shape_check",
        "idempotency_records_request_hash_check",
        "idempotency_records_owner_hash_check",
      ]),
    );
    expect(
      config.indexes.find((index) => index.config.name === "idempotency_records_scope_unique")
        ?.config.unique,
    ).toBe(true);
  });
});
