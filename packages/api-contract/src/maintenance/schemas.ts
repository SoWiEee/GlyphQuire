import { z } from "zod";
import { JOB_TYPES, cursorSchema, jobTypeSchema } from "../jobs/schemas.js";
import {
  canonicalUuidSchema,
  cursorPaginationQuerySchema,
  pageSizeSchema,
  timestampSchema,
} from "../notes/schemas.js";

export const MAINTENANCE_CAPABILITIES = [
  "search.rebuild",
  "jobs.dead_letters",
  "asset.cleanup",
  "backup.verify",
] as const;

export const maintenanceCapabilitySchema = z.enum(MAINTENANCE_CAPABILITIES);

export const maintenanceBatchSizeSchema = z.number().int().min(1).max(100);

export const deletionConfirmationSchema = z
  .object({ confirm: z.literal("DELETE_WORKSPACE") })
  .strict();

export const deletionStatusSchema = z.enum(["pending", "processing", "completed", "failed"]);

export const deletionResponseSchema = z
  .object({
    id: canonicalUuidSchema,
    status: deletionStatusSchema,
    confirmedAt: timestampSchema,
    executeAfter: timestampSchema,
  })
  .strict();

export const maintenanceCapabilitiesResponseSchema = z
  .object({
    operator: z.boolean(),
    capabilities: z.array(maintenanceCapabilitySchema).max(MAINTENANCE_CAPABILITIES.length),
  })
  .strict()
  .superRefine((value, context) => {
    if (!value.operator && value.capabilities.length > 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["capabilities"],
        message: "Denied actors cannot receive maintenance capability names",
      });
    }
    if (new Set(value.capabilities).size !== value.capabilities.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["capabilities"],
        message: "Maintenance capabilities must be unique",
      });
    }
  });

export const maintenanceSearchRebuildRequestSchema = z
  .object({
    workspaceId: canonicalUuidSchema,
    batchSize: maintenanceBatchSizeSchema,
    cursor: cursorSchema.optional(),
  })
  .strict();

export const assetCleanupRequestSchema = z
  .object({
    workspaceId: canonicalUuidSchema,
    batchSize: maintenanceBatchSizeSchema,
    cursor: cursorSchema.optional(),
  })
  .strict();

export const maintenanceJobMutationResponseSchema = z
  .object({
    jobId: canonicalUuidSchema,
    duplicate: z.boolean(),
  })
  .strict();

export const deadLetterQuerySchema = cursorPaginationQuerySchema.extend({
  pageSize: pageSizeSchema,
  cursor: cursorSchema.optional(),
});

export const deadLetterReplayParamsSchema = z.object({ id: canonicalUuidSchema }).strict();

export const deadLetterItemSchema = z
  .object({
    id: canonicalUuidSchema,
    workspaceId: canonicalUuidSchema.nullable(),
    type: jobTypeSchema,
    attempts: z.number().int().positive(),
    maxAttempts: z.number().int().min(1).max(20),
    createdAt: timestampSchema,
    deadLetteredAt: timestampSchema,
    errorCode: z.enum(["JOB_INVALID", "JOB_FAILED"]),
  })
  .strict();

export const deadLetterResponseSchema = z
  .object({
    items: z.array(deadLetterItemSchema).max(100),
    nextCursor: cursorSchema.nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    value.items.forEach((item, index) => {
      if (item.attempts > item.maxAttempts) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["items", index, "attempts"],
          message: "Dead-letter attempts cannot exceed maxAttempts",
        });
      }
    });
  });

export const backupVerificationQuerySchema = cursorPaginationQuerySchema.extend({
  pageSize: pageSizeSchema,
  cursor: cursorSchema.optional(),
});

export const backupVerificationItemSchema = z
  .object({
    jobId: canonicalUuidSchema,
    backupId: canonicalUuidSchema,
    status: z.enum(["pending", "processing", "completed", "dead_letter"]),
    createdAt: timestampSchema,
    completedAt: timestampSchema.nullable(),
    errorCode: z.enum(["JOB_INVALID", "JOB_FAILED"]).nullable(),
  })
  .strict();

export const backupVerificationResponseSchema = z
  .object({
    items: z.array(backupVerificationItemSchema).max(100),
    nextCursor: cursorSchema.nullable(),
  })
  .strict();

// Keep this value referenced by the contract module so additions to JOB_TYPES
// cannot silently bypass the job-type validation used by maintenance diagnostics.
export const maintenanceJobTypeSchema = z.enum(JOB_TYPES);
