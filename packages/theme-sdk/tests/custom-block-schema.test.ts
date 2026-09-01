import { describe, expect, it } from "vitest";
import {
  CUSTOM_BLOCK_MAX_ENUM_VALUES,
  CUSTOM_BLOCK_MAX_PROPS,
  CUSTOM_BLOCK_MAX_STRING_LENGTH,
  CUSTOM_BLOCK_PRESETS,
  customBlockDefinitionSchema,
} from "../src/index.js";

const validDefinition = {
  name: "reading-score",
  version: 1,
  kind: "container",
  propsSchema: {
    label: {
      type: "string",
      required: true,
      maxLength: 120,
      enum: ["Clarity", "Depth"],
    },
    score: {
      type: "number",
      required: true,
      minimum: 0,
      maximum: 5,
      enum: [0, 1, 2, 3, 4, 5],
    },
    featured: {
      type: "boolean",
      required: false,
      default: false,
    },
  },
  contentPolicy: "optional",
  icon: "check",
  preset: "rating",
  variant: "solid",
  tokenMapping: {
    background: "color.surface",
    foreground: "color.foreground",
    accent: "color.accent",
    border: "color.border",
  },
  capabilities: ["static", "interactive-ui"],
} as const;

describe("customBlockDefinitionSchema", () => {
  it("accepts a strict, bounded declarative definition", () => {
    expect(customBlockDefinitionSchema.parse(validDefinition)).toEqual(validDefinition);
    expect(CUSTOM_BLOCK_PRESETS).toContain("rating");
  });

  it.each(["callout", "sticky", "toggle", "tabs", "tab", "columns", "column", "p5", "canvas"])(
    "rejects reserved built-in name %s",
    (name) => {
      expect(customBlockDefinitionSchema.safeParse({ ...validDefinition, name }).success).toBe(
        false,
      );
    },
  );

  it("rejects executable payload fields and unsupported capabilities", () => {
    for (const extra of [
      { render: "() => fetch('/secrets')" },
      { html: "<script>alert(1)</script>" },
      { css: "background: url(https://attacker.invalid)" },
      { url: "javascript:alert(1)" },
    ]) {
      expect(customBlockDefinitionSchema.safeParse({ ...validDefinition, ...extra }).success).toBe(
        false,
      );
    }

    expect(
      customBlockDefinitionSchema.safeParse({
        ...validDefinition,
        capabilities: ["sandbox-runtime"],
      }).success,
    ).toBe(false);
    expect(
      customBlockDefinitionSchema.safeParse({
        ...validDefinition,
        capabilities: ["network-request"],
      }).success,
    ).toBe(false);
  });

  it("rejects unknown JSON-schema keywords and unbounded scalar descriptors", () => {
    expect(
      customBlockDefinitionSchema.safeParse({
        ...validDefinition,
        propsSchema: {
          label: {
            type: "string",
            required: true,
            maxLength: 120,
            pattern: ".*",
          },
        },
      }).success,
    ).toBe(false);
    expect(
      customBlockDefinitionSchema.safeParse({
        ...validDefinition,
        propsSchema: { label: { type: "string", required: true } },
      }).success,
    ).toBe(false);
    expect(
      customBlockDefinitionSchema.safeParse({
        ...validDefinition,
        propsSchema: { score: { type: "number", required: true, minimum: 0 } },
      }).success,
    ).toBe(false);
  });

  it("enforces descriptor values, enum uniqueness, and global complexity bounds", () => {
    expect(
      customBlockDefinitionSchema.safeParse({
        ...validDefinition,
        propsSchema: {
          label: {
            type: "string",
            required: false,
            maxLength: 3,
            default: "four",
          },
        },
      }).success,
    ).toBe(false);
    expect(
      customBlockDefinitionSchema.safeParse({
        ...validDefinition,
        propsSchema: {
          score: {
            type: "number",
            required: false,
            minimum: 5,
            maximum: 1,
          },
        },
      }).success,
    ).toBe(false);
    expect(
      customBlockDefinitionSchema.safeParse({
        ...validDefinition,
        propsSchema: {
          featured: {
            type: "boolean",
            required: false,
            enum: [true, true],
          },
        },
      }).success,
    ).toBe(false);

    const tooManyProps = Object.fromEntries(
      Array.from({ length: CUSTOM_BLOCK_MAX_PROPS + 1 }, (_, index) => [
        `field-${index}`,
        { type: "boolean", required: false },
      ]),
    );
    expect(
      customBlockDefinitionSchema.safeParse({
        ...validDefinition,
        propsSchema: tooManyProps,
      }).success,
    ).toBe(false);

    expect(
      customBlockDefinitionSchema.safeParse({
        ...validDefinition,
        propsSchema: {
          label: {
            type: "string",
            required: false,
            maxLength: CUSTOM_BLOCK_MAX_STRING_LENGTH + 1,
          },
        },
      }).success,
    ).toBe(false);
    expect(
      customBlockDefinitionSchema.safeParse({
        ...validDefinition,
        propsSchema: {
          label: {
            type: "string",
            required: false,
            maxLength: 20,
            enum: Array.from({ length: CUSTOM_BLOCK_MAX_ENUM_VALUES + 1 }, (_, index) =>
              String(index),
            ),
          },
        },
      }).success,
    ).toBe(false);
  });

  it("rejects invalid names, presentation values, duplicate capabilities, and nested leaf content", () => {
    for (const patch of [
      { name: "Bad_Name" },
      { icon: "<svg>" },
      { preset: "custom-vue" },
      { variant: "url(javascript:alert(1))" },
      { tokenMapping: { background: "url(https://attacker.invalid)" } },
      { capabilities: ["static", "static"] },
      { kind: "leaf", contentPolicy: "optional" },
      { kind: "text", contentPolicy: "required" },
    ]) {
      expect(customBlockDefinitionSchema.safeParse({ ...validDefinition, ...patch }).success).toBe(
        false,
      );
    }
  });
});
