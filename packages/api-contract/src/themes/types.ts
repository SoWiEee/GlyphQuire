import type { z } from "zod";
import type {
  createThemeInputSchema,
  updateThemeInputSchema,
  setUserThemeInputSchema,
  themeResultSchema,
  themeListResultSchema,
  userThemeResultSchema,
} from "./schemas.js";

export type CreateThemeInput = z.infer<typeof createThemeInputSchema>;
export type UpdateThemeInput = z.infer<typeof updateThemeInputSchema>;
export type SetUserThemeInput = z.infer<typeof setUserThemeInputSchema>;
export type ThemeResult = z.infer<typeof themeResultSchema>;
export type ThemeListResult = z.infer<typeof themeListResultSchema>;
export type UserThemeResult = z.infer<typeof userThemeResultSchema>;
