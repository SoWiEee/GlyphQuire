import { describe, expect, it } from "vitest";
import {
  CUSTOM_BLOCK_ICON_NAMES,
  iconNameSchema,
  themeTokensSchema,
  partialThemeTokensSchema,
  themeComponentVariantsSchema,
  themeManifestSchema,
  pluginManifestSchema,
} from "../src/index.js";

describe("iconNameSchema", () => {
  it("accepts every allowlisted control and Custom Block icon", () => {
    expect(CUSTOM_BLOCK_ICON_NAMES).toEqual([
      "x",
      "check",
      "loader-circle",
      "circle-alert",
      "info",
      "lightbulb",
      "sticky-note",
      "chevron-down",
      "chevrons-right",
      "columns-3",
      "layout-panel-top",
      "search",
      "upload",
      "download",
      "link-2",
      "settings",
      "palette",
      "play",
      "square",
      "rotate-ccw",
      "bold",
      "italic",
      "heading-2",
      "list",
      "file-text",
    ]);

    for (const name of CUSTOM_BLOCK_ICON_NAMES) {
      expect(iconNameSchema.safeParse(name).success).toBe(true);
    }
  });

  it("rejects icon names outside the allowlist", () => {
    expect(iconNameSchema.safeParse("sparkles").success).toBe(false);
    expect(iconNameSchema.safeParse("<svg>").success).toBe(false);
    expect(iconNameSchema.safeParse(42).success).toBe(false);
  });
});

describe("themeTokensSchema", () => {
  it("accepts valid complete tokens", () => {
    const result = themeTokensSchema.safeParse({
      color: {
        background: "#fff",
        surface: "#fff",
        surfaceMuted: "#eee",
        foreground: "#000",
        muted: "#999",
        accent: "#00f",
        accentContrast: "#fff",
        border: "#ccc",
        success: "#080",
        warning: "#880",
        danger: "#800",
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
        surface: "#fff",
        surfaceMuted: "#eee",
        foreground: "#000",
        muted: "#999",
        accent: "#00f",
        accentContrast: "#fff",
        border: "#ccc",
        success: "#080",
        warning: "#880",
        danger: "#800",
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
        surface: "#fff",
        surfaceMuted: "#eee",
        foreground: "#000",
        muted: "#999",
        accent: "#00f",
        accentContrast: "#fff",
        border: "#ccc",
        success: "#080",
        warning: "#880",
        danger: "#800",
      },
      typography: { bodyFont: "url(evil)", headingFont: "sans-serif", monoFont: "monospace" },
      radius: { sm: "0.25rem", md: "0.5rem", lg: "1rem" },
      spacing: {},
    });
    expect(result.success).toBe(false);
  });

  it("requires the semantic color keys for complete tokens", () => {
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
    expect(result.success).toBe(false);
  });

  it("accepts legacy five-color overrides for partial tokens", () => {
    const result = partialThemeTokensSchema.safeParse({
      color: {
        background: "#fff",
        foreground: "#000",
        muted: "#999",
        accent: "#00f",
        border: "#ccc",
      },
    });
    expect(result.success).toBe(true);
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
