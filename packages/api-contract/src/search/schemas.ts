import { z } from "zod";
import {
  canonicalUuidSchema,
  noteTitleSchema,
  pageSizeSchema,
  timestampSchema,
} from "../notes/schemas.js";
import { phase5CursorSchema } from "../jobs/schemas.js";

export const MAX_SEARCH_QUERY_BYTES = 512;

export const searchQueryTextSchema = z
  .string()
  .min(1)
  .superRefine((value, context) => {
    if (new TextEncoder().encode(value).byteLength > MAX_SEARCH_QUERY_BYTES) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Search query must be at most ${MAX_SEARCH_QUERY_BYTES} UTF-8 bytes`,
      });
    }
  });

export const searchQuerySchema = z
  .object({
    workspaceId: canonicalUuidSchema,
    q: searchQueryTextSchema,
    cursor: phase5CursorSchema.optional(),
    pageSize: pageSizeSchema,
  })
  .strict();

export const searchResultSchema = z
  .object({
    noteId: canonicalUuidSchema,
    workspaceId: canonicalUuidSchema,
    revision: z.number().int().positive(),
    title: noteTitleSchema,
    snippet: z.string().max(1000),
    score: z.number().finite().nonnegative().optional(),
    updatedAt: timestampSchema,
  })
  .strict();

export const searchResponseSchema = z
  .object({
    items: z.array(searchResultSchema).max(100),
    nextCursor: phase5CursorSchema.nullable(),
  })
  .strict();
