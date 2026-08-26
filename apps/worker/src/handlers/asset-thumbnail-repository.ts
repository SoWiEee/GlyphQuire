import { assets, type Database } from "@glyphquire/database";
import { and, eq, isNull } from "drizzle-orm";
import type { AssetThumbnailRepository, AssetThumbnailRow } from "./asset-thumbnail.js";

export class PostgresAssetThumbnailRepository implements AssetThumbnailRepository {
  constructor(private readonly db: Database) {}

  async loadActiveAsset(
    workspaceId: string,
    assetId: string,
  ): Promise<AssetThumbnailRow | undefined> {
    const [row] = await this.db
      .select({ objectKey: assets.objectKey, mimeType: assets.mimeType })
      .from(assets)
      .where(
        and(eq(assets.id, assetId), eq(assets.workspaceId, workspaceId), isNull(assets.deletedAt)),
      )
      .limit(1);
    return row;
  }

  async markReady(input: {
    workspaceId: string;
    assetId: string;
    thumbnailObjectKey: string;
    thumbnailMimeType: string;
    thumbnailWidth: number;
    thumbnailHeight: number;
    thumbnailBytes: number;
  }): Promise<void> {
    await this.db
      .update(assets)
      .set({
        thumbnailStatus: "ready",
        thumbnailObjectKey: input.thumbnailObjectKey,
        thumbnailMimeType: input.thumbnailMimeType,
        thumbnailWidth: input.thumbnailWidth,
        thumbnailHeight: input.thumbnailHeight,
        thumbnailBytes: input.thumbnailBytes,
      })
      .where(and(eq(assets.id, input.assetId), eq(assets.workspaceId, input.workspaceId)));
  }

  async markMetadataOnly(input: {
    workspaceId: string;
    assetId: string;
    reason: string;
  }): Promise<void> {
    await this.db
      .update(assets)
      .set({
        thumbnailStatus: "metadata_only",
        thumbnailObjectKey: null,
        thumbnailMimeType: null,
        thumbnailWidth: null,
        thumbnailHeight: null,
        thumbnailBytes: null,
        metadataJson: { thumbnailErrorReason: input.reason },
      })
      .where(and(eq(assets.id, input.assetId), eq(assets.workspaceId, input.workspaceId)));
  }

  async markFailed(input: { workspaceId: string; assetId: string; reason: string }): Promise<void> {
    await this.db
      .update(assets)
      .set({
        thumbnailStatus: "failed",
        thumbnailObjectKey: null,
        thumbnailMimeType: null,
        thumbnailWidth: null,
        thumbnailHeight: null,
        thumbnailBytes: null,
        metadataJson: { thumbnailErrorReason: input.reason },
      })
      .where(and(eq(assets.id, input.assetId), eq(assets.workspaceId, input.workspaceId)));
  }
}
