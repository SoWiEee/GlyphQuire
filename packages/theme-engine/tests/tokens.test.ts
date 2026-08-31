import { describe, expect, it } from "vitest";
import { defaultTheme, defaultDarkTheme, warmSepiaTheme } from "../src/index.js";

describe("defaultTheme", () => {
  it("has all required color token keys", () => {
    expect(defaultTheme.color).toEqual(
      expect.objectContaining({
        background: expect.any(String),
        surface: expect.any(String),
        surfaceMuted: expect.any(String),
        foreground: expect.any(String),
        muted: expect.any(String),
        accent: expect.any(String),
        accentContrast: expect.any(String),
        border: expect.any(String),
        success: expect.any(String),
        warning: expect.any(String),
        danger: expect.any(String),
      }),
    );
  });

  it("uses a serif display face and an AA-compliant Indigo accent", () => {
    expect(defaultTheme.typography.headingFont).toMatch(/Georgia|Source Serif|serif/i);
    expect(defaultTheme.color.accent).toBe("#4f5f9f");
  });

  it("keeps the exact Paper Canvas light semantic colors", () => {
    expect(defaultTheme.color).toEqual({
      background: "#f7f3ed",
      surface: "#fffdf9",
      surfaceMuted: "#eee8df",
      foreground: "#2e2924",
      muted: "#6f675f",
      accent: "#4f5f9f",
      accentContrast: "#ffffff",
      border: "#9c8e7f",
      success: "#31724d",
      warning: "#8a5a16",
      danger: "#a13d3d",
    });
    expect(defaultTheme.typography.headingFont).toBe('"Source Serif 4", Georgia, serif');
  });

  it("has all required typography token keys", () => {
    expect(defaultTheme.typography).toEqual(
      expect.objectContaining({
        bodyFont: expect.any(String),
        headingFont: expect.any(String),
        monoFont: expect.any(String),
      }),
    );
  });

  it("has all required radius token keys", () => {
    expect(defaultTheme.radius).toEqual(
      expect.objectContaining({
        sm: expect.any(String),
        md: expect.any(String),
        lg: expect.any(String),
      }),
    );
  });

  it("has all required spacing token keys", () => {
    for (const key of ["xs", "sm", "md", "lg", "xl", "2xl"]) {
      expect(defaultTheme.spacing[key]).toEqual(expect.any(String));
    }
  });
});

describe("defaultDarkTheme", () => {
  it("is a complete ThemeTokens with different background than light", () => {
    expect(defaultDarkTheme.color.background).not.toBe(defaultTheme.color.background);
    expect(defaultDarkTheme.typography.bodyFont).toEqual(expect.any(String));
  });

  it("keeps the exact Paper Canvas dark semantic colors", () => {
    expect(defaultDarkTheme.color).toEqual({
      background: "#16171d",
      surface: "#20222b",
      surfaceMuted: "#2b2e3a",
      foreground: "#f3f1ed",
      muted: "#b8b3ac",
      accent: "#aab5f0",
      accentContrast: "#171924",
      border: "#697087",
      success: "#8fd3aa",
      warning: "#f0c477",
      danger: "#f0a0a0",
    });
    expect(defaultDarkTheme.typography.headingFont).toBe('"Source Serif 4", Georgia, serif');
  });
});

describe("warmSepiaTheme", () => {
  it("provides partial overrides with sepia-toned colors", () => {
    expect(warmSepiaTheme.color).toEqual(
      expect.objectContaining({
        background: expect.any(String),
        surface: expect.any(String),
        surfaceMuted: expect.any(String),
        foreground: expect.any(String),
        muted: expect.any(String),
        accent: expect.any(String),
        accentContrast: expect.any(String),
        border: expect.any(String),
        success: expect.any(String),
        warning: expect.any(String),
        danger: expect.any(String),
      }),
    );
    expect(warmSepiaTheme.typography?.headingFont).toMatch(/Georgia|Source Serif|serif/i);
  });
});
