import { describe, expect, it } from "vitest";
import { useTheme } from "./ThemeProvider.js";
import { defaultTheme, defaultVariants, tokensToCssVariables } from "@glyphquire/theme-engine";

describe("useTheme", () => {
  it("provides default light tokens initially", () => {
    const theme = useTheme();
    expect(theme.tokens.value).toEqual(defaultTheme);
    expect(theme.isDark.value).toBe(false);
  });

  it("computes CSS variables from current tokens", () => {
    const theme = useTheme();
    const expected = tokensToCssVariables(defaultTheme);
    expect(theme.cssVariables.value).toEqual(expected);
  });

  it("setDraftTokens applies partial overrides reactively", () => {
    const theme = useTheme();
    theme.setDraftTokens({ color: { background: "#000", foreground: "#fff", muted: "#888", accent: "#00f", border: "#333" } });
    expect(theme.cssVariables.value["--gq-color-background"]).toBe("#000");
  });

  it("resetDraft reverts to base tokens", () => {
    const theme = useTheme();
    theme.setDraftTokens({ color: { background: "#000", foreground: "#fff", muted: "#888", accent: "#00f", border: "#333" } });
    theme.resetDraft();
    expect(theme.cssVariables.value["--gq-color-background"]).toBe(defaultTheme.color.background);
  });

  it("provides default variants", () => {
    const theme = useTheme();
    expect(theme.variants.value).toEqual(defaultVariants);
  });
});
