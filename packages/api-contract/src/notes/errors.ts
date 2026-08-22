import { z } from "zod";
import { canonicalUuidSchema, markdownSchema, revisionSchema } from "./schemas.js";

export const API_ERROR_CODES = [
  "NOTE_NOT_FOUND",
  "REVISION_CONFLICT",
  "DOCUMENT_INVALID",
  "DOCUMENT_TOO_LARGE",
  "OPERATION_REUSED",
  "RATE_LIMITED",
  "SERVICE_UNAVAILABLE",
] as const;

export const apiErrorCodeSchema = z.enum(API_ERROR_CODES);

const requestIdSchema = z.string().min(1);

export const apiErrorEnvelopeSchema = z
  .object({
    error: z
      .object({
        code: apiErrorCodeSchema,
        message: z.string(),
        requestId: requestIdSchema,
      })
      .strict(),
  })
  .strict();

export const noteConflictSchema = z
  .object({
    code: z.literal("REVISION_CONFLICT"),
    noteId: canonicalUuidSchema,
    serverRevision: revisionSchema,
    serverMarkdown: markdownSchema,
    serverUpdatedAt: z.string().datetime({ offset: true }),
    lastEditedBy: z
      .object({
        displayName: z.string().min(1),
      })
      .strict()
      .nullable(),
    requestId: requestIdSchema,
  })
  .strict();
