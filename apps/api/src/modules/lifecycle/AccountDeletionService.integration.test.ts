import { randomUUID } from "node:crypto";
import {
  accountDeletions,
  createDb,
  jobs,
  user,
  workspaceDeletions,
  workspaceMembers,
  workspaces,
  type Database,
} from "@glyphquire/database";
import { PostgresJobDispatcher, type JobDispatcher } from "@glyphquire/queue";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AccountDeletionServiceImpl } from "./AccountDeletionService.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const describeWithPostgres = databaseUrl ? describe : describe.skip;
const now = Date.parse("2026-08-26T00:00:00.000Z");

describe("AccountDeletionService configuration", () => {
  it("fails closed when configured below the required 24-hour purge grace", () => {
    expect(
      () =>
        new AccountDeletionServiceImpl(undefined as never, undefined as never, {
          graceSeconds: 86_399,
        }),
    ).toThrow("Invalid account deletion grace seconds");
  });
});

describeWithPostgres("AccountDeletionService", () => {
  let db: Database;

  beforeAll(() => {
    db = createDb(databaseUrl!);
  });

  afterAll(async () => {
    await db.$client.end();
  });

  async function actor(prefix: string) {
    const actorId = `${prefix}-${randomUUID()}`;
    await db.insert(user).values({
      id: actorId,
      name: prefix,
      email: `${actorId}@example.test`,
    });
    return actorId;
  }

  it("coordinates every owner workspace and defers account purge until workspace acknowledgements", async () => {
    const deletingActor = await actor("account-delete-owner");
    const otherPersonalOwner = await actor("account-delete-other-owner");
    const [personal, shared] = await db
      .insert(workspaces)
      .values([{ personalOwnerId: deletingActor }, { personalOwnerId: otherPersonalOwner }])
      .returning({ id: workspaces.id });
    await db.insert(workspaceMembers).values([
      { workspaceId: personal!.id, userId: deletingActor, role: "owner" },
      { workspaceId: shared!.id, userId: otherPersonalOwner, role: "owner" },
      { workspaceId: shared!.id, userId: deletingActor, role: "owner" },
    ]);
    const service = new AccountDeletionServiceImpl(db, new PostgresJobDispatcher(db), {
      graceSeconds: 86_400,
      clock: () => now,
    });

    const result = await service.request(
      deletingActor,
      { confirm: "DELETE_WORKSPACE" },
      "account-delete-key",
    );
    const [coordinator] = await db
      .select()
      .from(accountDeletions)
      .where(eq(accountDeletions.id, result.id));

    expect(coordinator!.workspaceIds).toEqual([personal!.id, shared!.id].sort());
    expect(
      await db
        .select()
        .from(workspaceDeletions)
        .where(eq(workspaceDeletions.requestedBy, deletingActor)),
    ).toHaveLength(2);
    expect(await db.select().from(jobs).where(eq(jobs.type, "workspace.purge"))).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ workspaceId: personal!.id }),
        expect.objectContaining({ workspaceId: shared!.id }),
      ]),
    );
    expect(
      await db
        .select()
        .from(jobs)
        .where(eq(jobs.idempotencyKey, `account-purge-${result.id}`)),
    ).toEqual([]);
  });

  it("schedules a durable nullable-scope purge for a zero-workspace account", async () => {
    const deletingActor = await actor("account-delete-zero");
    const service = new AccountDeletionServiceImpl(db, new PostgresJobDispatcher(db), {
      graceSeconds: 86_400,
      clock: () => now,
    });

    const result = await service.request(
      deletingActor,
      { confirm: "DELETE_WORKSPACE" },
      "account-delete-zero-key",
    );

    expect(
      await db
        .select()
        .from(jobs)
        .where(eq(jobs.idempotencyKey, `account-purge-${result.id}`)),
    ).toEqual([
      expect.objectContaining({
        workspaceId: null,
        type: "account.purge",
        availableAt: new Date(now + 86_400_000),
      }),
    ]);
  });

  it("rolls back a zero-workspace coordinator when transactional enqueue is unavailable", async () => {
    const deletingActor = await actor("account-delete-transaction-zero");
    const nonTransactional = {
      enqueue: async () => ({ id: randomUUID(), duplicate: false }),
      dispatchBatch: async () => ({ claimed: 0, succeeded: 0, retried: 0, deadLettered: 0 }),
    } satisfies JobDispatcher;
    const service = new AccountDeletionServiceImpl(db, nonTransactional, {
      graceSeconds: 86_400,
      clock: () => now,
    });

    await expect(
      service.request(
        deletingActor,
        { confirm: "DELETE_WORKSPACE" },
        `transaction-${randomUUID()}`,
      ),
    ).rejects.toThrow("transactional enqueue unavailable");
    expect(
      await db.select().from(accountDeletions).where(eq(accountDeletions.accountId, deletingActor)),
    ).toEqual([]);
  });
});
