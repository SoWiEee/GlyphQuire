import { z } from "zod";
import { canonicalUuidSchema, timestampSchema } from "../notes/schemas.js";

export const importStatusSchema = z.enum([
  "staging",
  "pending",
  "processing",
  "completed",
  "failed",
  "expired",
]);
export const exportStatusSchema = z.enum([
  "pending",
  "processing",
  "completed",
  "failed",
  "expired",
]);
export const exportFormatSchema = z.enum(["markdown", "zip", "html", "plain-text", "ast-json"]);

export const transferProgressSchema = z
  .object({
    completedItems: z.number().int().nonnegative().max(256),
    totalItems: z.number().int().nonnegative().max(256),
    processedBytes: z
      .number()
      .int()
      .nonnegative()
      .max(100 * 1024 * 1024),
    totalBytes: z
      .number()
      .int()
      .nonnegative()
      .max(100 * 1024 * 1024),
  })
  .strict()
  .refine(
    (value) => value.completedItems <= value.totalItems && value.processedBytes <= value.totalBytes,
    "Transfer progress cannot exceed its bounded total",
  );

export const importJobResultSchema = z
  .object({
    id: canonicalUuidSchema,
    workspaceId: canonicalUuidSchema,
    status: importStatusSchema,
    noteId: canonicalUuidSchema.optional(),
    progress: transferProgressSchema,
    errorCode: z.literal("IMPORT_INVALID").optional(),
  })
  .strict();

export const exportScopeSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("workspace"), workspaceId: canonicalUuidSchema }).strict(),
  z
    .object({
      type: z.literal("note"),
      workspaceId: canonicalUuidSchema,
      noteId: canonicalUuidSchema,
    })
    .strict(),
]);

export const exportResultSchema = z
  .object({
    id: canonicalUuidSchema,
    workspaceId: canonicalUuidSchema,
    status: exportStatusSchema,
    format: exportFormatSchema,
    scope: exportScopeSchema,
    createdAt: timestampSchema,
    expiresAt: timestampSchema,
    downloadUrl: z.string().url().optional(),
    errorCode: z.literal("EXPORT_FAILED").optional(),
  })
  .strict();
