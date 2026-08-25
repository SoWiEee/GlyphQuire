import type { z } from "zod";
import type {
  themeManifestSchema,
  pluginManifestSchema,
  themeTokensSchema,
  themeComponentVariantsSchema,
  blockManifestSchema,
  runtimeManifestSchema,
} from "./schemas.js";

export type ThemeManifest = z.infer<typeof themeManifestSchema>;
export type PluginManifest = z.infer<typeof pluginManifestSchema>;
export type ThemeTokensInput = z.infer<typeof themeTokensSchema>;
export type ThemeComponentVariantsInput = z.infer<typeof themeComponentVariantsSchema>;
export type BlockManifest = z.infer<typeof blockManifestSchema>;
export type RuntimeManifest = z.infer<typeof runtimeManifestSchema>;
