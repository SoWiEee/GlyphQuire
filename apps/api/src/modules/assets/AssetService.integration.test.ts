import { randomBytes, randomUUID } from "node:crypto";
import {
  IdempotencyStore,
  assets,
  createDb,
  user,
  workspaceMembers,
  workspaces,
  type Database,
  type WorkspaceRole,
} from "@glyphquire/database";
import { InMemoryObjectStorage } from "@glyphquire/storage";
import type {
  EnqueueJobInput,
  JobDatabaseExecutor,
  JobDispatcher,
  JobRegistry,
} from "@glyphquire/queue";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PublicApiError } from "../../middleware/error-handler.js";
import { AssetServiceImpl, type AssetServiceHooks, type CreateAssetInput } from "./AssetService.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const describeWithPostgres = databaseUrl ? describe : describe.skip;

function idFor(prefix: string) {
  return `${prefix}-${randomUUID()}`;
}

async function insertActor(db: Database, prefix: string) {
  const id = idFor(prefix);
  await db.insert(user).values({ id, name: prefix, email: `${id}@example.test` });
  return id;
}

async function insertWorkspace(db: Database, ownerId: string) {
  const [workspace] = await db
    .insert(workspaces)
    .values({ personalOwnerId: ownerId })
    .returning({ id: workspaces.id });
  await db
    .insert(workspaceMembers)
    .values({ workspaceId: workspace!.id, userId: ownerId, role: "owner" });
  return workspace!.id;
}

async function addMember(db: Database, workspaceId: string, userId: string, role: WorkspaceRole) {
  await db.insert(workspaceMembers).values({ workspaceId, userId, role });
}

class FakeJobDispatcher implements JobDispatcher {
  readonly enqueued: EnqueueJobInput<never>[] = [];

  withDatabaseExecutor(_executor: JobDatabaseExecutor): JobDispatcher {
    return this;
  }

  async enqueue<TType extends never>(
    input: EnqueueJobInput<TType>,
  ): Promise<{ id: string; duplicate: boolean }> {
    this.enqueued.push(input as EnqueueJobInput<never>);
    return { id: randomUUID(), duplicate: false };
  }

  async dispatchBatch(_registry: JobRegistry) {
    return { claimed: 0, succeeded: 0, retried: 0, deadLettered: 0 };
  }
}

async function captureApiError(fn: () => Promise<unknown>) {
  try {
    await fn();
  } catch (error) {
    if (error instanceof PublicApiError) return { code: error.code, status: error.status };
    throw error;
  }
  throw new Error("expected the call to reject");
}

function pngLikeBody(byteLength: number): Buffer {
  const body = Buffer.alloc(byteLength, 0);
  Buffer.from([0x89, 0x50, 0x4e, 0x47]).copy(body); // PNG magic bytes
  return body;
}

function createInput(overrides: Partial<CreateAssetInput> = {}): CreateAssetInput {
  const body = overrides.body ?? pngLikeBody(1024);
  return {
    originalName: "photo.png",
    declaredMimeType: "image/png",
    declaredSize: body.byteLength,
    body,
    ...overrides,
  };
}

interface Fixture {
  owner: string;
  editor: string;
  viewer: string;
  outsider: string;
  workspaceId: string;
}

async function buildFixture(db: Database): Promise<Fixture> {
  const owner = await insertActor(db, "owner");
  const editor = await insertActor(db, "editor");
  const viewer = await insertActor(db, "viewer");
  const outsider = await insertActor(db, "outsider");
  const workspaceId = await insertWorkspace(db, owner);
  await addMember(db, workspaceId, editor, "editor");
  await addMember(db, workspaceId, viewer, "viewer");
  return { owner, editor, viewer, outsider, workspaceId };
}

describeWithPostgres("AssetService", () => {
  let db: Database;
  const encryptionKey = randomBytes(32).toString("base64url");

  function makeService(
    storage: InMemoryObjectStorage,
    dispatcher: FakeJobDispatcher,
    overrides: { maxBytes?: number; workspaceQuotaBytes?: number; hooks?: AssetServiceHooks } = {},
  ) {
    const idempotencyStore = new IdempotencyStore(db, { encryptionKey });
    return new AssetServiceImpl(
      db,
      storage,
      dispatcher,
      idempotencyStore,
      {
        maxBytes: overrides.maxBytes ?? 5 * 1024 * 1024,
        workspaceQuotaBytes: overrides.workspaceQuotaBytes ?? 100 * 1024 * 1024,
        downloadUrlExpirySeconds: 300,
      },
      overrides.hooks,
    );
  }

  beforeAll(() => {
    db = createDb(databaseUrl!);
  });

  afterAll(async () => {
    await db.$client.end();
  });

  it("denies asset creation for a non-member", async () => {
    const fixture = await buildFixture(db);
    const storage = new InMemoryObjectStorage();
    const service = makeService(storage, new FakeJobDispatcher());

    const error = await captureApiError(() =>
      service.create(fixture.outsider, fixture.workspaceId, createInput(), randomUUID()),
    );
    expect(error).toEqual({ code: "ASSET_INVALID", status: 404 });
  });

  it("denies asset creation for a viewer (read-only role)", async () => {
    const fixture = await buildFixture(db);
    const storage = new InMemoryObjectStorage();
    const service = makeService(storage, new FakeJobDispatcher());

    const error = await captureApiError(() =>
      service.create(fixture.viewer, fixture.workspaceId, createInput(), randomUUID()),
    );
    expect(error).toEqual({ code: "ASSET_INVALID", status: 404 });
  });

  it("accepts exactly ASSET_MAX_BYTES and rejects one byte over", async () => {
    const fixture = await buildFixture(db);
    const storage = new InMemoryObjectStorage();
    const maxBytes = 1024;
    const service = makeService(storage, new FakeJobDispatcher(), { maxBytes });

    const atLimit = await service.create(
      fixture.owner,
      fixture.workspaceId,
      createInput({ body: pngLikeBody(maxBytes), declaredSize: maxBytes }),
      randomUUID(),
    );
    expect(atLimit.size).toBe(maxBytes);

    const overLimit = pngLikeBody(maxBytes + 1);
    const error = await captureApiError(() =>
      service.create(
        fixture.owner,
        fixture.workspaceId,
        createInput({ body: overLimit, declaredSize: overLimit.byteLength }),
        randomUUID(),
      ),
    );
    expect(error).toEqual({ code: "ASSET_INVALID", status: 400 });
  });

  it("rejects an actual-vs-declared length mismatch", async () => {
    const fixture = await buildFixture(db);
    const storage = new InMemoryObjectStorage();
    const service = makeService(storage, new FakeJobDispatcher());

    const error = await captureApiError(() =>
      service.create(
        fixture.owner,
        fixture.workspaceId,
        createInput({ declaredSize: 999 }),
        randomUUID(),
      ),
    );
    expect(error).toEqual({ code: "ASSET_INVALID", status: 400 });
  });

  it("rejects a MIME type that contradicts the sniffed bytes", async () => {
    const fixture = await buildFixture(db);
    const storage = new InMemoryObjectStorage();
    const service = makeService(storage, new FakeJobDispatcher());

    const body = pngLikeBody(64); // real PNG magic bytes
    const error = await captureApiError(() =>
      service.create(
        fixture.owner,
        fixture.workspaceId,
        createInput({ declaredMimeType: "application/pdf", body, declaredSize: body.byteLength }),
        randomUUID(),
      ),
    );
    expect(error).toEqual({ code: "ASSET_INVALID", status: 400 });
  });

  it("normalizes a path-traversal filename to a safe display name", async () => {
    const fixture = await buildFixture(db);
    const storage = new InMemoryObjectStorage();
    const service = makeService(storage, new FakeJobDispatcher());

    const result = await service.create(
      fixture.owner,
      fixture.workspaceId,
      createInput({ originalName: "../../etc/passwd" }),
      randomUUID(),
    );
    expect(result.originalName).not.toContain("/");
    expect(result.originalName).not.toContain("..");
  });

  it("derives the object key from a server UUID, not client input", async () => {
    const fixture = await buildFixture(db);
    const storage = new InMemoryObjectStorage();
    const service = makeService(storage, new FakeJobDispatcher());

    const result = await service.create(
      fixture.owner,
      fixture.workspaceId,
      createInput(),
      randomUUID(),
    );
    const [row] = await db.select().from(assets).where(eq(assets.id, result.id));
    expect(row!.objectKey).toBe(`workspace/${fixture.workspaceId}/assets/${result.id}/original`);
    expect(storage.has(row!.objectKey)).toBe(true);
  });

  it("rejects uploads that would exceed the workspace storage quota", async () => {
    const fixture = await buildFixture(db);
    const storage = new InMemoryObjectStorage();
    const service = makeService(storage, new FakeJobDispatcher(), { workspaceQuotaBytes: 2000 });

    await service.create(
      fixture.owner,
      fixture.workspaceId,
      createInput({ body: pngLikeBody(1500), declaredSize: 1500 }),
      randomUUID(),
    );
    const error = await captureApiError(() =>
      service.create(
        fixture.owner,
        fixture.workspaceId,
        createInput({ body: pngLikeBody(600), declaredSize: 600 }),
        randomUUID(),
      ),
    );
    expect(error).toEqual({ code: "ASSET_INVALID", status: 400 });
  });

  it("replays an identical request under the same idempotency key", async () => {
    const fixture = await buildFixture(db);
    const storage = new InMemoryObjectStorage();
    const service = makeService(storage, new FakeJobDispatcher());
    const key = randomUUID();

    const first = await service.create(fixture.owner, fixture.workspaceId, createInput(), key);
    const second = await service.create(fixture.owner, fixture.workspaceId, createInput(), key);
    expect(second).toEqual(first);
    expect(storage.size()).toBe(1);
  });

  it("rejects a reused idempotency key against a different request body", async () => {
    const fixture = await buildFixture(db);
    const storage = new InMemoryObjectStorage();
    const service = makeService(storage, new FakeJobDispatcher());
    const key = randomUUID();

    await service.create(fixture.owner, fixture.workspaceId, createInput(), key);
    const error = await captureApiError(() =>
      service.create(
        fixture.owner,
        fixture.workspaceId,
        createInput({ originalName: "different.png" }),
        key,
      ),
    );
    expect(error).toEqual({ code: "OPERATION_REUSED", status: 409 });
  });

  it("compensates by deleting the object when the transaction fails after the object write", async () => {
    const fixture = await buildFixture(db);
    const storage = new InMemoryObjectStorage();
    const service = makeService(storage, new FakeJobDispatcher(), {
      hooks: {
        afterObjectPut: () => {
          throw new Error("simulated post-write failure");
        },
      },
    });

    await expect(
      service.create(fixture.owner, fixture.workspaceId, createInput(), randomUUID()),
    ).rejects.toThrow("simulated post-write failure");
    expect(storage.size()).toBe(0);

    const rows = await db.select().from(assets).where(eq(assets.workspaceId, fixture.workspaceId));
    expect(rows).toHaveLength(0);
  });

  it("rolls the DB insert back and never writes the object when the object write fails", async () => {
    const fixture = await buildFixture(db);
    const storage = new InMemoryObjectStorage({
      beforePut: () => {
        throw new Error("simulated object storage outage");
      },
    });
    const service = makeService(storage, new FakeJobDispatcher());

    await expect(
      service.create(fixture.owner, fixture.workspaceId, createInput(), randomUUID()),
    ).rejects.toThrow("simulated object storage outage");
    expect(storage.size()).toBe(0);

    const rows = await db.select().from(assets).where(eq(assets.workspaceId, fixture.workspaceId));
    expect(rows).toHaveLength(0);
  });

  it("returns uniform not-found for a missing, deleted, or unauthorized asset on get()", async () => {
    const fixture = await buildFixture(db);
    const storage = new InMemoryObjectStorage();
    const service = makeService(storage, new FakeJobDispatcher());
    const created = await service.create(
      fixture.owner,
      fixture.workspaceId,
      createInput(),
      randomUUID(),
    );

    const missing = await captureApiError(() => service.get(fixture.owner, randomUUID()));
    expect(missing).toEqual({ code: "ASSET_INVALID", status: 404 });

    const unauthorized = await captureApiError(() => service.get(fixture.outsider, created.id));
    expect(unauthorized).toEqual({ code: "ASSET_INVALID", status: 404 });

    await service.delete(fixture.owner, created.id, randomUUID());
    const afterDelete = await captureApiError(() => service.get(fixture.owner, created.id));
    expect(afterDelete).toEqual({ code: "ASSET_INVALID", status: 404 });
  });

  it("soft-deletes and enqueues asset.cleanup, and replays delete under the same idempotency key", async () => {
    const fixture = await buildFixture(db);
    const storage = new InMemoryObjectStorage();
    const dispatcher = new FakeJobDispatcher();
    const service = makeService(storage, dispatcher);
    const created = await service.create(
      fixture.owner,
      fixture.workspaceId,
      createInput(),
      randomUUID(),
    );

    const key = randomUUID();
    const first = await service.delete(fixture.owner, created.id, key);
    expect(first.deletedAt).not.toBeNull();
    expect(dispatcher.enqueued).toHaveLength(1);
    expect(dispatcher.enqueued[0]).toMatchObject({
      workspaceId: fixture.workspaceId,
      type: "asset.cleanup",
      payload: { workspaceId: fixture.workspaceId, assetId: created.id },
    });

    const second = await service.delete(fixture.owner, created.id, key);
    expect(second).toEqual(first);
    expect(dispatcher.enqueued).toHaveLength(1); // no duplicate enqueue on replay

    const [row] = await db.select().from(assets).where(eq(assets.id, created.id));
    expect(row!.deletedAt).not.toBeNull();
  });

  it("denies delete for a viewer", async () => {
    const fixture = await buildFixture(db);
    const storage = new InMemoryObjectStorage();
    const service = makeService(storage, new FakeJobDispatcher());
    const created = await service.create(
      fixture.owner,
      fixture.workspaceId,
      createInput(),
      randomUUID(),
    );

    const error = await captureApiError(() =>
      service.delete(fixture.viewer, created.id, randomUUID()),
    );
    expect(error).toEqual({ code: "ASSET_INVALID", status: 404 });
  });

  it("issues a download URL only for an authorized, non-deleted asset", async () => {
    const fixture = await buildFixture(db);
    const storage = new InMemoryObjectStorage();
    const service = makeService(storage, new FakeJobDispatcher());
    const created = await service.create(
      fixture.owner,
      fixture.workspaceId,
      createInput(),
      randomUUID(),
    );

    const withUrl = await service.getDownloadUrl(fixture.viewer, created.id);
    expect(withUrl.downloadUrl).toBeTruthy();

    const unauthorized = await captureApiError(() =>
      service.getDownloadUrl(fixture.outsider, created.id),
    );
    expect(unauthorized).toEqual({ code: "ASSET_INVALID", status: 404 });
  });

  it("rejects a thumbnail URL request while the thumbnail is not ready", async () => {
    const fixture = await buildFixture(db);
    const storage = new InMemoryObjectStorage();
    const service = makeService(storage, new FakeJobDispatcher());
    const created = await service.create(
      fixture.owner,
      fixture.workspaceId,
      createInput(),
      randomUUID(),
    );

    const error = await captureApiError(() => service.getThumbnailUrl(fixture.owner, created.id));
    expect(error).toEqual({ code: "ASSET_INVALID", status: 400 });
  });

  it("issues a thumbnail URL once the thumbnail is marked ready", async () => {
    const fixture = await buildFixture(db);
    const storage = new InMemoryObjectStorage();
    const service = makeService(storage, new FakeJobDispatcher());
    const created = await service.create(
      fixture.owner,
      fixture.workspaceId,
      createInput(),
      randomUUID(),
    );

    const thumbnailKey = `workspace/${fixture.workspaceId}/assets/${created.id}/thumbnail.webp`;
    const thumbnailBody = Buffer.from("fake-webp-bytes");
    const { createHash } = await import("node:crypto");
    await storage.put({
      key: thumbnailKey,
      body: thumbnailBody,
      contentType: "image/webp",
      contentLength: thumbnailBody.byteLength,
      sha256: createHash("sha256").update(thumbnailBody).digest("hex"),
    });
    await db
      .update(assets)
      .set({
        thumbnailStatus: "ready",
        thumbnailObjectKey: thumbnailKey,
        thumbnailMimeType: "image/webp",
        thumbnailWidth: 100,
        thumbnailHeight: 100,
        thumbnailBytes: thumbnailBody.byteLength,
      })
      .where(eq(assets.id, created.id));

    const result = await service.getThumbnailUrl(fixture.owner, created.id);
    expect(result.thumbnailUrl).toBeTruthy();
    expect(result.thumbnailStatus).toBe("ready");
  });
});
