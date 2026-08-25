import { describe, expect, it } from "vitest";
import {
  defaultVariants,
  resolveVariants,
  type ThemeComponentVariants,
} from "../src/index.js";

describe("defaultVariants", () => {
  it("has default variants for all supported components", () => {
    expect(defaultVariants.heading).toEqual({ decoration: "none" });
    expect(defaultVariants.quote).toEqual({ variant: "plain" });
    expect(defaultVariants.callout).toEqual({ variant: "solid", animation: "none" });
    expect(defaultVariants.code).toEqual({ variant: "plain" });
    expect(defaultVariants.toggle).toEqual({ variant: "plain" });
    expect(defaultVariants.tabs).toEqual({ variant: "plain" });
    expect(defaultVariants.stickyNote).toEqual({ variant: "plain" });
  });
});

describe("resolveVariants", () => {
  it("returns defaults when overrides is empty", () => {
    const result = resolveVariants(defaultVariants, {});
    expect(result).toEqual(defaultVariants);
  });

  it("merges a single component override", () => {
    const result = resolveVariants(defaultVariants, {
      heading: { decoration: "sparkle" },
    });
    expect(result.heading?.decoration).toBe("sparkle");
    expect(result.quote).toEqual(defaultVariants.quote);
  });

  it("does not mutate the base", () => {
    const base = structuredClone(defaultVariants);
    resolveVariants(base, { callout: { variant: "glass", animation: "glow" } });
    expect(base.callout).toEqual({ variant: "solid", animation: "none" });
  });
});
