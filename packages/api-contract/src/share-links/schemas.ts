import { z } from "zod";
import {
  canonicalUuidSchema,
  markdownSchema,
  noteTitleSchema,
  timestampSchema,
} from "../notes/schemas.js";

export const shareTokenSchema = z
  .string()
  .min(43)
  .max(256)
  .regex(/^[A-Za-z0-9_-]+$/);

export const createShareLinkInputSchema = z
  .object({ expiresAt: timestampSchema.nullable().optional() })
  .strict();

export const shareLinkResponseSchema = z
  .object({
    id: canonicalUuidSchema,
    workspaceId: canonicalUuidSchema,
    noteId: canonicalUuidSchema,
    token: shareTokenSchema,
    url: z.string().url(),
    expiresAt: timestampSchema.nullable(),
    createdAt: timestampSchema,
  })
  .strict();

export const sharedNoteResponseSchema = z
  .object({
    noteId: canonicalUuidSchema,
    title: noteTitleSchema,
    contentMarkdown: markdownSchema,
    schemaVersion: z.number().int().positive(),
    updatedAt: timestampSchema,
  })
  .strict();
