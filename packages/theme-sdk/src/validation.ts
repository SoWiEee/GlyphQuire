import { themeManifestSchema, isValidColorValue, isValidFontValue } from "./schemas.js";
import type { ThemeManifest } from "./types.js";

export interface ValidationOk {
  readonly ok: true;
  readonly value: ThemeManifest;
}

export interface ValidationError {
  readonly ok: false;
  readonly errors: readonly string[];
}

export type ValidationResult = ValidationOk | ValidationError;

export function validateThemeManifest(input: unknown): ValidationResult {
  const result = themeManifestSchema.safeParse(input);
  if (result.success) {
    return { ok: true, value: result.data };
  }
  return {
    ok: false,
    errors: result.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`),
  };
}

export { isValidColorValue as validateColorValue, isValidFontValue as validateFontValue };
