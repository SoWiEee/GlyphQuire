import { describe, expect, it } from "vitest";
import { tokensToCssVariables, defaultTheme } from "../src/index.js";

describe("tokensToCssVariables", () => {
  it("maps color tokens to --gq-color-* variables", () => {
    const vars = tokensToCssVariables(defaultTheme);
    expect(vars["--gq-color-background"]).toBe(defaultTheme.color.background);
    expect(vars["--gq-color-foreground"]).toBe(defaultTheme.color.foreground);
    expect(vars["--gq-color-muted"]).toBe(defaultTheme.color.muted);
    expect(vars["--gq-color-accent"]).toBe(defaultTheme.color.accent);
    expect(vars["--gq-color-border"]).toBe(defaultTheme.color.border);
  });

  it("maps semantic surface and status colors", () => {
    const vars = tokensToCssVariables(defaultTheme);
    expect(vars["--gq-color-surface"]).toBe(defaultTheme.color.surface);
    expect(vars["--gq-color-success"]).toBe(defaultTheme.color.success);
    expect(vars["--gq-color-danger"]).toBe(defaultTheme.color.danger);
  });

  it("maps typography tokens to --gq-typography-* with kebab-case", () => {
    const vars = tokensToCssVariables(defaultTheme);
    expect(vars["--gq-typography-body-font"]).toBe(defaultTheme.typography.bodyFont);
    expect(vars["--gq-typography-heading-font"]).toBe(defaultTheme.typography.headingFont);
    expect(vars["--gq-typography-mono-font"]).toBe(defaultTheme.typography.monoFont);
  });

  it("maps radius tokens to --gq-radius-*", () => {
    const vars = tokensToCssVariables(defaultTheme);
    expect(vars["--gq-radius-sm"]).toBe("0.25rem");
    expect(vars["--gq-radius-md"]).toBe("0.5rem");
    expect(vars["--gq-radius-lg"]).toBe("0.75rem");
  });

  it("maps spacing tokens to --gq-spacing-*", () => {
    const vars = tokensToCssVariables(defaultTheme);
    expect(vars["--gq-spacing-xs"]).toBe("0.25rem");
    expect(vars["--gq-spacing-2xl"]).toBe("3rem");
  });

  it("returns a new object each time", () => {
    const a = tokensToCssVariables(defaultTheme);
    const b = tokensToCssVariables(defaultTheme);
    expect(a).toEqual(b);
    expect(a).not.toBe(b);
  });
});
