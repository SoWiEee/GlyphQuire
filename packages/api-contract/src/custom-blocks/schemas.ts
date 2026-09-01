import { z } from "zod";
import { canonicalUuidSchema, requestIdSchema, timestampSchema } from "../notes/schemas.js";
import { customBlockDefinitionSchema } from "@glyphquire/theme-sdk";

export { customBlockDefinitionSchema } from "@glyphquire/theme-sdk";

export const customBlockStatusSchema = z.enum(["draft", "published"]);

export const customBlockRecordSchema = z
  .object({
    id: canonicalUuidSchema,
    workspaceId: canonicalUuidSchema,
    name: z.string().min(1).max(64),
    revision: z.number().int().positive(),
    version: z.number().int().positive(),
    status: customBlockStatusSchema,
    definition: customBlockDefinitionSchema,
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
    publishedAt: timestampSchema.nullable(),
  })
  .strict();

export const customBlockListResultSchema = z
  .object({ items: z.array(customBlockRecordSchema).max(100) })
  .strict();

export const createCustomBlockInputSchema = z
  .object({ operationId: requestIdSchema, definition: customBlockDefinitionSchema })
  .strict();

export const updateCustomBlockDraftInputSchema = z
  .object({
    operationId: requestIdSchema,
    baseRevision: z.number().int().positive(),
    definition: customBlockDefinitionSchema,
  })
  .strict();

export const publishCustomBlockInputSchema = z
  .object({ operationId: requestIdSchema, baseRevision: z.number().int().positive() })
  .strict();

export const deleteCustomBlockInputSchema = z
  .object({ operationId: requestIdSchema, baseRevision: z.number().int().positive() })
  .strict();

export const customBlockIdParamsSchema = z.object({ id: canonicalUuidSchema }).strict();
