import { randomUUID } from "node:crypto";
import {
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
import { PublicApiError } from "../../middleware/error-handler.js";
import { WorkspaceDeletionServiceImpl } from "./WorkspaceDeletionService.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const describeWithPostgres = databaseUrl ? describe : describe.skip;
const now = Date.parse("2026-08-26T00:00:00.000Z");

describe("WorkspaceDeletionService configuration", () => {
  it("fails closed when configured below the required 24-hour purge grace", () => {
    expect(
      () =>
        new WorkspaceDeletionServiceImpl(undefined as never, undefined as never, {
          graceSeconds: 86_399,
        }),
    ).toThrow("Invalid workspace deletion grace seconds");
  });
});

describeWithPostgres("WorkspaceDeletionService", () => {
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

  it("requires owner authority and schedules the durable purge at the exact 24-hour grace", async () => {
    const owner = await actor("workspace-delete-owner");
    const viewer = await actor("workspace-delete-viewer");
    const [workspace] = await db
      .insert(workspaces)
      .values({ personalOwnerId: owner })
      .returning({ id: workspaces.id });
    await db.insert(workspaceMembers).values([
      { workspaceId: workspace!.id, userId: owner, role: "owner" },
      { workspaceId: workspace!.id, userId: viewer, role: "viewer" },
    ]);
    const service = new WorkspaceDeletionServiceImpl(db, new PostgresJobDispatcher(db), {
      graceSeconds: 86_400,
      clock: () => now,
    });

    await expect(
      service.request(viewer, workspace!.id, { confirm: "DELETE_WORKSPACE" }, "viewer-denied"),
    ).rejects.toBeInstanceOf(PublicApiError);

    const created = await service.request(
      owner,
      workspace!.id,
      { confirm: "DELETE_WORKSPACE" },
      "workspace-delete-key",
    );
    expect(created.executeAfter).toBe(new Date(now + 86_400_000).toISOString());
    expect(
      await db.select().from(workspaceDeletions).where(eq(workspaceDeletions.id, created.id)),
    ).toHaveLength(1);
    expect(
      await db
        .select()
        .from(jobs)
        .where(eq(jobs.idempotencyKey, `workspace-purge-${created.id}`)),
    ).toEqual([
      expect.objectContaining({
        workspaceId: workspace!.id,
        type: "workspace.purge",
        status: "pending",
        availableAt: new Date(now + 86_400_000),
      }),
    ]);

    await expect(
      service.request(
        owner,
        workspace!.id,
        { confirm: "DELETE_WORKSPACE" },
        "workspace-delete-key",
      ),
    ).resolves.toEqual(created);
    await expect(
      service.request(owner, workspace!.id, { confirm: "DELETE_WORKSPACE" }, "different-key"),
    ).rejects.toMatchObject({ code: "OPERATION_REUSED", status: 409 });
  });

  it("rolls back the deletion record when transactional enqueue is unavailable", async () => {
    const owner = await actor("workspace-delete-transaction-owner");
    const [workspace] = await db
      .insert(workspaces)
      .values({ personalOwnerId: owner })
      .returning({ id: workspaces.id });
    await db.insert(workspaceMembers).values({
      workspaceId: workspace!.id,
      userId: owner,
      role: "owner",
    });
    const nonTransactional = {
      enqueue: async () => ({ id: randomUUID(), duplicate: false }),
      dispatchBatch: async () => ({ claimed: 0, succeeded: 0, retried: 0, deadLettered: 0 }),
    } satisfies JobDispatcher;
    const service = new WorkspaceDeletionServiceImpl(db, nonTransactional, {
      graceSeconds: 86_400,
      clock: () => now,
    });

    await expect(
      service.request(
        owner,
        workspace!.id,
        { confirm: "DELETE_WORKSPACE" },
        `transaction-${randomUUID()}`,
      ),
    ).rejects.toThrow("transactional enqueue unavailable");
    expect(
      await db
        .select()
        .from(workspaceDeletions)
        .where(eq(workspaceDeletions.workspaceId, workspace!.id)),
    ).toEqual([]);
  });
});
