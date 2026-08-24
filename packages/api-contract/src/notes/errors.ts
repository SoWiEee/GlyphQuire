import { z } from "zod";
import {
  canonicalUuidSchema,
  displayNameIdentitySchema,
  markdownSchema,
  publicErrorMessageSchema,
  requestIdSchema,
  revisionSchema,
  timestampSchema,
} from "./schemas.js";

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

export const apiErrorEnvelopeSchema = z
  .object({
    error: z
      .object({
        code: apiErrorCodeSchema,
        message: publicErrorMessageSchema,
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
    serverUpdatedAt: timestampSchema,
    lastEditedBy: displayNameIdentitySchema.nullable(),
    requestId: requestIdSchema,
  })
  .strict();
