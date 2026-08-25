export interface ThemeComponentVariants {
  readonly heading?: { readonly decoration?: "none" | "sparkle" | "line" };
  readonly quote?: { readonly variant?: "plain" | "sticky" | "paper" };
  readonly callout?: {
    readonly variant?: "solid" | "glass" | "outline";
    readonly animation?: "none" | "glow" | "lift";
  };
  readonly code?: { readonly variant?: "plain" | "terminal" };
  readonly toggle?: { readonly variant?: "plain" | "card" };
  readonly tabs?: { readonly variant?: "plain" | "pill" | "underline" };
  readonly stickyNote?: { readonly variant?: "plain" | "paper" | "neon" };
}

export const defaultVariants: ThemeComponentVariants = {
  heading: { decoration: "none" },
  quote: { variant: "plain" },
  callout: { variant: "solid", animation: "none" },
  code: { variant: "plain" },
  toggle: { variant: "plain" },
  tabs: { variant: "plain" },
  stickyNote: { variant: "plain" },
};

export function resolveVariants(
  base: ThemeComponentVariants,
  overrides: Partial<ThemeComponentVariants>,
): ThemeComponentVariants {
  const result: Record<string, Record<string, string>> = {};

  for (const key of Object.keys(base) as (keyof ThemeComponentVariants)[]) {
    const baseEntry = base[key] ?? {};
    const overrideEntry = overrides[key] ?? {};
    result[key] = { ...baseEntry, ...overrideEntry };
  }

  for (const key of Object.keys(overrides) as (keyof ThemeComponentVariants)[]) {
    if (!(key in result)) {
      result[key] = { ...(overrides[key] as Record<string, string>) };
    }
  }

  return result as ThemeComponentVariants;
}
