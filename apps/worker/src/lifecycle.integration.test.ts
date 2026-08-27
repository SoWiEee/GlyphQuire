import { randomUUID } from "node:crypto";
import { createDb, jobs, type Database } from "@glyphquire/database";
import { PostgresJobDispatcher, type JobHandler } from "@glyphquire/queue";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { WorkerRuntime } from "./runtime.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const describeWithPostgres = databaseUrl ? describe : describe.skip;

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describeWithPostgres("worker lifecycle lock ownership", () => {
  let database: Database;
  const jobIds = new Set<string>();

  beforeAll(() => {
    const url = new URL(databaseUrl!);
    if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) {
      throw new Error("Worker lifecycle integration tests require a loopback PostgreSQL URL");
    }
    database = createDb(url.toString());
  });

  afterEach(async () => {
    for (const jobId of jobIds) await database.delete(jobs).where(eq(jobs.id, jobId));
    jobIds.clear();
  });

  afterAll(async () => {
    if (database) await database.$client.end();
  });

  it("releases an aborted owned lock for a later dispatcher to reclaim", async () => {
    // Keep this worker's clock well before any real/shared test rows so only
    // the explicitly enqueued lifecycle fixture is due for its batch.
    let now = Date.parse("2000-01-01T00:00:00.000Z");
    const firstDispatcher = new PostgresJobDispatcher(database, {
      dispatcherId: `lifecycle-first-${randomUUID()}`,
      batchSize: 1,
      lockTimeoutSeconds: 300,
      backoffBaseSeconds: 1,
      backoffCapSeconds: 1,
      clock: () => now,
    });
    const secondDispatcher = new PostgresJobDispatcher(database, {
      dispatcherId: `lifecycle-second-${randomUUID()}`,
      batchSize: 1,
      lockTimeoutSeconds: 300,
      backoffBaseSeconds: 1,
      backoffCapSeconds: 1,
      clock: () => now,
    });
    const enqueued = await firstDispatcher.enqueue({
      workspaceId: null,
      type: "backup.verify",
      payload: { workspaceId: null, backupId: randomUUID() },
    });
    jobIds.add(enqueued.id);

    const handlerStarted = deferred();
    const abortingHandler: JobHandler<"backup.verify"> = async (_job, signal) => {
      handlerStarted.resolve();
      await new Promise<void>((_resolve, reject) => {
        const rejectAborted = () => reject(new Error("raw shutdown detail must be scrubbed"));
        if (signal.aborted) rejectAborted();
        else signal.addEventListener("abort", rejectAborted, { once: true });
      });
    };
    const runtime = new WorkerRuntime(firstDispatcher, { "backup.verify": abortingHandler });

    const dispatching = runtime.dispatchOnce();
    await handlerStarted.promise;
    await runtime.shutdown();
    await expect(dispatching).resolves.toMatchObject({ claimed: 1, retried: 1 });

    await expect(
      database
        .select({
          status: jobs.status,
          attempts: jobs.attempts,
          lockedAt: jobs.lockedAt,
          lockedBy: jobs.lockedBy,
          lastError: jobs.lastError,
        })
        .from(jobs)
        .where(eq(jobs.id, enqueued.id)),
    ).resolves.toEqual([
      {
        status: "pending",
        attempts: 1,
        lockedAt: null,
        lockedBy: null,
        lastError: "JOB_FAILED",
      },
    ]);

    const completingHandler: JobHandler<"backup.verify"> = async () => undefined;
    await expect(
      secondDispatcher.dispatchBatch({ "backup.verify": completingHandler }),
    ).resolves.toMatchObject({ claimed: 0 });

    now += 1_000;
    await expect(
      secondDispatcher.dispatchBatch({ "backup.verify": completingHandler }),
    ).resolves.toMatchObject({ claimed: 1, succeeded: 1 });
    await expect(
      database
        .select({ status: jobs.status, attempts: jobs.attempts, lockedBy: jobs.lockedBy })
        .from(jobs)
        .where(eq(jobs.id, enqueued.id)),
    ).resolves.toEqual([{ status: "completed", attempts: 2, lockedBy: null }]);
  });
});
