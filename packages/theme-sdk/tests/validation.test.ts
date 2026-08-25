import { describe, expect, it } from "vitest";
import { validateThemeManifest, validateColorValue, validateFontValue } from "../src/index.js";

describe("validateColorValue", () => {
  it.each([
    "#fff",
    "#ffffff",
    "#aabbcc",
    "rgb(0,0,0)",
    "rgba(0,0,0,1)",
    "hsl(0,0%,0%)",
    "oklch(50% 0.2 250)",
  ])("accepts valid color: %s", (v) => expect(validateColorValue(v)).toBe(true));
  it.each(["url(evil)", "expression(alert(1))", "var(--x)", "javascript:void(0)"])(
    "rejects dangerous color: %s",
    (v) => expect(validateColorValue(v)).toBe(false),
  );
});

describe("validateFontValue", () => {
  it.each([
    "'Inter', sans-serif",
    "monospace",
    "system-ui",
    "'Noto Sans TC', 'Helvetica Neue', sans-serif",
  ])("accepts valid font: %s", (v) => expect(validateFontValue(v)).toBe(true));
  it.each(["url(evil.woff2)", "expression(alert(1))", "javascript:void"])(
    "rejects dangerous font: %s",
    (v) => expect(validateFontValue(v)).toBe(false),
  );
});

describe("validateThemeManifest", () => {
  it("returns ok for a valid manifest", () => {
    const result = validateThemeManifest({ id: "t", name: "T", version: "1.0.0" });
    expect(result.ok).toBe(true);
  });

  it("returns error for missing required fields", () => {
    const result = validateThemeManifest({ id: "t" });
    expect(result.ok).toBe(false);
  });
});
