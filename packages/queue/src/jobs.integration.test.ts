import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createDb, jobs, MigrationRunner, type Database } from "@glyphquire/database";
import { eq } from "drizzle-orm";
import { PostgresJobDispatcher, type JobHandler } from "./jobs.js";

const migrationDatabaseUrl = process.env.TEST_MIGRATION_DATABASE_URL;
const describeWithPostgres = migrationDatabaseUrl ? describe : describe.skip;
const migrationsDirectory = fileURLToPath(
  new URL("../../database/src/migrations", import.meta.url),
);

function urlForDatabase(baseUrl: string, databaseName: string): string {
  const url = new URL(baseUrl);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

describeWithPostgres("PostgresJobDispatcher claim ownership", () => {
  let admin: Database;
  let database: Database;
  let databaseName: string;

  beforeAll(async () => {
    const url = new URL(migrationDatabaseUrl!);
    if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) {
      throw new Error("Job claim integration tests require a loopback PostgreSQL URL");
    }
    admin = createDb(url.toString());
    databaseName = `glyphquire_p5_claim_${randomUUID().replaceAll("-", "")}`;
    await admin.$client.unsafe(`create database "${databaseName}"`);
    database = createDb(urlForDatabase(url.toString(), databaseName));
    await new MigrationRunner({
      databaseUrl: url.toString(),
      migrationsDirectory,
    }).execute(database);
  });

  afterAll(async () => {
    if (database) await database.$client.end();
    if (admin && databaseName) {
      await admin.$client`
        select pg_catalog.pg_terminate_backend(activity.pid)
        from pg_catalog.pg_stat_activity activity
        where activity.datname = ${databaseName}
          and activity.pid <> pg_catalog.pg_backend_pid()
      `;
      await admin.$client.unsafe(`drop database "${databaseName}"`);
      await admin.$client.end();
    }
  });

  it("rejects an older completion after the same dispatcher id reclaims the job", async () => {
    let now = Date.parse("2026-08-26T01:00:00.000Z");
    const dispatcher = new PostgresJobDispatcher(database, {
      dispatcherId: "reused-dispatcher",
      lockTimeoutSeconds: 1,
      clock: () => now,
    });
    const backupId = randomUUID();
    const enqueued = await dispatcher.enqueue({
      workspaceId: null,
      type: "backup.verify",
      payload: { workspaceId: null, backupId },
    });
    let releaseFirst!: () => void;
    const firstMayFinish = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let releaseSecond!: () => void;
    const secondMayFinish = new Promise<void>((resolve) => {
      releaseSecond = resolve;
    });
    let firstStarted!: () => void;
    const firstDidStart = new Promise<void>((resolve) => {
      firstStarted = resolve;
    });
    let secondStarted!: () => void;
    const secondDidStart = new Promise<void>((resolve) => {
      secondStarted = resolve;
    });
    const handler = vi.fn<JobHandler<"backup.verify">>(async (job) => {
      if (job.attempts === 1) {
        firstStarted();
        await firstMayFinish;
        return;
      }
      secondStarted();
      await secondMayFinish;
    });

    const staleDispatch = dispatcher.dispatchBatch({ "backup.verify": handler });
    await firstDidStart;
    now += 2_000;
    const currentDispatch = dispatcher.dispatchBatch({ "backup.verify": handler });
    await secondDidStart;

    releaseFirst();
    await expect(staleDispatch).resolves.toMatchObject({ succeeded: 0 });
    await expect(
      database
        .select({ status: jobs.status, attempts: jobs.attempts })
        .from(jobs)
        .where(eq(jobs.id, enqueued.id)),
    ).resolves.toEqual([{ status: "processing", attempts: 2 }]);

    releaseSecond();
    await expect(currentDispatch).resolves.toMatchObject({ succeeded: 1 });
    await expect(
      database
        .select({ status: jobs.status, attempts: jobs.attempts })
        .from(jobs)
        .where(eq(jobs.id, enqueued.id)),
    ).resolves.toEqual([{ status: "completed", attempts: 2 }]);
  });
});
