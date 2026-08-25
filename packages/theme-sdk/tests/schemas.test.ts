import { describe, expect, it } from "vitest";
import {
  themeTokensSchema,
  themeComponentVariantsSchema,
  themeManifestSchema,
  pluginManifestSchema,
} from "../src/index.js";

describe("themeTokensSchema", () => {
  it("accepts valid complete tokens", () => {
    const result = themeTokensSchema.safeParse({
      color: {
        background: "#fff",
        foreground: "#000",
        muted: "#999",
        accent: "#00f",
        border: "#ccc",
      },
      typography: {
        bodyFont: "Inter, sans-serif",
        headingFont: "Inter, sans-serif",
        monoFont: "monospace",
      },
      radius: { sm: "0.25rem", md: "0.5rem", lg: "1rem" },
      spacing: { xs: "0.25rem", sm: "0.5rem" },
    });
    expect(result.success).toBe(true);
  });

  it("rejects color values containing url()", () => {
    const result = themeTokensSchema.safeParse({
      color: {
        background: "url(evil)",
        foreground: "#000",
        muted: "#999",
        accent: "#00f",
        border: "#ccc",
      },
      typography: { bodyFont: "sans-serif", headingFont: "sans-serif", monoFont: "monospace" },
      radius: { sm: "0.25rem", md: "0.5rem", lg: "1rem" },
      spacing: {},
    });
    expect(result.success).toBe(false);
  });

  it("rejects font values containing url()", () => {
    const result = themeTokensSchema.safeParse({
      color: {
        background: "#fff",
        foreground: "#000",
        muted: "#999",
        accent: "#00f",
        border: "#ccc",
      },
      typography: { bodyFont: "url(evil)", headingFont: "sans-serif", monoFont: "monospace" },
      radius: { sm: "0.25rem", md: "0.5rem", lg: "1rem" },
      spacing: {},
    });
    expect(result.success).toBe(false);
  });
});

describe("themeComponentVariantsSchema", () => {
  it("accepts valid variants", () => {
    const result = themeComponentVariantsSchema.safeParse({
      heading: { decoration: "sparkle" },
      callout: { variant: "glass", animation: "glow" },
    });
    expect(result.success).toBe(true);
  });

  it("rejects invalid variant values", () => {
    const result = themeComponentVariantsSchema.safeParse({
      heading: { decoration: "invalid-value" },
    });
    expect(result.success).toBe(false);
  });
});

describe("themeManifestSchema", () => {
  it("accepts a minimal theme manifest", () => {
    const result = themeManifestSchema.safeParse({
      id: "my-theme",
      name: "My Theme",
      version: "1.0.0",
    });
    expect(result.success).toBe(true);
  });

  it("accepts a full theme manifest with tokens and darkTokens", () => {
    const result = themeManifestSchema.safeParse({
      id: "my-theme",
      name: "My Theme",
      version: "1.0.0",
      tokens: {
        color: {
          background: "#111",
          foreground: "#eee",
          muted: "#888",
          accent: "#00f",
          border: "#444",
        },
      },
      darkTokens: {
        color: {
          background: "#000",
          foreground: "#fff",
          muted: "#aaa",
          accent: "#0af",
          border: "#333",
        },
      },
      components: {
        heading: { decoration: "line" },
      },
    });
    expect(result.success).toBe(true);
  });
});

describe("pluginManifestSchema", () => {
  it("accepts a plugin manifest with themes", () => {
    const result = pluginManifestSchema.safeParse({
      id: "my-plugin",
      name: "My Plugin",
      version: "1.0.0",
      apiVersion: "1",
      themes: [{ id: "t1", name: "Theme 1", version: "1.0.0" }],
    });
    expect(result.success).toBe(true);
  });

  it("accepts empty optional fields", () => {
    const result = pluginManifestSchema.safeParse({
      id: "my-plugin",
      name: "My Plugin",
      version: "1.0.0",
      apiVersion: "1",
    });
    expect(result.success).toBe(true);
  });
});
