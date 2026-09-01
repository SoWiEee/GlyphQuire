import { partialThemeTokensSchema, themeComponentVariantsSchema } from "@glyphquire/theme-sdk";
import { z } from "zod";
import { canonicalUuidSchema } from "../notes/schemas.js";

const MAX_POSTGRES_INTEGER = 2_147_483_647;
const requiredThemeComponentVariantsSchema = themeComponentVariantsSchema.unwrap();

export const themePreferenceModeSchema = z.enum(["light", "dark"]);

export const putThemePreferenceInputSchema = z
  .object({
    themeId: canonicalUuidSchema.nullable(),
    mode: themePreferenceModeSchema,
    customOverrides: partialThemeTokensSchema,
    variantOverrides: requiredThemeComponentVariantsSchema,
    baseRevision: z
      .number()
      .int()
      .min(0)
      .max(MAX_POSTGRES_INTEGER - 1),
  })
  .strict();

export const themePreferenceResultSchema = z
  .object({
    themeId: canonicalUuidSchema.nullable(),
    mode: themePreferenceModeSchema,
    customOverrides: partialThemeTokensSchema,
    variantOverrides: requiredThemeComponentVariantsSchema,
    revision: z.number().int().min(0).max(MAX_POSTGRES_INTEGER),
    updatedAt: z.string().datetime({ offset: true }),
  })
  .strict();
