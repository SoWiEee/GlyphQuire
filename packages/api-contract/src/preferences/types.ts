import type { z } from "zod";
import type {
  putThemePreferenceInputSchema,
  themePreferenceModeSchema,
  themePreferenceResultSchema,
} from "./schemas.js";

export type ThemePreferenceMode = z.infer<typeof themePreferenceModeSchema>;
export type PutThemePreferenceInput = z.infer<typeof putThemePreferenceInputSchema>;
export type ThemePreferenceResult = z.infer<typeof themePreferenceResultSchema>;
