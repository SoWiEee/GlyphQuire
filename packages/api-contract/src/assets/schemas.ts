import { z } from "zod";
import { canonicalUuidSchema, timestampSchema } from "../notes/schemas.js";

export const assetThumbnailStatusSchema = z.enum(["pending", "ready", "metadata_only", "failed"]);

const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);

export const assetResponseSchema = z
  .object({
    id: canonicalUuidSchema,
    workspaceId: canonicalUuidSchema,
    originalName: z.string().min(1).max(255),
    mimeType: z.string().min(1).max(200),
    size: z.number().int().positive(),
    sha256: sha256Schema,
    createdAt: timestampSchema,
    deletedAt: timestampSchema.nullable(),
    downloadUrl: z.string().url().optional(),
    thumbnailStatus: assetThumbnailStatusSchema,
    thumbnailMimeType: z.string().min(1).max(200).optional(),
    thumbnailWidth: z.number().int().positive().optional(),
    thumbnailHeight: z.number().int().positive().optional(),
    thumbnailBytes: z.number().int().positive().optional(),
    thumbnailUrl: z.string().url().optional(),
  })
  .strict()
  .superRefine((value, context) => {
    const metadata = [
      value.thumbnailMimeType,
      value.thumbnailWidth,
      value.thumbnailHeight,
      value.thumbnailBytes,
      value.thumbnailUrl,
    ];
    if (value.thumbnailStatus === "ready" && metadata.some((field) => field === undefined)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["thumbnailStatus"],
        message: "Ready thumbnails require complete authorized metadata",
      });
    }
    if (
      (value.thumbnailStatus === "metadata_only" || value.thumbnailStatus === "failed") &&
      metadata.some((field) => field !== undefined)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["thumbnailStatus"],
        message: "Unavailable thumbnails must omit thumbnail metadata",
      });
    }
  });

export const assetIdParamsSchema = z.object({ assetId: canonicalUuidSchema }).strict();
