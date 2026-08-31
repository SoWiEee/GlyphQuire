import { describe, expect, it } from "vitest";
import { resolveTheme, mergeTokens, defaultTheme, type ThemeTokenOverrides } from "../src/index.js";

describe("mergeTokens", () => {
  it("returns base unchanged when overrides is empty", () => {
    const result = mergeTokens(defaultTheme, {});
    expect(result).toEqual(defaultTheme);
  });

  it("does not mutate the base", () => {
    const base = structuredClone(defaultTheme);
    mergeTokens(base, {
      color: {
        background: "#000",
        foreground: "#fff",
        muted: "#999",
        accent: "#f00",
        border: "#333",
      },
    });
    expect(base).toEqual(defaultTheme);
  });

  it("deep merges color overrides while preserving other groups", () => {
    const result = mergeTokens(defaultTheme, {
      color: {
        background: "#000",
        foreground: "#fff",
        muted: "#999",
        accent: "#f00",
        border: "#333",
      },
    });
    expect(result.color.background).toBe("#000");
    expect(result.typography).toEqual(defaultTheme.typography);
    expect(result.radius).toEqual(defaultTheme.radius);
  });

  it("merges spacing keys additively", () => {
    const result = mergeTokens(defaultTheme, { spacing: { xs: "0.5rem", custom: "4rem" } });
    expect(result.spacing.xs).toBe("0.5rem");
    expect(result.spacing.custom).toBe("4rem");
    expect(result.spacing.md).toBe("1rem");
  });

  it("accepts a partial semantic color override", () => {
    const result = mergeTokens(defaultTheme, { color: { surface: "#f00" } });
    expect(result.color.surface).toBe("#f00");
    expect(result.color.background).toBe(defaultTheme.color.background);
  });
});

describe("resolveTheme", () => {
  it("applies overrides on top of the base theme", () => {
    const overrides: ThemeTokenOverrides = {
      color: {
        background: "#111",
        foreground: "#eee",
        muted: "#888",
        accent: "#00f",
        border: "#444",
      },
    };
    const resolved = resolveTheme(defaultTheme, overrides);
    expect(resolved.color.background).toBe("#111");
    expect(resolved.typography).toEqual(defaultTheme.typography);
  });

  it("fills new semantic colors from the base for legacy color overrides", () => {
    const resolved = resolveTheme(defaultTheme, {
      color: {
        background: "#111",
        foreground: "#eee",
        muted: "#888",
        accent: "#00f",
        border: "#444",
      },
    });

    expect(resolved.color).toEqual({
      background: "#111",
      surface: "#fffdf9",
      surfaceMuted: "#eee8df",
      foreground: "#eee",
      muted: "#888",
      accent: "#00f",
      accentContrast: "#ffffff",
      border: "#444",
      success: "#31724d",
      warning: "#8a5a16",
      danger: "#a13d3d",
    });
  });

  it("returns a frozen result", () => {
    const resolved = resolveTheme(defaultTheme, {});
    expect(Object.isFrozen(resolved)).toBe(true);
    expect(Object.isFrozen(resolved.color)).toBe(true);
  });
});
