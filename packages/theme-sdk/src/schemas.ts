import { z } from "zod";

const FORBIDDEN_CSS_PATTERN = /(?:url|expression)\s*\(|javascript\s*:/i;

const safeColorSchema = z.string().max(200).refine(
  (v) => !FORBIDDEN_CSS_PATTERN.test(v) && !v.includes("var("),
  { message: "Color value contains forbidden CSS pattern" },
);

const safeFontSchema = z.string().max(500).refine(
  (v) => !FORBIDDEN_CSS_PATTERN.test(v),
  { message: "Font value contains forbidden CSS pattern" },
);

const safeCssLengthSchema = z.string().max(50);

export const themeTokensSchema = z.object({
  color: z.object({
    background: safeColorSchema,
    foreground: safeColorSchema,
    muted: safeColorSchema,
    accent: safeColorSchema,
    border: safeColorSchema,
  }).strict(),
  typography: z.object({
    bodyFont: safeFontSchema,
    headingFont: safeFontSchema,
    monoFont: safeFontSchema,
  }).strict(),
  radius: z.object({
    sm: safeCssLengthSchema,
    md: safeCssLengthSchema,
    lg: safeCssLengthSchema,
  }).strict(),
  spacing: z.record(z.string().max(30), safeCssLengthSchema),
}).strict();

export const partialThemeTokensSchema = themeTokensSchema.deepPartial();

export const themeComponentVariantsSchema = z.object({
  heading: z.object({ decoration: z.enum(["none", "sparkle", "line"]) }).strict().optional(),
  quote: z.object({ variant: z.enum(["plain", "sticky", "paper"]) }).strict().optional(),
  callout: z.object({
    variant: z.enum(["solid", "glass", "outline"]),
    animation: z.enum(["none", "glow", "lift"]).optional(),
  }).strict().optional(),
  code: z.object({ variant: z.enum(["plain", "terminal"]) }).strict().optional(),
  toggle: z.object({ variant: z.enum(["plain", "card"]) }).strict().optional(),
  tabs: z.object({ variant: z.enum(["plain", "pill", "underline"]) }).strict().optional(),
  stickyNote: z.object({ variant: z.enum(["plain", "paper", "neon"]) }).strict().optional(),
}).strict().optional();

export const themeManifestSchema = z.object({
  id: z.string().min(1).max(100),
  name: z.string().min(1).max(200),
  version: z.string().min(1).max(50),
  tokens: partialThemeTokensSchema.optional(),
  darkTokens: partialThemeTokensSchema.optional(),
  components: themeComponentVariantsSchema,
}).strict();

export const blockManifestSchema = z.object({
  name: z.string().min(1).max(100),
  version: z.number().int().positive(),
  kind: z.enum(["container", "leaf", "text"]),
}).strict();

export const runtimeManifestSchema = z.object({
  name: z.string().min(1).max(100),
  entrypoint: z.string().min(1).max(500),
}).strict();

export const pluginPermissionSchema = z.string().min(1).max(100);

export const pluginManifestSchema = z.object({
  id: z.string().min(1).max(100),
  name: z.string().min(1).max(200),
  version: z.string().min(1).max(50),
  apiVersion: z.string().min(1).max(20),
  blocks: z.array(blockManifestSchema).optional(),
  themes: z.array(themeManifestSchema).optional(),
  runtimes: z.array(runtimeManifestSchema).optional(),
  permissions: z.array(pluginPermissionSchema).optional(),
}).strict();

export function isValidColorValue(value: string): boolean {
  return !FORBIDDEN_CSS_PATTERN.test(value) && !value.includes("var(");
}

export function isValidFontValue(value: string): boolean {
  return !FORBIDDEN_CSS_PATTERN.test(value);
}
