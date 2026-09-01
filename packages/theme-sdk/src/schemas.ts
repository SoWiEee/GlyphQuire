import { z } from "zod";
import { iconNameSchema } from "./icons.js";

const FORBIDDEN_CSS_PATTERN = /(?:url|expression)\s*\(|javascript\s*:/i;

const safeColorSchema = z
  .string()
  .max(200)
  .refine((v) => !FORBIDDEN_CSS_PATTERN.test(v) && !v.includes("var("), {
    message: "Color value contains forbidden CSS pattern",
  });

const safeFontSchema = z
  .string()
  .max(500)
  .refine((v) => !FORBIDDEN_CSS_PATTERN.test(v), {
    message: "Font value contains forbidden CSS pattern",
  });

const safeCssLengthSchema = z.string().max(50);

export const themeTokensSchema = z
  .object({
    color: z
      .object({
        background: safeColorSchema,
        surface: safeColorSchema,
        surfaceMuted: safeColorSchema,
        foreground: safeColorSchema,
        muted: safeColorSchema,
        accent: safeColorSchema,
        accentContrast: safeColorSchema,
        border: safeColorSchema,
        success: safeColorSchema,
        warning: safeColorSchema,
        danger: safeColorSchema,
      })
      .strict(),
    typography: z
      .object({
        bodyFont: safeFontSchema,
        headingFont: safeFontSchema,
        monoFont: safeFontSchema,
      })
      .strict(),
    radius: z
      .object({
        sm: safeCssLengthSchema,
        md: safeCssLengthSchema,
        lg: safeCssLengthSchema,
      })
      .strict(),
    spacing: z.record(z.string().max(30), safeCssLengthSchema),
  })
  .strict();

export const partialThemeTokensSchema = themeTokensSchema.deepPartial();

export const themeComponentVariantsSchema = z
  .object({
    heading: z
      .object({ decoration: z.enum(["none", "sparkle", "line"]) })
      .strict()
      .optional(),
    quote: z
      .object({ variant: z.enum(["plain", "sticky", "paper"]) })
      .strict()
      .optional(),
    callout: z
      .object({
        variant: z.enum(["solid", "glass", "outline"]),
        animation: z.enum(["none", "glow", "lift"]).optional(),
      })
      .strict()
      .optional(),
    code: z
      .object({ variant: z.enum(["plain", "terminal"]) })
      .strict()
      .optional(),
    toggle: z
      .object({ variant: z.enum(["plain", "card"]) })
      .strict()
      .optional(),
    tabs: z
      .object({ variant: z.enum(["plain", "pill", "underline"]) })
      .strict()
      .optional(),
    stickyNote: z
      .object({ variant: z.enum(["plain", "paper", "neon"]) })
      .strict()
      .optional(),
  })
  .strict()
  .optional();

export const themeManifestSchema = z
  .object({
    id: z.string().min(1).max(100),
    name: z.string().min(1).max(200),
    version: z.string().min(1).max(50),
    tokens: partialThemeTokensSchema.optional(),
    darkTokens: partialThemeTokensSchema.optional(),
    components: themeComponentVariantsSchema,
  })
  .strict();

export const blockManifestSchema = z
  .object({
    name: z.string().min(1).max(100),
    version: z.number().int().positive(),
    kind: z.enum(["container", "leaf", "text"]),
  })
  .strict();

export const runtimeManifestSchema = z
  .object({
    name: z.string().min(1).max(100),
    entrypoint: z.string().min(1).max(500),
  })
  .strict();

export const pluginPermissionSchema = z.string().min(1).max(100);

export const CUSTOM_BLOCK_MAX_PROPS = 24;
export const CUSTOM_BLOCK_MAX_ENUM_VALUES = 32;
export const CUSTOM_BLOCK_MAX_STRING_LENGTH = 500;
export const CUSTOM_BLOCK_PRESETS = [
  "callout",
  "card",
  "notice",
  "rating",
  "stat",
  "steps",
  "table",
  "timeline",
] as const;
export const CUSTOM_BLOCK_VARIANTS = ["solid", "outline", "muted", "compact", "accent"] as const;
export const CUSTOM_BLOCK_CAPABILITIES = ["static", "interactive-ui"] as const;
export const CUSTOM_BLOCK_CONTENT_POLICIES = ["none", "optional", "required"] as const;
const RESERVED_CUSTOM_BLOCK_NAMES = new Set([
  "callout",
  "sticky",
  "toggle",
  "tabs",
  "tab",
  "columns",
  "column",
  "p5",
  "canvas",
]);

const customBlockNameSchema = z
  .string()
  .regex(/^[a-z][a-z0-9-]{0,63}$/u)
  .refine((name) => !RESERVED_CUSTOM_BLOCK_NAMES.has(name), {
    message: "Custom Block name is reserved by a built-in block",
  });

const boundedStringValues = z
  .array(z.string().max(CUSTOM_BLOCK_MAX_STRING_LENGTH))
  .min(1)
  .max(CUSTOM_BLOCK_MAX_ENUM_VALUES)
  .refine((values) => new Set(values).size === values.length, {
    message: "Enum values must be unique",
  });
const boundedNumberValues = z
  .array(z.number().finite())
  .min(1)
  .max(CUSTOM_BLOCK_MAX_ENUM_VALUES)
  .refine((values) => new Set(values).size === values.length, {
    message: "Enum values must be unique",
  });
const boundedBooleanValues = z
  .array(z.boolean())
  .min(1)
  .max(CUSTOM_BLOCK_MAX_ENUM_VALUES)
  .refine((values) => new Set(values).size === values.length, {
    message: "Enum values must be unique",
  });

const customBlockStringPropSchema = z
  .object({
    type: z.literal("string"),
    required: z.boolean(),
    maxLength: z.number().int().min(1).max(CUSTOM_BLOCK_MAX_STRING_LENGTH),
    enum: boundedStringValues.optional(),
    default: z.string().max(CUSTOM_BLOCK_MAX_STRING_LENGTH).optional(),
  })
  .strict()
  .superRefine((descriptor, context) => {
    if (
      descriptor.default !== undefined &&
      descriptor.enum &&
      !descriptor.enum.includes(descriptor.default)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Default must be one of enum values",
      });
    }
    if (descriptor.default !== undefined && descriptor.default.length > descriptor.maxLength) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "Default exceeds maxLength" });
    }
  });

const customBlockNumberPropSchema = z
  .object({
    type: z.literal("number"),
    required: z.boolean(),
    minimum: z.number().finite(),
    maximum: z.number().finite(),
    enum: boundedNumberValues.optional(),
    default: z.number().finite().optional(),
  })
  .strict()
  .superRefine((descriptor, context) => {
    if (descriptor.minimum > descriptor.maximum) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "minimum must not exceed maximum" });
    }
    if (
      descriptor.default !== undefined &&
      (descriptor.default < descriptor.minimum || descriptor.default > descriptor.maximum)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Default is outside the allowed range",
      });
    }
    if (
      descriptor.default !== undefined &&
      descriptor.enum &&
      !descriptor.enum.includes(descriptor.default)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Default must be one of enum values",
      });
    }
    if (
      descriptor.enum?.some((value) => value < descriptor.minimum || value > descriptor.maximum)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Enum value is outside the allowed range",
      });
    }
  });

const customBlockBooleanPropSchema = z
  .object({
    type: z.literal("boolean"),
    required: z.boolean(),
    enum: boundedBooleanValues.optional(),
    default: z.boolean().optional(),
  })
  .strict()
  .superRefine((descriptor, context) => {
    if (
      descriptor.default !== undefined &&
      descriptor.enum &&
      !descriptor.enum.includes(descriptor.default)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Default must be one of enum values",
      });
    }
  });

export const customBlockPropSchema = z.union([
  customBlockStringPropSchema,
  customBlockNumberPropSchema,
  customBlockBooleanPropSchema,
]);

const customBlockPropsSchema = z
  .record(z.string().regex(/^[a-z][a-z0-9-]{0,31}$/u), customBlockPropSchema)
  .refine((props) => Object.keys(props).length <= CUSTOM_BLOCK_MAX_PROPS, {
    message: `A Custom Block may define at most ${CUSTOM_BLOCK_MAX_PROPS} props`,
  });

const tokenPathSchema = z
  .string()
  .regex(/^(color|typography|radius|spacing)\.[a-z][a-zA-Z0-9-]*$/u)
  .max(80);

export const customBlockDefinitionSchema = z
  .object({
    name: customBlockNameSchema,
    version: z.number().int().positive(),
    kind: z.enum(["container", "leaf", "text"]),
    propsSchema: customBlockPropsSchema,
    contentPolicy: z.enum(CUSTOM_BLOCK_CONTENT_POLICIES),
    icon: iconNameSchema,
    preset: z.enum(CUSTOM_BLOCK_PRESETS),
    variant: z.enum(CUSTOM_BLOCK_VARIANTS).optional(),
    tokenMapping: z
      .record(z.string().regex(/^[a-z][a-z0-9-]{0,31}$/u), tokenPathSchema)
      .refine((mapping) => Object.keys(mapping).length <= 8, {
        message: "A Custom Block may map at most 8 theme tokens",
      })
      .optional(),
    capabilities: z
      .array(z.enum(CUSTOM_BLOCK_CAPABILITIES))
      .min(1)
      .max(CUSTOM_BLOCK_CAPABILITIES.length)
      .refine((values) => new Set(values).size === values.length, {
        message: "Capabilities must be unique",
      }),
  })
  .strict()
  .superRefine((definition, context) => {
    if (definition.kind === "leaf" && definition.contentPolicy !== "none") {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["contentPolicy"],
        message: "Leaf Custom Blocks cannot contain nested content",
      });
    }
    if (definition.kind === "text" && definition.contentPolicy === "required") {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["contentPolicy"],
        message: "Text Custom Blocks cannot require nested content",
      });
    }
  });

export const pluginManifestSchema = z
  .object({
    id: z.string().min(1).max(100),
    name: z.string().min(1).max(200),
    version: z.string().min(1).max(50),
    apiVersion: z.string().min(1).max(20),
    blocks: z.array(blockManifestSchema).optional(),
    themes: z.array(themeManifestSchema).optional(),
    runtimes: z.array(runtimeManifestSchema).optional(),
    permissions: z.array(pluginPermissionSchema).optional(),
  })
  .strict();

export function isValidColorValue(value: string): boolean {
  return !FORBIDDEN_CSS_PATTERN.test(value) && !value.includes("var(");
}

export function isValidFontValue(value: string): boolean {
  return !FORBIDDEN_CSS_PATTERN.test(value);
}
