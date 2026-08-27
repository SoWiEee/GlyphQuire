import { randomBytes, randomUUID } from "node:crypto";
import {
  IdempotencyStore,
  assets,
  createDb,
  user,
  workspaceMembers,
  workspaces,
  type Database,
} from "@glyphquire/database";
import { InMemoryObjectStorage } from "@glyphquire/storage";
import type {
  EnqueueJobInput,
  JobDatabaseExecutor,
  JobDispatcher,
  JobRegistry,
} from "@glyphquire/queue";
import { eq } from "drizzle-orm";
import { Hono, type Context } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createErrorHandler } from "../../middleware/error-handler.js";
import type { SecurityVariables } from "../../middleware/security.js";
import { AssetServiceImpl } from "../../modules/assets/AssetService.js";
import { createAssetRoutes } from "./assets.js";

// AssetService's own authorization matrix, byte/quota limits, idempotency
// replay/conflict semantics, and transaction atomicity are covered in
// ../../modules/assets/AssetService.integration.test.ts. This file exercises
// the HTTP seam: multipart parsing, route mounting, status codes, and the
// contract-validated response/error envelope observed at the boundary. The
// routes are not yet mounted onto the shared app (Task 8 wires them in);
// this test mounts them onto a minimal harness app instead.

const databaseUrl = process.env.TEST_DATABASE_URL;
const describeWithPostgres = databaseUrl ? describe : describe.skip;
const baseUrl = "http://localhost:3000";

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

function testAuthMiddleware() {
  return async (context: Context<{ Variables: SecurityVariables }>, next: () => Promise<void>) => {
    const actorId = context.req.header("x-test-actor-id");
    if (!actorId) return context.json({ error: { code: "NOTE_NOT_FOUND" } }, 404);
    context.set("requestContext", {
      requestId: randomUUID(),
      actorId,
      session: {} as never,
    });
    await next();
  };
}

function buildApp(assetService: AssetServiceImpl) {
  return new Hono<{ Variables: SecurityVariables }>()
    .use("*", testAuthMiddleware())
    .onError(createErrorHandler())
    .route("/api/v1", createAssetRoutes(assetService));
}

function v1(
  app: ReturnType<typeof buildApp>,
  path: string,
  actorId: string,
  init: RequestInit = {},
) {
  const headers = new Headers(init.headers);
  headers.set("x-test-actor-id", actorId);
  return app.request(`${baseUrl}/api/v1${path}`, { ...init, headers });
}

function multipartBody(fileName: string, mimeType: string, content: Buffer) {
  const form = new FormData();
  form.set("file", new File([new Uint8Array(content)], fileName, { type: mimeType }));
  return form;
}

describeWithPostgres("asset routes", () => {
  let db: Database;
  const encryptionKey = randomBytes(32).toString("base64url");

  beforeAll(() => {
    db = createDb(databaseUrl!);
  });

  afterAll(async () => {
    await db.$client.end();
  });

  async function insertActor(prefix: string) {
    const id = `${prefix}-${randomUUID()}`;
    await db.insert(user).values({ id, name: prefix, email: `${id}@example.test` });
    return id;
  }

  async function buildFixture() {
    const owner = await insertActor("owner");
    const outsider = await insertActor("outsider");
    const [workspace] = await db
      .insert(workspaces)
      .values({ personalOwnerId: owner })
      .returning({ id: workspaces.id });
    await db
      .insert(workspaceMembers)
      .values({ workspaceId: workspace!.id, userId: owner, role: "owner" });
    return { owner, outsider, workspaceId: workspace!.id };
  }

  function freshApp() {
    const storage = new InMemoryObjectStorage();
    const dispatcher = new FakeJobDispatcher();
    const idempotencyStore = new IdempotencyStore(db, { encryptionKey });
    const assetService = new AssetServiceImpl(db, storage, dispatcher, idempotencyStore);
    return { app: buildApp(assetService), storage, dispatcher };
  }

  it("uploads, reads, downloads, and deletes an asset through the mounted routes", async () => {
    const fixture = await buildFixture();
    const { app } = freshApp();
    const body = Buffer.alloc(64, 1);
    Buffer.from([0x89, 0x50, 0x4e, 0x47]).copy(body);

    const createResponse = await v1(
      app,
      `/workspaces/${fixture.workspaceId}/assets`,
      fixture.owner,
      {
        method: "POST",
        headers: { "idempotency-key": randomUUID() },
        body: multipartBody("photo.png", "image/png", body),
      },
    );
    expect(createResponse.status).toBe(201);
    const created = (await createResponse.json()) as { id: string; originalName: string };
    expect(created.originalName).toBe("photo.png");

    const getResponse = await v1(app, `/assets/${created.id}`, fixture.owner);
    expect(getResponse.status).toBe(200);
    const fetched = (await getResponse.json()) as { id: string; downloadUrl?: string };
    expect(fetched.id).toBe(created.id);
    expect(fetched.downloadUrl).toBeUndefined();

    const downloadResponse = await v1(app, `/assets/${created.id}/download`, fixture.owner);
    expect(downloadResponse.status).toBe(200);
    const downloaded = (await downloadResponse.json()) as { downloadUrl: string };
    expect(downloaded.downloadUrl).toBeTruthy();

    const deleteResponse = await v1(app, `/assets/${created.id}`, fixture.owner, {
      method: "DELETE",
      headers: { "idempotency-key": randomUUID() },
    });
    expect(deleteResponse.status).toBe(200);
    const deleted = (await deleteResponse.json()) as { deletedAt: string | null };
    expect(deleted.deletedAt).not.toBeNull();
  });

  it("returns a uniform not-found envelope for an outsider, without metadata leakage", async () => {
    const fixture = await buildFixture();
    const { app } = freshApp();
    const body = Buffer.alloc(16, 2);
    const createResponse = await v1(
      app,
      `/workspaces/${fixture.workspaceId}/assets`,
      fixture.owner,
      {
        method: "POST",
        headers: { "idempotency-key": randomUUID() },
        body: multipartBody("secret.txt", "text/plain", body),
      },
    );
    const created = (await createResponse.json()) as { id: string };

    const response = await v1(app, `/assets/${created.id}`, fixture.outsider);
    expect(response.status).toBe(404);
    const envelope = (await response.json()) as { error: { code: string; message: string } };
    expect(envelope.error.code).toBe("ASSET_INVALID");
    expect(JSON.stringify(envelope)).not.toContain("secret.txt");
  });

  it("rejects a missing idempotency-key header on create", async () => {
    const fixture = await buildFixture();
    const { app } = freshApp();
    const response = await v1(app, `/workspaces/${fixture.workspaceId}/assets`, fixture.owner, {
      method: "POST",
      body: multipartBody("photo.png", "image/png", Buffer.alloc(16, 1)),
    });
    expect(response.status).toBe(400);
  });

  it("rejects a malformed workspaceId path parameter", async () => {
    const { app } = freshApp();
    const response = await v1(app, "/workspaces/not-a-uuid/assets", await insertActor("random"), {
      method: "POST",
      headers: { "idempotency-key": randomUUID() },
      body: multipartBody("photo.png", "image/png", Buffer.alloc(16, 1)),
    });
    expect(response.status).toBe(400);
  });

  it("serves a thumbnail URL only once the thumbnail is marked ready", async () => {
    const fixture = await buildFixture();
    const { app, storage } = freshApp();
    const body = Buffer.alloc(16, 3);
    const createResponse = await v1(
      app,
      `/workspaces/${fixture.workspaceId}/assets`,
      fixture.owner,
      {
        method: "POST",
        headers: { "idempotency-key": randomUUID() },
        body: multipartBody("thumb.png", "image/png", body),
      },
    );
    const created = (await createResponse.json()) as { id: string };

    const notReady = await v1(app, `/assets/${created.id}/thumbnail`, fixture.owner);
    expect(notReady.status).toBe(400);

    const thumbnailObjectKey = `workspace/${fixture.workspaceId}/assets/${created.id}/thumbnail.webp`;
    const thumbnailBody = Buffer.from("fake-webp-bytes");
    const { createHash } = await import("node:crypto");
    await storage.put({
      key: thumbnailObjectKey,
      body: thumbnailBody,
      contentType: "image/webp",
      contentLength: thumbnailBody.byteLength,
      sha256: createHash("sha256").update(thumbnailBody).digest("hex"),
    });
    await db
      .update(assets)
      .set({
        thumbnailStatus: "ready",
        thumbnailObjectKey,
        thumbnailMimeType: "image/webp",
        thumbnailWidth: 100,
        thumbnailHeight: 100,
        thumbnailBytes: thumbnailBody.byteLength,
      })
      .where(eq(assets.id, created.id));

    const ready = await v1(app, `/assets/${created.id}/thumbnail`, fixture.owner);
    expect(ready.status).toBe(200);
    const readyBody = (await ready.json()) as { thumbnailUrl?: string; thumbnailStatus: string };
    expect(readyBody.thumbnailStatus).toBe("ready");
    expect(readyBody.thumbnailUrl).toBeTruthy();
  });
});
