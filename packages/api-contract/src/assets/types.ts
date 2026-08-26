import type { z } from "zod";
import type { assetResponseSchema, assetThumbnailStatusSchema } from "./schemas.js";

export type AssetThumbnailStatus = z.infer<typeof assetThumbnailStatusSchema>;
export type AssetResponse = z.infer<typeof assetResponseSchema>;
