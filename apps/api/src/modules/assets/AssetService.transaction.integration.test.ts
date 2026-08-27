import { randomBytes, randomUUID } from "node:crypto";
import {
  IdempotencyStore,
  assets,
  createDb,
  jobs,
  user,
  workspaceMembers,
  workspaces,
  type Database,
  type IdempotencyBeginInput,
  type IdempotencyBeginResult,
} from "@glyphquire/database";
import {
  PostgresJobDispatcher,
  type EnqueueJobInput,
  type JobDatabaseExecutor,
  type JobDispatcher,
  type JobRegistry,
} from "@glyphquire/queue";
import { InMemoryObjectStorage } from "@glyphquire/storage";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  AssetServiceImpl,
  type AssetServiceHooks,
  type AssetServiceLimits,
} from "./AssetService.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const describeWithPostgres = databaseUrl ? describe : describe.skip;
const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1_000;

async function buildFixture(db: Database) {
  const ownerId = `asset-owner-${randomUUID()}`;
  await db.insert(user).values({
    id: ownerId,
    name: "asset owner",
    email: `${ownerId}@example.test`,
  });
  const [workspace] = await db
    .insert(workspaces)
    .values({ personalOwnerId: ownerId })
    .returning({ id: workspaces.id });
  await db
    .insert(workspaceMembers)
    .values({ workspaceId: workspace!.id, userId: ownerId, role: "owner" });
  return { ownerId, workspaceId: workspace!.id };
}

function pngInput() {
  const body = Buffer.alloc(128);
  Buffer.from([0x89, 0x50, 0x4e, 0x47]).copy(body);
  return {
    originalName: "transaction.png",
    declaredMimeType: "image/png",
    declaredSize: body.byteLength,
    body,
  };
}

async function cleanupJobsForAsset(db: Database, assetId: string) {
  return db
    .select()
    .from(jobs)
    .where(sql`${jobs.payload}->>'assetId' = ${assetId}`);
}

class BarrierIdempotencyStore extends IdempotencyStore {
  private arrivals = 0;
  private release!: () => void;
  private readonly gate = new Promise<void>((resolve) => {
    this.release = resolve;
  });

  override async begin<TResponse>(
    input: IdempotencyBeginInput<TResponse>,
  ): Promise<IdempotencyBeginResult<TResponse>> {
    const result = await super.begin(input);
    this.arrivals += 1;
    if (this.arrivals === 2) this.release();
    await this.gate;
    return result;
  }
}

class FailingTransactionalJobDispatcher implements JobDispatcher {
  withDatabaseExecutor(_executor: JobDatabaseExecutor): JobDispatcher {
    return this;
  }

  async enqueue<TType extends never>(
    _input: EnqueueJobInput<TType>,
  ): Promise<{ id: string; duplicate: boolean }> {
    throw new Error("injected generic enqueue failure");
  }

  async dispatchBatch(_handlers: JobRegistry) {
    return { claimed: 0, succeeded: 0, retried: 0, deadLettered: 0 };
  }
}

describeWithPostgres("AssetService transactional cleanup enqueue", () => {
  let db: Database;
  const encryptionKey = randomBytes(32).toString("base64url");

  beforeAll(() => {
    db = createDb(databaseUrl!);
  });

  afterAll(async () => {
    await db.$client.end();
  });

  function makeService(
    graceDays: number,
    hooks: AssetServiceHooks = {},
    dispatcher: JobDispatcher = new PostgresJobDispatcher(db),
    idempotencyStore: IdempotencyStore = new IdempotencyStore(db, { encryptionKey }),
  ): AssetServiceImpl {
    const limits = {
      assetDeleteGraceDays: graceDays,
    } as Partial<AssetServiceLimits>;
    return new AssetServiceImpl(
      db,
      new InMemoryObjectStorage(),
      dispatcher,
      idempotencyStore,
      limits,
      hooks,
    );
  }

  it("rejects a zero-day cleanup grace instead of scheduling immediate work", () => {
    expect(() => makeService(0)).toThrow("Invalid asset delete grace days");
  });

  it("schedules one asset.cleanup at the configured grace deadline across delete replays", async () => {
    const fixture = await buildFixture(db);
    const graceDays = 7;
    const service = makeService(graceDays);
    const created = await service.create(
      fixture.ownerId,
      fixture.workspaceId,
      pngInput(),
      randomUUID(),
    );

    const deleteKey = randomUUID();
    const deleted = await service.delete(fixture.ownerId, created.id, deleteKey);
    expect(await service.delete(fixture.ownerId, created.id, deleteKey)).toEqual(deleted);
    expect(await service.delete(fixture.ownerId, created.id, randomUUID())).toEqual(deleted);

    const rows = await cleanupJobsForAsset(db, created.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      workspaceId: fixture.workspaceId,
      type: "asset.cleanup",
      idempotencyKey: `asset-cleanup-${created.id}`,
      payload: { workspaceId: fixture.workspaceId, assetId: created.id },
    });
    expect(Object.keys(rows[0]!.payload).sort()).toEqual(["assetId", "workspaceId"]);
    expect(rows[0]!.availableAt.getTime()).toBe(
      Date.parse(deleted.deletedAt!) + graceDays * MILLISECONDS_PER_DAY,
    );
  });

  it("rolls back both the soft delete and cleanup job when the transaction aborts", async () => {
    const fixture = await buildFixture(db);
    const hooks = {
      afterDeleteJobInsert() {
        throw new Error("injected delete transaction failure");
      },
    } as AssetServiceHooks;
    const service = makeService(30, hooks);
    const created = await service.create(
      fixture.ownerId,
      fixture.workspaceId,
      pngInput(),
      randomUUID(),
    );

    await expect(service.delete(fixture.ownerId, created.id, randomUUID())).rejects.toThrow(
      "injected delete transaction failure",
    );

    const [asset] = await db.select().from(assets).where(eq(assets.id, created.id));
    expect(asset!.deletedAt).toBeNull();
    expect(await cleanupJobsForAsset(db, created.id)).toHaveLength(0);
  });

  it("returns and replays one authoritative deletion across differently-keyed races", async () => {
    const fixture = await buildFixture(db);
    const creator = makeService(7);
    const created = await creator.create(
      fixture.ownerId,
      fixture.workspaceId,
      pngInput(),
      randomUUID(),
    );
    const idempotencyStore = new BarrierIdempotencyStore(db, { encryptionKey });
    const service = makeService(7, {}, new PostgresJobDispatcher(db), idempotencyStore);
    const firstKey = randomUUID();
    const secondKey = randomUUID();

    const [first, second] = await Promise.all([
      service.delete(fixture.ownerId, created.id, firstKey),
      service.delete(fixture.ownerId, created.id, secondKey),
    ]);

    expect(first).toEqual(second);
    expect(first.deletedAt).not.toBeNull();
    expect(await service.delete(fixture.ownerId, created.id, firstKey)).toEqual(first);
    expect(await service.delete(fixture.ownerId, created.id, secondKey)).toEqual(second);
    expect(await cleanupJobsForAsset(db, created.id)).toHaveLength(1);
  });

  it("rolls back the soft delete when the generic enqueue fails", async () => {
    const fixture = await buildFixture(db);
    const service = makeService(30, {}, new FailingTransactionalJobDispatcher());
    const created = await service.create(
      fixture.ownerId,
      fixture.workspaceId,
      pngInput(),
      randomUUID(),
    );

    await expect(service.delete(fixture.ownerId, created.id, randomUUID())).rejects.toThrow(
      "injected generic enqueue failure",
    );

    const [asset] = await db.select().from(assets).where(eq(assets.id, created.id));
    expect(asset!.deletedAt).toBeNull();
    expect(await cleanupJobsForAsset(db, created.id)).toHaveLength(0);
  });
});
