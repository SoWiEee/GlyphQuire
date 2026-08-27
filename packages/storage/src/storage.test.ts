import { createHash, randomUUID } from "node:crypto";
import { CreateBucketCommand, S3Client } from "@aws-sdk/client-s3";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { ObjectStorageError } from "./port.js";
import { S3ObjectStorage } from "./s3.js";
import { InMemoryObjectStorage } from "./fake.js";

const endpoint = process.env.TEST_S3_ENDPOINT ?? "http://localhost:9000";
const accessKeyId = process.env.TEST_S3_ACCESS_KEY ?? "glyphquire";
const secretAccessKey = process.env.TEST_S3_SECRET_KEY ?? "glyphquire_dev";
const region = process.env.TEST_S3_REGION ?? "us-east-1";
const bucket = `glyphquire-storage-test-${randomUUID().replaceAll("-", "").slice(0, 20)}`;

async function readAll(stream: ReadableStream<Uint8Array>): Promise<Buffer> {
  const chunks: Uint8Array[] = [];
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) chunks.push(value);
  }
  return Buffer.concat(chunks);
}

function sha256Of(body: Buffer): string {
  return createHash("sha256").update(body).digest("hex");
}

describe("S3ObjectStorage against MinIO", () => {
  let storage: S3ObjectStorage;
  let admin: S3Client;
  let reachable = true;

  beforeAll(async () => {
    admin = new S3Client({
      endpoint,
      region,
      forcePathStyle: true,
      credentials: { accessKeyId, secretAccessKey },
    });
    try {
      await admin.send(new CreateBucketCommand({ Bucket: bucket }));
    } catch {
      reachable = false;
    }
    storage = new S3ObjectStorage({
      endpoint,
      region,
      accessKeyId,
      secretAccessKey,
      bucket,
      forcePathStyle: true,
    });
  }, 30_000);

  afterAll(() => {
    storage.destroy();
    admin.destroy();
  });

  it("destroys its owned S3 client once", () => {
    const client = (storage as unknown as { client: S3Client }).client;
    const destroy = vi.spyOn(client, "destroy");

    storage.destroy();
    storage.destroy();

    expect(destroy).toHaveBeenCalledTimes(1);
  });

  it("round-trips an object through put/get/delete", async () => {
    if (!reachable) return;
    const body = Buffer.from("hello glyphquire");
    const key = `workspace/${randomUUID()}/assets/${randomUUID()}/original`;
    const result = await storage.put({
      key,
      body,
      contentType: "text/plain",
      contentLength: body.byteLength,
      sha256: sha256Of(body),
    });
    expect(result.etag).toBeTruthy();

    const stream = await storage.get(key);
    expect((await readAll(stream)).toString("utf8")).toBe("hello glyphquire");

    await storage.delete(key);
    await expect(storage.get(key)).rejects.toBeInstanceOf(ObjectStorageError);
  });

  it("rejects a content length mismatch before writing", async () => {
    if (!reachable) return;
    const body = Buffer.from("mismatched");
    await expect(
      storage.put({
        key: `workspace/${randomUUID()}/assets/${randomUUID()}/original`,
        body,
        contentType: "text/plain",
        contentLength: body.byteLength + 1,
        sha256: sha256Of(body),
      }),
    ).rejects.toBeInstanceOf(ObjectStorageError);
  });

  it("rejects an invalid sha256 shape before writing", async () => {
    if (!reachable) return;
    const body = Buffer.from("bad hash");
    await expect(
      storage.put({
        key: `workspace/${randomUUID()}/assets/${randomUUID()}/original`,
        body,
        contentType: "text/plain",
        contentLength: body.byteLength,
        sha256: "not-a-hash",
      }),
    ).rejects.toBeInstanceOf(ObjectStorageError);
  });

  it("rejects a traversal or absolute object key", async () => {
    if (!reachable) return;
    const body = Buffer.from("x");
    await expect(
      storage.put({
        key: "../escape",
        body,
        contentType: "text/plain",
        contentLength: body.byteLength,
        sha256: sha256Of(body),
      }),
    ).rejects.toBeInstanceOf(ObjectStorageError);
  });

  it("creates a bounded, expiring download URL", async () => {
    if (!reachable) return;
    const body = Buffer.from("downloadable");
    const key = `workspace/${randomUUID()}/assets/${randomUUID()}/original`;
    await storage.put({
      key,
      body,
      contentType: "text/plain",
      contentLength: body.byteLength,
      sha256: sha256Of(body),
    });
    const url = await storage.createDownloadUrl(key, 60);
    expect(url).toContain(key);
    expect(url).toMatch(/^https?:\/\//);
    await expect(storage.createDownloadUrl(key, 0)).rejects.toBeInstanceOf(ObjectStorageError);
    await expect(storage.createDownloadUrl(key, 3_601)).rejects.toBeInstanceOf(ObjectStorageError);
  });
});

describe("InMemoryObjectStorage", () => {
  it("provides a safe no-op destroy method", () => {
    const storage = new InMemoryObjectStorage();

    expect(() => storage.destroy()).not.toThrow();
  });

  it("round-trips and rejects a checksum mismatch", async () => {
    const storage = new InMemoryObjectStorage();
    const body = Buffer.from("in-memory");
    const key = "workspace/w/assets/a/original";
    await storage.put({
      key,
      body,
      contentType: "text/plain",
      contentLength: body.byteLength,
      sha256: sha256Of(body),
    });
    expect((await readAll(await storage.get(key))).toString("utf8")).toBe("in-memory");

    await expect(
      storage.put({
        key: "workspace/w/assets/b/original",
        body,
        contentType: "text/plain",
        contentLength: body.byteLength,
        sha256: "0".repeat(64),
      }),
    ).rejects.toBeInstanceOf(ObjectStorageError);
  });

  it("invokes fault-injection hooks around put and delete", async () => {
    const events: string[] = [];
    const storage = new InMemoryObjectStorage({
      beforePut: () => {
        events.push("beforePut");
      },
      afterPut: () => {
        events.push("afterPut");
      },
      beforeDelete: () => {
        events.push("beforeDelete");
      },
    });
    const body = Buffer.from("hooked");
    const key = "workspace/w/assets/c/original";
    await storage.put({
      key,
      body,
      contentType: "text/plain",
      contentLength: body.byteLength,
      sha256: sha256Of(body),
    });
    await storage.delete(key);
    expect(events).toEqual(["beforePut", "afterPut", "beforeDelete"]);
  });

  it("rejects put failure injected via afterPut without corrupting prior state", async () => {
    const storage = new InMemoryObjectStorage({
      afterPut: () => {
        throw new Error("simulated post-write failure");
      },
    });
    const body = Buffer.from("fails-after-write");
    const key = "workspace/w/assets/d/original";
    await expect(
      storage.put({
        key,
        body,
        contentType: "text/plain",
        contentLength: body.byteLength,
        sha256: sha256Of(body),
      }),
    ).rejects.toThrow("simulated post-write failure");
    // The object was durably written to storage even though the caller's
    // orchestration failed afterward — exercising object-written/DB-failed
    // compensation paths at the service layer.
    expect(storage.has(key)).toBe(true);
  });
});
