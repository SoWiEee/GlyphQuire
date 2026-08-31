import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { defaultDarkTheme, defaultTheme } from "@glyphquire/theme-engine";

const stylesheet = readFileSync(resolve(process.cwd(), "src/styles/workbench.css"), "utf8");

function parseHex(value: string): [number, number, number] {
  const hex = value.replace(/^#/, "");
  if (!/^[0-9a-f]{6}$/i.test(hex)) throw new Error(`Expected a six-digit hex color: ${value}`);
  return [0, 2, 4].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16)) as [
    number,
    number,
    number,
  ];
}

function relativeLuminance(value: string): number {
  return parseHex(value)
    .map((channel) => channel / 255)
    .map((channel) => (channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4))
    .reduce((sum, channel, index) => sum + channel * [0.2126, 0.7152, 0.0722][index], 0);
}

function contrastRatio(first: string, second: string): number {
  const firstLuminance = relativeLuminance(first);
  const secondLuminance = relativeLuminance(second);
  const lighter = Math.max(firstLuminance, secondLuminance);
  const darker = Math.min(firstLuminance, secondLuminance);
  return (lighter + 0.05) / (darker + 0.05);
}

function expectContrastAtLeast(first: string, second: string, minimum: number): void {
  expect(contrastRatio(first, second)).toBeGreaterThanOrEqual(minimum);
}

describe("workbench stylesheet", () => {
  it("defines paper canvas primitives from semantic CSS variables", () => {
    expect(stylesheet).toContain("--gq-canvas: var(--gq-color-background);");
    expect(stylesheet).toContain("--gq-surface: var(--gq-color-surface);");
    expect(stylesheet).toContain(
      "--gq-surface-raised: color-mix(in srgb, var(--gq-surface) 92%, white);",
    );
    expect(stylesheet).toContain("--gq-status-success: var(--gq-color-success);");
    expect(stylesheet).toContain("--gq-status-warning: var(--gq-color-warning);");
    expect(stylesheet).toContain("--gq-status-danger: var(--gq-color-danger);");
    expect(stylesheet).toContain(
      "--gq-focus-ring: 0 0 0 3px color-mix(in srgb, var(--gq-color-accent) 34%, transparent);",
    );
  });

  it.each([
    ["light", defaultTheme],
    ["dark", defaultDarkTheme],
  ])("keeps %s theme text and interaction pairs accessible", (_name, theme) => {
    expectContrastAtLeast(theme.color.foreground, theme.color.surface, 4.5);
    expectContrastAtLeast(theme.color.muted, theme.color.surface, 4.5);
    expectContrastAtLeast(theme.color.accentContrast, theme.color.accent, 4.5);
    expectContrastAtLeast(theme.color.border, theme.color.surface, 3);
    expectContrastAtLeast(theme.color.accent, theme.color.surface, 3);
  });
});
