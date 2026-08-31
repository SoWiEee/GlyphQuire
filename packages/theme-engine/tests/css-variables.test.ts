import { describe, expect, it } from "vitest";
import { tokensToCssVariables, defaultDarkTheme, defaultTheme } from "../src/index.js";

const expectedLightVariables = {
  "--gq-color-background": "#f7f3ed",
  "--gq-color-surface": "#fffdf9",
  "--gq-color-surface-muted": "#eee8df",
  "--gq-color-foreground": "#2e2924",
  "--gq-color-muted": "#6f675f",
  "--gq-color-accent": "#4f5f9f",
  "--gq-color-accent-contrast": "#ffffff",
  "--gq-color-border": "#9c8e7f",
  "--gq-color-success": "#31724d",
  "--gq-color-warning": "#8a5a16",
  "--gq-color-danger": "#a13d3d",
  "--gq-typography-body-font": "'Inter', 'Noto Sans TC', system-ui, sans-serif",
  "--gq-typography-heading-font": '"Source Serif 4", Georgia, serif',
  "--gq-typography-mono-font": "'JetBrains Mono', 'Fira Code', ui-monospace, monospace",
  "--gq-radius-sm": "0.25rem",
  "--gq-radius-md": "0.5rem",
  "--gq-radius-lg": "0.75rem",
  "--gq-spacing-xs": "0.25rem",
  "--gq-spacing-sm": "0.5rem",
  "--gq-spacing-md": "1rem",
  "--gq-spacing-lg": "1.5rem",
  "--gq-spacing-xl": "2rem",
  "--gq-spacing-2xl": "3rem",
};

const expectedDarkVariables = {
  "--gq-color-background": "#16171d",
  "--gq-color-surface": "#20222b",
  "--gq-color-surface-muted": "#2b2e3a",
  "--gq-color-foreground": "#f3f1ed",
  "--gq-color-muted": "#b8b3ac",
  "--gq-color-accent": "#aab5f0",
  "--gq-color-accent-contrast": "#171924",
  "--gq-color-border": "#697087",
  "--gq-color-success": "#8fd3aa",
  "--gq-color-warning": "#f0c477",
  "--gq-color-danger": "#f0a0a0",
  "--gq-typography-body-font": "'Inter', 'Noto Sans TC', system-ui, sans-serif",
  "--gq-typography-heading-font": '"Source Serif 4", Georgia, serif',
  "--gq-typography-mono-font": "'JetBrains Mono', 'Fira Code', ui-monospace, monospace",
  "--gq-radius-sm": "0.25rem",
  "--gq-radius-md": "0.5rem",
  "--gq-radius-lg": "0.75rem",
  "--gq-spacing-xs": "0.25rem",
  "--gq-spacing-sm": "0.5rem",
  "--gq-spacing-md": "1rem",
  "--gq-spacing-lg": "1.5rem",
  "--gq-spacing-xl": "2rem",
  "--gq-spacing-2xl": "3rem",
};

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

  it("maps every light theme token to its exact CSS variable", () => {
    expect(tokensToCssVariables(defaultTheme)).toEqual(expectedLightVariables);
  });

  it("maps every dark theme token to its exact CSS variable", () => {
    expect(tokensToCssVariables(defaultDarkTheme)).toEqual(expectedDarkVariables);
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
