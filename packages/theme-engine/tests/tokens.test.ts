import { describe, expect, it } from "vitest";
import { defaultTheme, defaultDarkTheme, warmSepiaTheme } from "../src/index.js";

describe("defaultTheme", () => {
  it("has all required color token keys", () => {
    expect(defaultTheme.color).toEqual(
      expect.objectContaining({
        background: expect.any(String),
        foreground: expect.any(String),
        muted: expect.any(String),
        accent: expect.any(String),
        border: expect.any(String),
      }),
    );
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
});

describe("warmSepiaTheme", () => {
  it("provides partial overrides with sepia-toned colors", () => {
    expect(warmSepiaTheme.color).toBeDefined();
    expect(warmSepiaTheme.color?.background).toBeDefined();
  });
});
