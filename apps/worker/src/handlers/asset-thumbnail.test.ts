import { randomUUID } from "node:crypto";
import { InMemoryObjectStorage } from "@glyphquire/storage";
import sharp from "sharp";
import { beforeEach, describe, expect, it } from "vitest";
import {
  createAssetThumbnailHandler,
  type AssetThumbnailLimits,
  type AssetThumbnailRepository,
  type AssetThumbnailRow,
} from "./asset-thumbnail.js";

const GENEROUS_LIMITS: AssetThumbnailLimits = {
  maxSourceBytes: 5 * 1024 * 1024,
  maxPixels: 40_000_000,
  maxOutputBytes: 262_144,
};

class FakeRepository implements AssetThumbnailRepository {
  readonly rows = new Map<string, AssetThumbnailRow>();
  readonly readyCalls: unknown[] = [];
  readonly metadataOnlyCalls: unknown[] = [];
  readonly failedCalls: unknown[] = [];

  seed(workspaceId: string, assetId: string, row: AssetThumbnailRow) {
    this.rows.set(`${workspaceId}:${assetId}`, row);
  }

  async loadActiveAsset(workspaceId: string, assetId: string): Promise<AssetThumbnailRow | undefined> {
    return this.rows.get(`${workspaceId}:${assetId}`);
  }

  async markReady(input: Parameters<AssetThumbnailRepository["markReady"]>[0]): Promise<void> {
    this.readyCalls.push(input);
  }

  async markMetadataOnly(
    input: Parameters<AssetThumbnailRepository["markMetadataOnly"]>[0],
  ): Promise<void> {
    this.metadataOnlyCalls.push(input);
  }

  async markFailed(input: Parameters<AssetThumbnailRepository["markFailed"]>[0]): Promise<void> {
    this.failedCalls.push(input);
  }
}

function buildThumbnailObjectKey(workspaceId: string, assetId: string): string {
  return `workspace/${workspaceId}/assets/${assetId}/thumbnail.webp`;
}

function jobFor(workspaceId: string, assetId: string) {
  return {
    id: randomUUID(),
    workspaceId,
    type: "asset.thumbnail" as const,
    version: 1,
    attempts: 1,
    createdAt: new Date().toISOString(),
    payload: { workspaceId, assetId },
  };
}

async function pngBuffer(width: number, height: number): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 3, background: { r: 200, g: 20, b: 20 } },
  })
    .png()
    .toBuffer();
}

describe("asset.thumbnail handler", () => {
  let storage: InMemoryObjectStorage;
  let repository: FakeRepository;
  let workspaceId: string;
  let assetId: string;
  let objectKey: string;

  beforeEach(() => {
    storage = new InMemoryObjectStorage();
    repository = new FakeRepository();
    workspaceId = randomUUID();
    assetId = randomUUID();
    objectKey = `workspace/${workspaceId}/assets/${assetId}/original`;
  });

  async function putSource(body: Buffer, contentType = "image/png") {
    const { createHash } = await import("node:crypto");
    await storage.put({
      key: objectKey,
      body,
      contentType,
      contentLength: body.byteLength,
      sha256: createHash("sha256").update(body).digest("hex"),
    });
  }

  it("is a no-op when the asset no longer exists (at-least-once safety)", async () => {
    const handler = createAssetThumbnailHandler({
      repository,
      storage,
      limits: GENEROUS_LIMITS,
      buildThumbnailObjectKey,
    });
    await handler(jobFor(workspaceId, assetId), new AbortController().signal);
    expect(repository.readyCalls).toHaveLength(0);
    expect(repository.metadataOnlyCalls).toHaveLength(0);
    expect(repository.failedCalls).toHaveLength(0);
  });

  it("produces a bounded WebP thumbnail and marks the asset ready", async () => {
    repository.seed(workspaceId, assetId, { objectKey, mimeType: "image/png" });
    await putSource(await pngBuffer(300, 200));

    const handler = createAssetThumbnailHandler({
      repository,
      storage,
      limits: GENEROUS_LIMITS,
      buildThumbnailObjectKey,
    });
    await handler(jobFor(workspaceId, assetId), new AbortController().signal);

    expect(repository.readyCalls).toHaveLength(1);
    const call = repository.readyCalls[0] as {
      thumbnailObjectKey: string;
      thumbnailMimeType: string;
      thumbnailWidth: number;
      thumbnailHeight: number;
      thumbnailBytes: number;
    };
    expect(call.thumbnailMimeType).toBe("image/webp");
    expect(call.thumbnailWidth).toBeLessThanOrEqual(256);
    expect(call.thumbnailHeight).toBeLessThanOrEqual(256);
    expect(call.thumbnailBytes).toBeLessThanOrEqual(GENEROUS_LIMITS.maxOutputBytes);
    expect(storage.has(buildThumbnailObjectKey(workspaceId, assetId))).toBe(true);

    const thumbnailStream = await storage.get(buildThumbnailObjectKey(workspaceId, assetId));
    const reader = thumbnailStream.getReader();
    const chunks: Uint8Array[] = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) chunks.push(value);
    }
    const thumbnailBytes = Buffer.concat(chunks);
    expect(thumbnailBytes.subarray(0, 4).toString("latin1")).toBe("RIFF");
    expect(thumbnailBytes.subarray(8, 12).toString("latin1")).toBe("WEBP");
  });

  it("never trusts the declared MIME type -- decodes actual bytes even when the row claims image/png", async () => {
    repository.seed(workspaceId, assetId, { objectKey, mimeType: "image/png" });
    await putSource(Buffer.from("this is not actually a png"), "image/png");

    const handler = createAssetThumbnailHandler({
      repository,
      storage,
      limits: GENEROUS_LIMITS,
      buildThumbnailObjectKey,
    });
    await handler(jobFor(workspaceId, assetId), new AbortController().signal);

    expect(repository.metadataOnlyCalls).toHaveLength(1);
    expect(repository.readyCalls).toHaveLength(0);
    expect(storage.has(buildThumbnailObjectKey(workspaceId, assetId))).toBe(false);
  });

  it("marks metadata_only for an unsupported/undecodable source", async () => {
    repository.seed(workspaceId, assetId, { objectKey, mimeType: "application/octet-stream" });
    await putSource(Buffer.from([0x00, 0x01, 0x02, 0x03, 0x04]), "application/octet-stream");

    const handler = createAssetThumbnailHandler({
      repository,
      storage,
      limits: GENEROUS_LIMITS,
      buildThumbnailObjectKey,
    });
    await handler(jobFor(workspaceId, assetId), new AbortController().signal);

    expect(repository.metadataOnlyCalls).toEqual([
      { workspaceId, assetId, reason: "unsupported_format" },
    ]);
  });

  it("fails closed when the source exceeds the configured byte cap", async () => {
    repository.seed(workspaceId, assetId, { objectKey, mimeType: "image/png" });
    await putSource(await pngBuffer(300, 300));

    const handler = createAssetThumbnailHandler({
      repository,
      storage,
      limits: { ...GENEROUS_LIMITS, maxSourceBytes: 10 },
      buildThumbnailObjectKey,
    });
    await handler(jobFor(workspaceId, assetId), new AbortController().signal);

    expect(repository.failedCalls).toEqual([
      { workspaceId, assetId, reason: "source_too_large" },
    ]);
  });

  it("fails closed when the decoded pixel count exceeds the decoder cap", async () => {
    repository.seed(workspaceId, assetId, { objectKey, mimeType: "image/png" });
    await putSource(await pngBuffer(300, 300));

    const handler = createAssetThumbnailHandler({
      repository,
      storage,
      limits: { ...GENEROUS_LIMITS, maxPixels: 100 },
      buildThumbnailObjectKey,
    });
    await handler(jobFor(workspaceId, assetId), new AbortController().signal);

    expect(repository.failedCalls).toEqual([
      { workspaceId, assetId, reason: "pixel_cap_exceeded" },
    ]);
  });

  it("fails closed when even a reduced-quality thumbnail exceeds the output byte cap", async () => {
    repository.seed(workspaceId, assetId, { objectKey, mimeType: "image/png" });
    await putSource(await pngBuffer(300, 300));

    const handler = createAssetThumbnailHandler({
      repository,
      storage,
      limits: { ...GENEROUS_LIMITS, maxOutputBytes: 10 },
      buildThumbnailObjectKey,
    });
    await handler(jobFor(workspaceId, assetId), new AbortController().signal);

    expect(repository.failedCalls).toEqual([
      { workspaceId, assetId, reason: "output_cap_exceeded" },
    ]);
    expect(storage.has(buildThumbnailObjectKey(workspaceId, assetId))).toBe(false);
  });
});
