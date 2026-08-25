import { z } from "zod";
import { canonicalUuidSchema, requestIdSchema } from "../notes/schemas.js";
import { partialThemeTokensSchema, themeComponentVariantsSchema } from "@glyphquire/theme-sdk";

export const themeIdParamsSchema = z
  .object({
    themeId: canonicalUuidSchema,
  })
  .strict();

export const createThemeInputSchema = z
  .object({
    operationId: requestIdSchema,
    name: z.string().min(1).max(200),
    version: z.string().min(1).max(50),
    tokens: partialThemeTokensSchema.optional(),
    darkTokens: partialThemeTokensSchema.optional(),
    components: themeComponentVariantsSchema.optional(),
  })
  .strict();

export const updateThemeInputSchema = z
  .object({
    operationId: requestIdSchema,
    baseRevision: z.number().int().positive(),
    name: z.string().min(1).max(200).optional(),
    version: z.string().min(1).max(50).optional(),
    tokens: partialThemeTokensSchema.optional(),
    darkTokens: partialThemeTokensSchema.optional(),
    components: themeComponentVariantsSchema.optional(),
  })
  .strict();

export const setUserThemeInputSchema = z
  .object({
    themeId: canonicalUuidSchema,
    customOverrides: partialThemeTokensSchema.optional(),
  })
  .strict();

export const themeResultSchema = z.object({
  id: z.string(),
  workspaceId: z.string().nullable(),
  name: z.string(),
  version: z.string(),
  tokens: z.record(z.unknown()),
  darkTokens: z.record(z.unknown()).nullable(),
  components: z.record(z.unknown()).nullable(),
  isSystem: z.boolean(),
  revision: z.number(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const themeListResultSchema = z.object({
  items: z.array(themeResultSchema),
});

export const userThemeResultSchema = z.object({
  themeId: z.string(),
  theme: themeResultSchema,
  customOverrides: z.record(z.unknown()).nullable(),
  resolvedTokens: z.record(z.string(), z.string()),
});
