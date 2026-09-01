import { afterEach, describe, expect, it } from "vitest";
import { useTheme } from "./ThemeProvider.js";
import { defaultTheme, defaultVariants, tokensToCssVariables } from "@glyphquire/theme-engine";

describe("useTheme", () => {
  afterEach(() => {
    const root = document.documentElement;
    for (const name of [
      "data-gq-heading-decoration",
      "data-gq-quote-variant",
      "data-gq-callout-variant",
      "data-gq-callout-animation",
      "data-gq-code-variant",
      "data-gq-toggle-variant",
      "data-gq-tabs-variant",
      "data-gq-sticky-note-variant",
    ]) {
      root.removeAttribute(name);
    }
    root.removeAttribute("data-gq-legacy-variant");
    for (const key of Object.keys(tokensToCssVariables(defaultTheme))) {
      root.style.removeProperty(key);
    }
  });

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
    theme.setDraftTokens({
      color: {
        background: "#000",
        foreground: "#fff",
        muted: "#888",
        accent: "#00f",
        border: "#333",
      },
    });
    expect(theme.cssVariables.value["--gq-color-background"]).toBe("#000");
  });

  it("preserves base semantic colors for partial overrides", () => {
    const theme = useTheme();
    theme.setDraftTokens({ color: { surface: "#fefefe" } });

    expect(theme.tokens.value.color.surface).toBe("#fefefe");
    expect(theme.tokens.value.color.danger).toBe(defaultTheme.color.danger);
  });

  it("resetDraft reverts to base tokens", () => {
    const theme = useTheme();
    theme.setDraftTokens({
      color: {
        background: "#000",
        foreground: "#fff",
        muted: "#888",
        accent: "#00f",
        border: "#333",
      },
    });
    theme.resetDraft();
    expect(theme.cssVariables.value["--gq-color-background"]).toBe(defaultTheme.color.background);
  });

  it("provides default variants", () => {
    const theme = useTheme();
    expect(theme.variants.value).toEqual(defaultVariants);
  });

  it("applies the default theme to the document root", () => {
    useTheme();

    expect(document.documentElement.style.getPropertyValue("--gq-color-background")).toBe(
      defaultTheme.color.background,
    );
    expect(document.documentElement.getAttribute("data-gq-callout-variant")).toBe("solid");
    expect(document.documentElement.getAttribute("data-gq-callout-animation")).toBe("none");
    expect(document.documentElement.getAttribute("data-gq-sticky-note-variant")).toBe("plain");
  });

  it("applies draft token and variant changes reactively", () => {
    const theme = useTheme();

    theme.setDraftTokens({ color: { background: "#000000" } });
    theme.setDraftVariants({ quote: { variant: "sticky" } });

    expect(document.documentElement.style.getPropertyValue("--gq-color-background")).toBe(
      "#000000",
    );
    expect(document.documentElement.getAttribute("data-gq-quote-variant")).toBe("sticky");
  });

  it("preserves other unsaved component variants when updating one component", () => {
    const theme = useTheme();

    theme.setDraftVariants({ quote: { variant: "sticky" } });
    theme.setDraftVariants({ callout: { variant: "glass" } });

    expect(theme.variants.value.quote).toEqual({ variant: "sticky" });
    expect(theme.variants.value.callout).toEqual({ variant: "glass", animation: "none" });
  });

  it("keeps committed component variants visible while drafting another component", () => {
    const theme = useTheme();

    theme.setTheme({}, { quote: { variant: "paper" } });
    theme.setDraftVariants({ callout: { variant: "glass" } });

    expect(theme.variants.value.quote).toEqual({ variant: "paper" });
    expect(theme.variants.value.callout).toEqual({ variant: "glass", animation: "none" });
  });

  it("removes stale optional variant attributes when applying a theme", () => {
    const theme = useTheme();

    theme.setTheme({}, { callout: { variant: "outline", animation: undefined } });

    expect(document.documentElement.getAttribute("data-gq-callout-variant")).toBe("outline");
    expect(document.documentElement.hasAttribute("data-gq-callout-animation")).toBe(false);
  });
});
