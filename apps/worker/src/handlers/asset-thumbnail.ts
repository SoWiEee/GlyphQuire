import { createHash } from "node:crypto";
import type { AssetThumbnailPayload, JobEnvelope } from "@glyphquire/api-contract/jobs";
import type { JobHandler } from "@glyphquire/queue";
import type { ObjectStoragePort } from "@glyphquire/storage";
import sharp from "sharp";

const THUMBNAIL_DIMENSION = 256;
const THUMBNAIL_MIME_TYPE = "image/webp";

export interface AssetThumbnailRow {
  objectKey: string;
  mimeType: string;
}

/**
 * Narrow repository seam for the thumbnail handler's asset reads/writes.
 * Keeping this separate from the full Database type lets the handler stay
 * unit-testable without a real PostgreSQL instance, and keeps the handler
 * from depending on anything beyond exactly the columns it touches.
 */
export interface AssetThumbnailRepository {
  loadActiveAsset(workspaceId: string, assetId: string): Promise<AssetThumbnailRow | undefined>;
  markReady(input: {
    workspaceId: string;
    assetId: string;
    thumbnailObjectKey: string;
    thumbnailMimeType: string;
    thumbnailWidth: number;
    thumbnailHeight: number;
    thumbnailBytes: number;
  }): Promise<void>;
  markMetadataOnly(input: {
    workspaceId: string;
    assetId: string;
    reason: string;
  }): Promise<void>;
  markFailed(input: { workspaceId: string; assetId: string; reason: string }): Promise<void>;
}

export interface AssetThumbnailLimits {
  maxSourceBytes: number;
  maxPixels: number;
  maxOutputBytes: number;
}

export interface AssetThumbnailHandlerDeps {
  repository: AssetThumbnailRepository;
  storage: ObjectStoragePort;
  limits: AssetThumbnailLimits;
  buildThumbnailObjectKey(workspaceId: string, assetId: string): string;
}

async function readAll(stream: ReadableStream<Uint8Array>, maxBytes: number): Promise<Buffer> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new Error("SOURCE_TOO_LARGE");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

/**
 * Creates the asset.thumbnail job handler. The handler never trusts the
 * asset's stored/declared MIME type: it always decodes the server-read
 * object bytes with the approved sharp decoder and derives metadata from
 * what was actually decoded. Output is always a bounded WebP raster, never
 * active content (SVG/HTML) regardless of source format.
 */
export function createAssetThumbnailHandler(
  deps: AssetThumbnailHandlerDeps,
): JobHandler<"asset.thumbnail"> {
  return async (job: JobEnvelope<"asset.thumbnail">) => {
    const payload: AssetThumbnailPayload = job.payload;
    const asset = await deps.repository.loadActiveAsset(payload.workspaceId, payload.assetId);
    if (!asset) return; // Already deleted/cleaned up; at-least-once no-op.

    let sourceBytes: Buffer;
    try {
      const stream = await deps.storage.get(asset.objectKey);
      sourceBytes = await readAll(stream, deps.limits.maxSourceBytes);
    } catch (error) {
      if (error instanceof Error && error.message === "SOURCE_TOO_LARGE") {
        await deps.repository.markFailed({
          workspaceId: payload.workspaceId,
          assetId: payload.assetId,
          reason: "source_too_large",
        });
        return;
      }
      // A transient storage failure should retry through the dispatcher.
      throw new Error("JOB_FAILED: could not read source object");
    }

    let metadata: sharp.Metadata;
    try {
      metadata = await sharp(sourceBytes, { limitInputPixels: false }).metadata();
    } catch {
      await deps.repository.markMetadataOnly({
        workspaceId: payload.workspaceId,
        assetId: payload.assetId,
        reason: "unsupported_format",
      });
      return;
    }

    const width = metadata.width ?? 0;
    const height = metadata.height ?? 0;
    if (width <= 0 || height <= 0) {
      await deps.repository.markMetadataOnly({
        workspaceId: payload.workspaceId,
        assetId: payload.assetId,
        reason: "unsupported_format",
      });
      return;
    }
    if (width * height > deps.limits.maxPixels) {
      await deps.repository.markFailed({
        workspaceId: payload.workspaceId,
        assetId: payload.assetId,
        reason: "pixel_cap_exceeded",
      });
      return;
    }

    let output: Buffer;
    try {
      output = await sharp(sourceBytes, { limitInputPixels: deps.limits.maxPixels })
        .resize(THUMBNAIL_DIMENSION, THUMBNAIL_DIMENSION, { fit: "inside", withoutEnlargement: true })
        .webp({ quality: 80 })
        .toBuffer();
    } catch {
      await deps.repository.markMetadataOnly({
        workspaceId: payload.workspaceId,
        assetId: payload.assetId,
        reason: "unsupported_format",
      });
      return;
    }

    if (output.byteLength > deps.limits.maxOutputBytes) {
      // One reduced-quality retry before giving up.
      try {
        output = await sharp(sourceBytes, { limitInputPixels: deps.limits.maxPixels })
          .resize(THUMBNAIL_DIMENSION, THUMBNAIL_DIMENSION, {
            fit: "inside",
            withoutEnlargement: true,
          })
          .webp({ quality: 40 })
          .toBuffer();
      } catch {
        await deps.repository.markMetadataOnly({
          workspaceId: payload.workspaceId,
          assetId: payload.assetId,
          reason: "unsupported_format",
        });
        return;
      }
    }
    if (output.byteLength > deps.limits.maxOutputBytes) {
      await deps.repository.markFailed({
        workspaceId: payload.workspaceId,
        assetId: payload.assetId,
        reason: "output_cap_exceeded",
      });
      return;
    }

    const thumbnailMetadata = await sharp(output).metadata();
    const thumbnailObjectKey = deps.buildThumbnailObjectKey(payload.workspaceId, payload.assetId);
    const sha256 = createHash("sha256").update(output).digest("hex");
    await deps.storage.put({
      key: thumbnailObjectKey,
      body: output,
      contentType: THUMBNAIL_MIME_TYPE,
      contentLength: output.byteLength,
      sha256,
    });

    await deps.repository.markReady({
      workspaceId: payload.workspaceId,
      assetId: payload.assetId,
      thumbnailObjectKey,
      thumbnailMimeType: THUMBNAIL_MIME_TYPE,
      thumbnailWidth: thumbnailMetadata.width ?? THUMBNAIL_DIMENSION,
      thumbnailHeight: thumbnailMetadata.height ?? THUMBNAIL_DIMENSION,
      thumbnailBytes: output.byteLength,
    });
  };
}
