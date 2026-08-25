# Phase 3 — Component + Theme Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver theme-aware visual rendering for all 14 built-in blocks, a design-token-driven theme engine, workspace-scoped theme persistence with API, a GUI theme editor, and the declarative plugin manifest foundation.

**Architecture:** `packages/theme-engine` owns pure token resolution and CSS variable generation (zero DOM). `packages/theme-sdk` owns Zod schemas shared between API and frontend. `apps/api` owns theme CRUD with tenant isolation. `apps/web` owns Vue ThemeProvider, Milkdown node view extensions, component CSS, and theme editor UI.

**Tech Stack:** Node.js 22+, pnpm 9+, TypeScript strict, Vue 3, Pinia, Hono, Zod, Drizzle ORM, PostgreSQL, Milkdown, ProseMirror, KaTeX, Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-08-25-phase3-component-theme-design.md`

## Global Constraints

- TypeScript strict mode everywhere; no `any`.
- All CSS colors as `var(--gq-*)` tokens; never hardcode color/font/radius/spacing values in component CSS.
- Component variant selection via `data-variant` / `data-decoration` attributes, never class-name switches.
- Animation CSS guarded by `@media (prefers-reduced-motion: no-preference)`.
- Font values validated against allowlist (no `url()`, `expression()`). Color values validated as hex/rgb/hsl/oklch patterns (no `url()`, `var()` refs, CSS expressions).
- System themes immutable at API layer (`is_system = true` ⇒ mutation rejected).
- All theme queries scoped by workspace membership (same tenant-isolation as notes).
- Theme mutations share note mutation rate-limit bucket (`note:mutation:user:*`, 30/min).
- No `v-html`, `innerHTML`, `eval`, or `Function` for theme content.
- KaTeX options: `throwOnError: false`, no `trust` callback, no HTML output mode.
- New packages follow monorepo patterns: `pnpm-workspace.yaml` already includes `packages/*`.

---

## File Structure

### New: `packages/theme-engine/`

```
packages/theme-engine/
  package.json
  tsconfig.json
  vitest.config.ts
  src/
    tokens.ts              ThemeTokens interface, defaultTheme, defaultDarkTheme, warmSepiaTheme
    resolve.ts             resolveTheme(base, overrides), mergeTokens deep-merge helper
    css-variables.ts       tokensToCssVariables(tokens) → Record<string, string>
    variants.ts            ThemeComponentVariants interface, defaultVariants, resolveVariants
    index.ts               public re-exports
  tests/
    tokens.test.ts
    resolve.test.ts
    css-variables.test.ts
    variants.test.ts
```

### New: `packages/theme-sdk/`

```
packages/theme-sdk/
  package.json
  tsconfig.json
  vitest.config.ts
  src/
    schemas.ts             Zod: themeTokensSchema, themeComponentVariantsSchema, themeManifestSchema, pluginManifestSchema
    types.ts               inferred TS types from schemas
    validation.ts          validateThemeManifest, validateColorValue, validateFontValue
    index.ts               public re-exports
  tests/
    schemas.test.ts
    validation.test.ts
```

### New: `packages/database/src/schema/themes.ts` + `user-themes.ts`

### New: `packages/database/src/migrations/0004_phase3_themes.sql`

### New: `packages/api-contract/src/themes/`

```
packages/api-contract/src/themes/
  schemas.ts               Zod request/response schemas for theme API
  types.ts                 inferred endpoint types
```

### New: `apps/api/src/modules/themes/`

```
apps/api/src/modules/themes/
  ThemeService.ts
  ThemeService.integration.test.ts
```

### New: `apps/api/src/routes/v1/themes.ts` + `themes.integration.test.ts`

### New: `apps/web/src/themes/`

```
apps/web/src/themes/
  ThemeProvider.ts         Vue composable: resolve, inject CSS vars, dark mode
  useThemeEditor.ts        editor state management composable
  tokens.css               fallback token definitions
  components/
    heading.css
    paragraph.css
    quote.css
    code.css
    callout.css
    sticky-note.css
    toggle.css
    tabs.css
    columns.css
    divider.css
    image.css
    math.css
```

### New: `apps/web/src/components/theme-editor/`

```
apps/web/src/components/theme-editor/
  ThemeEditorPanel.vue
  ThemeSelector.vue
  TokenEditor.vue
  ColorTokenGroup.vue
  TypographyTokenGroup.vue
  RadiusTokenGroup.vue
  SpacingTokenGroup.vue
  VariantPicker.vue
  ComponentVariantRow.vue
  ThemeActions.vue
```

### New: `apps/web/src/stores/theme.ts`

### Modified: `apps/web/src/editors/visual/nodes/*.ts` (extend for variant attrs)

### Modified: `apps/web/src/components/workbench/TopBar.vue` (add theme button)

### Modified: `apps/web/src/components/workbench/Workbench.vue` (mount ThemeEditorPanel)

### Modified: `packages/database/src/schema/index.ts` (export themes + user-themes)

### Modified: `packages/database/src/index.ts` (export theme types)

### Modified: `packages/api-contract/src/index.ts` (export theme contract)

### Modified: `apps/api/src/app.ts` (mount theme routes)

---

### Task 1: Theme Engine — Tokens and Resolution

**Files:**

- Create: `packages/theme-engine/package.json`
- Create: `packages/theme-engine/tsconfig.json`
- Create: `packages/theme-engine/vitest.config.ts`
- Create: `packages/theme-engine/src/tokens.ts`
- Create: `packages/theme-engine/src/resolve.ts`
- Create: `packages/theme-engine/src/css-variables.ts`
- Create: `packages/theme-engine/src/variants.ts`
- Create: `packages/theme-engine/src/index.ts`
- Create: `packages/theme-engine/tests/tokens.test.ts`
- Create: `packages/theme-engine/tests/resolve.test.ts`
- Create: `packages/theme-engine/tests/css-variables.test.ts`
- Create: `packages/theme-engine/tests/variants.test.ts`

**Interfaces:**

- Consumes: nothing (foundational package)
- Produces:
  - `ThemeTokens` interface (color, typography, radius, spacing)
  - `ThemeComponentVariants` interface (heading, quote, callout, code, toggle, tabs, stickyNote)
  - `defaultTheme: ThemeTokens` (light theme)
  - `defaultDarkTheme: ThemeTokens` (dark theme)
  - `warmSepiaTheme: Partial<ThemeTokens>` (overrides for Warm Sepia)
  - `resolveTheme(base: ThemeTokens, overrides: Partial<ThemeTokens>): ThemeTokens`
  - `mergeTokens(target: ThemeTokens, source: Partial<ThemeTokens>): ThemeTokens`
  - `tokensToCssVariables(tokens: ThemeTokens): Record<string, string>`
  - `defaultVariants: ThemeComponentVariants`
  - `resolveVariants(base: ThemeComponentVariants, overrides: Partial<ThemeComponentVariants>): ThemeComponentVariants`

- [ ] **Step 1: Create package scaffold**

Create `packages/theme-engine/package.json`:

```json
{
  "name": "@glyphquire/theme-engine",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "exports": {
    ".": {
      "import": "./src/index.ts",
      "types": "./src/index.ts"
    }
  },
  "scripts": {
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  },
  "devDependencies": {
    "typescript": "catalog:",
    "vitest": "catalog:"
  }
}
```

Create `packages/theme-engine/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "rootDir": "src",
    "outDir": "dist"
  },
  "include": ["src", "tests"]
}
```

Create `packages/theme-engine/vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
  },
});
```

- [ ] **Step 2: Write failing tests for tokens**

Create `packages/theme-engine/tests/tokens.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { defaultTheme, defaultDarkTheme, warmSepiaTheme, type ThemeTokens } from "../src/index.js";

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
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd packages/theme-engine && pnpm install && pnpm test`
Expected: FAIL — modules not found

- [ ] **Step 4: Implement tokens.ts**

Create `packages/theme-engine/src/tokens.ts`:

```ts
export interface ThemeTokens {
  readonly color: {
    readonly background: string;
    readonly foreground: string;
    readonly muted: string;
    readonly accent: string;
    readonly border: string;
  };
  readonly typography: {
    readonly bodyFont: string;
    readonly headingFont: string;
    readonly monoFont: string;
  };
  readonly radius: {
    readonly sm: string;
    readonly md: string;
    readonly lg: string;
  };
  readonly spacing: Readonly<Record<string, string>>;
}

export const defaultTheme: ThemeTokens = {
  color: {
    background: "#ffffff",
    foreground: "#1a1a1a",
    muted: "#6b7280",
    accent: "#2563eb",
    border: "#e5e7eb",
  },
  typography: {
    bodyFont: "'Inter', 'Noto Sans TC', system-ui, sans-serif",
    headingFont: "'Inter', 'Noto Sans TC', system-ui, sans-serif",
    monoFont: "'JetBrains Mono', 'Fira Code', ui-monospace, monospace",
  },
  radius: {
    sm: "0.25rem",
    md: "0.5rem",
    lg: "0.75rem",
  },
  spacing: {
    xs: "0.25rem",
    sm: "0.5rem",
    md: "1rem",
    lg: "1.5rem",
    xl: "2rem",
    "2xl": "3rem",
  },
};

export const defaultDarkTheme: ThemeTokens = {
  color: {
    background: "#0f172a",
    foreground: "#f1f5f9",
    muted: "#94a3b8",
    accent: "#60a5fa",
    border: "#334155",
  },
  typography: {
    bodyFont: "'Inter', 'Noto Sans TC', system-ui, sans-serif",
    headingFont: "'Inter', 'Noto Sans TC', system-ui, sans-serif",
    monoFont: "'JetBrains Mono', 'Fira Code', ui-monospace, monospace",
  },
  radius: {
    sm: "0.25rem",
    md: "0.5rem",
    lg: "0.75rem",
  },
  spacing: {
    xs: "0.25rem",
    sm: "0.5rem",
    md: "1rem",
    lg: "1.5rem",
    xl: "2rem",
    "2xl": "3rem",
  },
};

export const warmSepiaTheme: Partial<ThemeTokens> = {
  color: {
    background: "#fdf6e3",
    foreground: "#3b2e1a",
    muted: "#8b7355",
    accent: "#b58900",
    border: "#e0d5b7",
  },
};
```

- [ ] **Step 5: Run token tests to verify they pass**

Run: `cd packages/theme-engine && pnpm test -- tests/tokens.test.ts`
Expected: PASS

- [ ] **Step 6: Write failing tests for resolve**

Create `packages/theme-engine/tests/resolve.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { resolveTheme, mergeTokens, defaultTheme, type ThemeTokens } from "../src/index.js";

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
});

describe("resolveTheme", () => {
  it("applies overrides on top of the base theme", () => {
    const overrides: Partial<ThemeTokens> = {
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

  it("returns a frozen result", () => {
    const resolved = resolveTheme(defaultTheme, {});
    expect(Object.isFrozen(resolved)).toBe(true);
    expect(Object.isFrozen(resolved.color)).toBe(true);
  });
});
```

- [ ] **Step 7: Implement resolve.ts**

Create `packages/theme-engine/src/resolve.ts`:

```ts
import type { ThemeTokens } from "./tokens.js";

function deepFreeze<T extends object>(obj: T): Readonly<T> {
  for (const value of Object.values(obj)) {
    if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
      deepFreeze(value);
    }
  }
  return Object.freeze(obj);
}

export function mergeTokens(base: ThemeTokens, overrides: Partial<ThemeTokens>): ThemeTokens {
  return {
    color: overrides.color ? { ...base.color, ...overrides.color } : { ...base.color },
    typography: overrides.typography
      ? { ...base.typography, ...overrides.typography }
      : { ...base.typography },
    radius: overrides.radius ? { ...base.radius, ...overrides.radius } : { ...base.radius },
    spacing: overrides.spacing ? { ...base.spacing, ...overrides.spacing } : { ...base.spacing },
  };
}

export function resolveTheme(base: ThemeTokens, overrides: Partial<ThemeTokens>): ThemeTokens {
  return deepFreeze(mergeTokens(base, overrides));
}
```

- [ ] **Step 8: Run resolve tests**

Run: `cd packages/theme-engine && pnpm test -- tests/resolve.test.ts`
Expected: PASS

- [ ] **Step 9: Write failing tests for css-variables**

Create `packages/theme-engine/tests/css-variables.test.ts`:

```ts
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
```

- [ ] **Step 10: Implement css-variables.ts**

Create `packages/theme-engine/src/css-variables.ts`:

```ts
import type { ThemeTokens } from "./tokens.js";

function camelToKebab(str: string): string {
  return str.replace(/[A-Z]/g, (char) => `-${char.toLowerCase()}`);
}

export function tokensToCssVariables(tokens: ThemeTokens): Record<string, string> {
  const vars: Record<string, string> = {};

  for (const [key, value] of Object.entries(tokens.color)) {
    vars[`--gq-color-${camelToKebab(key)}`] = value;
  }

  for (const [key, value] of Object.entries(tokens.typography)) {
    vars[`--gq-typography-${camelToKebab(key)}`] = value;
  }

  for (const [key, value] of Object.entries(tokens.radius)) {
    vars[`--gq-radius-${camelToKebab(key)}`] = value;
  }

  for (const [key, value] of Object.entries(tokens.spacing)) {
    vars[`--gq-spacing-${key}`] = value;
  }

  return vars;
}
```

- [ ] **Step 11: Run css-variables tests**

Run: `cd packages/theme-engine && pnpm test -- tests/css-variables.test.ts`
Expected: PASS

- [ ] **Step 12: Write failing tests for variants**

Create `packages/theme-engine/tests/variants.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { defaultVariants, resolveVariants, type ThemeComponentVariants } from "../src/index.js";

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
```

- [ ] **Step 13: Implement variants.ts**

Create `packages/theme-engine/src/variants.ts`:

```ts
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
```

- [ ] **Step 14: Implement index.ts and run all tests**

Create `packages/theme-engine/src/index.ts`:

```ts
export type { ThemeTokens } from "./tokens.js";
export { defaultTheme, defaultDarkTheme, warmSepiaTheme } from "./tokens.js";
export { resolveTheme, mergeTokens } from "./resolve.js";
export { tokensToCssVariables } from "./css-variables.js";
export type { ThemeComponentVariants } from "./variants.js";
export { defaultVariants, resolveVariants } from "./variants.js";
```

Run: `cd packages/theme-engine && pnpm install && pnpm test`
Expected: ALL PASS

- [ ] **Step 15: Commit**

```bash
git add packages/theme-engine/
git commit -m "feat: add theme-engine package with tokens, resolution, CSS variables, and variants"
```

---

### Task 2: Theme SDK — Zod Schemas and Validation

**Files:**

- Create: `packages/theme-sdk/package.json`
- Create: `packages/theme-sdk/tsconfig.json`
- Create: `packages/theme-sdk/vitest.config.ts`
- Create: `packages/theme-sdk/src/schemas.ts`
- Create: `packages/theme-sdk/src/types.ts`
- Create: `packages/theme-sdk/src/validation.ts`
- Create: `packages/theme-sdk/src/index.ts`
- Create: `packages/theme-sdk/tests/schemas.test.ts`
- Create: `packages/theme-sdk/tests/validation.test.ts`

**Interfaces:**

- Consumes: `ThemeTokens`, `ThemeComponentVariants` from `@glyphquire/theme-engine`
- Produces:
  - `themeTokensSchema: z.ZodType`
  - `themeComponentVariantsSchema: z.ZodType`
  - `themeManifestSchema: z.ZodType` → `ThemeManifest` type
  - `pluginManifestSchema: z.ZodType` → `PluginManifest` type
  - `validateThemeManifest(input: unknown): Result<ThemeManifest>`
  - `validateColorValue(value: string): boolean`
  - `validateFontValue(value: string): boolean`

- [ ] **Step 1: Create package scaffold**

Create `packages/theme-sdk/package.json`:

```json
{
  "name": "@glyphquire/theme-sdk",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "exports": {
    ".": {
      "import": "./src/index.ts",
      "types": "./src/index.ts"
    }
  },
  "scripts": {
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "zod": "catalog:"
  },
  "devDependencies": {
    "typescript": "catalog:",
    "vitest": "catalog:"
  }
}
```

Create `packages/theme-sdk/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "rootDir": "src",
    "outDir": "dist"
  },
  "include": ["src", "tests"]
}
```

Create `packages/theme-sdk/vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
  },
});
```

- [ ] **Step 2: Write failing tests for schemas**

Create `packages/theme-sdk/tests/schemas.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  themeTokensSchema,
  themeComponentVariantsSchema,
  themeManifestSchema,
  pluginManifestSchema,
} from "../src/index.js";

describe("themeTokensSchema", () => {
  it("accepts valid complete tokens", () => {
    const result = themeTokensSchema.safeParse({
      color: {
        background: "#fff",
        foreground: "#000",
        muted: "#999",
        accent: "#00f",
        border: "#ccc",
      },
      typography: {
        bodyFont: "Inter, sans-serif",
        headingFont: "Inter, sans-serif",
        monoFont: "monospace",
      },
      radius: { sm: "0.25rem", md: "0.5rem", lg: "1rem" },
      spacing: { xs: "0.25rem", sm: "0.5rem" },
    });
    expect(result.success).toBe(true);
  });

  it("rejects color values containing url()", () => {
    const result = themeTokensSchema.safeParse({
      color: {
        background: "url(evil)",
        foreground: "#000",
        muted: "#999",
        accent: "#00f",
        border: "#ccc",
      },
      typography: { bodyFont: "sans-serif", headingFont: "sans-serif", monoFont: "monospace" },
      radius: { sm: "0.25rem", md: "0.5rem", lg: "1rem" },
      spacing: {},
    });
    expect(result.success).toBe(false);
  });

  it("rejects font values containing url()", () => {
    const result = themeTokensSchema.safeParse({
      color: {
        background: "#fff",
        foreground: "#000",
        muted: "#999",
        accent: "#00f",
        border: "#ccc",
      },
      typography: { bodyFont: "url(evil)", headingFont: "sans-serif", monoFont: "monospace" },
      radius: { sm: "0.25rem", md: "0.5rem", lg: "1rem" },
      spacing: {},
    });
    expect(result.success).toBe(false);
  });
});

describe("themeComponentVariantsSchema", () => {
  it("accepts valid variants", () => {
    const result = themeComponentVariantsSchema.safeParse({
      heading: { decoration: "sparkle" },
      callout: { variant: "glass", animation: "glow" },
    });
    expect(result.success).toBe(true);
  });

  it("rejects invalid variant values", () => {
    const result = themeComponentVariantsSchema.safeParse({
      heading: { decoration: "invalid-value" },
    });
    expect(result.success).toBe(false);
  });
});

describe("themeManifestSchema", () => {
  it("accepts a minimal theme manifest", () => {
    const result = themeManifestSchema.safeParse({
      id: "my-theme",
      name: "My Theme",
      version: "1.0.0",
    });
    expect(result.success).toBe(true);
  });

  it("accepts a full theme manifest with tokens and darkTokens", () => {
    const result = themeManifestSchema.safeParse({
      id: "my-theme",
      name: "My Theme",
      version: "1.0.0",
      tokens: {
        color: {
          background: "#111",
          foreground: "#eee",
          muted: "#888",
          accent: "#00f",
          border: "#444",
        },
      },
      darkTokens: {
        color: {
          background: "#000",
          foreground: "#fff",
          muted: "#aaa",
          accent: "#0af",
          border: "#333",
        },
      },
      components: {
        heading: { decoration: "line" },
      },
    });
    expect(result.success).toBe(true);
  });
});

describe("pluginManifestSchema", () => {
  it("accepts a plugin manifest with themes", () => {
    const result = pluginManifestSchema.safeParse({
      id: "my-plugin",
      name: "My Plugin",
      version: "1.0.0",
      apiVersion: "1",
      themes: [{ id: "t1", name: "Theme 1", version: "1.0.0" }],
    });
    expect(result.success).toBe(true);
  });

  it("accepts empty optional fields", () => {
    const result = pluginManifestSchema.safeParse({
      id: "my-plugin",
      name: "My Plugin",
      version: "1.0.0",
      apiVersion: "1",
    });
    expect(result.success).toBe(true);
  });
});
```

- [ ] **Step 3: Write failing tests for validation**

Create `packages/theme-sdk/tests/validation.test.ts`:

```ts
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
```

- [ ] **Step 4: Implement schemas.ts**

Create `packages/theme-sdk/src/schemas.ts`:

```ts
import { z } from "zod";

const FORBIDDEN_CSS_PATTERN = /(?:url|expression|javascript)\s*\(/i;
const COLOR_PATTERN = /^(?:#[0-9a-fA-F]{3,8}|(?:rgb|rgba|hsl|hsla|oklch)\s*\(.*\))$/;

const safeColorSchema = z
  .string()
  .max(200)
  .refine((v) => !FORBIDDEN_CSS_PATTERN.test(v) && !v.includes("var("), {
    message: "Color value contains forbidden CSS pattern",
  });

const safeFontSchema = z
  .string()
  .max(500)
  .refine((v) => !FORBIDDEN_CSS_PATTERN.test(v), {
    message: "Font value contains forbidden CSS pattern",
  });

const safeCssLengthSchema = z.string().max(50);

export const themeTokensSchema = z
  .object({
    color: z
      .object({
        background: safeColorSchema,
        foreground: safeColorSchema,
        muted: safeColorSchema,
        accent: safeColorSchema,
        border: safeColorSchema,
      })
      .strict(),
    typography: z
      .object({
        bodyFont: safeFontSchema,
        headingFont: safeFontSchema,
        monoFont: safeFontSchema,
      })
      .strict(),
    radius: z
      .object({
        sm: safeCssLengthSchema,
        md: safeCssLengthSchema,
        lg: safeCssLengthSchema,
      })
      .strict(),
    spacing: z.record(z.string().max(30), safeCssLengthSchema),
  })
  .strict();

export const partialThemeTokensSchema = themeTokensSchema.deepPartial();

export const themeComponentVariantsSchema = z
  .object({
    heading: z
      .object({ decoration: z.enum(["none", "sparkle", "line"]) })
      .strict()
      .optional(),
    quote: z
      .object({ variant: z.enum(["plain", "sticky", "paper"]) })
      .strict()
      .optional(),
    callout: z
      .object({
        variant: z.enum(["solid", "glass", "outline"]),
        animation: z.enum(["none", "glow", "lift"]).optional(),
      })
      .strict()
      .optional(),
    code: z
      .object({ variant: z.enum(["plain", "terminal"]) })
      .strict()
      .optional(),
    toggle: z
      .object({ variant: z.enum(["plain", "card"]) })
      .strict()
      .optional(),
    tabs: z
      .object({ variant: z.enum(["plain", "pill", "underline"]) })
      .strict()
      .optional(),
    stickyNote: z
      .object({ variant: z.enum(["plain", "paper", "neon"]) })
      .strict()
      .optional(),
  })
  .strict()
  .optional();

export const themeManifestSchema = z
  .object({
    id: z.string().min(1).max(100),
    name: z.string().min(1).max(200),
    version: z.string().min(1).max(50),
    tokens: partialThemeTokensSchema.optional(),
    darkTokens: partialThemeTokensSchema.optional(),
    components: themeComponentVariantsSchema,
  })
  .strict();

export const blockManifestSchema = z
  .object({
    name: z.string().min(1).max(100),
    version: z.number().int().positive(),
    kind: z.enum(["container", "leaf", "text"]),
  })
  .strict();

export const runtimeManifestSchema = z
  .object({
    name: z.string().min(1).max(100),
    entrypoint: z.string().min(1).max(500),
  })
  .strict();

export const pluginPermissionSchema = z.string().min(1).max(100);

export const pluginManifestSchema = z
  .object({
    id: z.string().min(1).max(100),
    name: z.string().min(1).max(200),
    version: z.string().min(1).max(50),
    apiVersion: z.string().min(1).max(20),
    blocks: z.array(blockManifestSchema).optional(),
    themes: z.array(themeManifestSchema).optional(),
    runtimes: z.array(runtimeManifestSchema).optional(),
    permissions: z.array(pluginPermissionSchema).optional(),
  })
  .strict();

export function isValidColorValue(value: string): boolean {
  return !FORBIDDEN_CSS_PATTERN.test(value) && !value.includes("var(");
}

export function isValidFontValue(value: string): boolean {
  return !FORBIDDEN_CSS_PATTERN.test(value);
}
```

- [ ] **Step 5: Implement types.ts**

Create `packages/theme-sdk/src/types.ts`:

```ts
import type { z } from "zod";
import type {
  themeManifestSchema,
  pluginManifestSchema,
  themeTokensSchema,
  themeComponentVariantsSchema,
  blockManifestSchema,
  runtimeManifestSchema,
} from "./schemas.js";

export type ThemeManifest = z.infer<typeof themeManifestSchema>;
export type PluginManifest = z.infer<typeof pluginManifestSchema>;
export type ThemeTokensInput = z.infer<typeof themeTokensSchema>;
export type ThemeComponentVariantsInput = z.infer<typeof themeComponentVariantsSchema>;
export type BlockManifest = z.infer<typeof blockManifestSchema>;
export type RuntimeManifest = z.infer<typeof runtimeManifestSchema>;
```

- [ ] **Step 6: Implement validation.ts**

Create `packages/theme-sdk/src/validation.ts`:

```ts
import { themeManifestSchema, isValidColorValue, isValidFontValue } from "./schemas.js";
import type { ThemeManifest } from "./types.js";

export interface ValidationOk {
  readonly ok: true;
  readonly value: ThemeManifest;
}

export interface ValidationError {
  readonly ok: false;
  readonly errors: readonly string[];
}

export type ValidationResult = ValidationOk | ValidationError;

export function validateThemeManifest(input: unknown): ValidationResult {
  const result = themeManifestSchema.safeParse(input);
  if (result.success) {
    return { ok: true, value: result.data };
  }
  return {
    ok: false,
    errors: result.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`),
  };
}

export { isValidColorValue as validateColorValue, isValidFontValue as validateFontValue };
```

- [ ] **Step 7: Implement index.ts**

Create `packages/theme-sdk/src/index.ts`:

```ts
export {
  themeTokensSchema,
  partialThemeTokensSchema,
  themeComponentVariantsSchema,
  themeManifestSchema,
  pluginManifestSchema,
  blockManifestSchema,
  runtimeManifestSchema,
  pluginPermissionSchema,
  isValidColorValue,
  isValidFontValue,
} from "./schemas.js";
export type {
  ThemeManifest,
  PluginManifest,
  ThemeTokensInput,
  ThemeComponentVariantsInput,
  BlockManifest,
  RuntimeManifest,
} from "./types.js";
export {
  validateThemeManifest,
  validateColorValue,
  validateFontValue,
  type ValidationResult,
  type ValidationOk,
  type ValidationError,
} from "./validation.js";
```

- [ ] **Step 8: Run all tests**

Run: `cd packages/theme-sdk && pnpm install && pnpm test`
Expected: ALL PASS

- [ ] **Step 9: Commit**

```bash
git add packages/theme-sdk/
git commit -m "feat: add theme-sdk package with Zod schemas, validation, and plugin manifest types"
```

---

### Task 3: Database — Theme Tables and Migration

**Files:**

- Create: `packages/database/src/migrations/0004_phase3_themes.sql`
- Create: `packages/database/src/schema/themes.ts`
- Create: `packages/database/src/schema/user-themes.ts`
- Modify: `packages/database/src/schema/index.ts`
- Modify: `packages/database/src/index.ts`

**Interfaces:**

- Consumes: existing `workspaces`, `user` tables from `packages/database`
- Produces:
  - `themes` Drizzle table (id, workspace_id, name, version, tokens, dark_tokens, components, is_system, revision, created_at, updated_at)
  - `userThemes` Drizzle table (id, user_id, workspace_id, theme_id, custom_overrides, created_at, updated_at)
  - `Theme`, `NewTheme`, `UserTheme`, `NewUserTheme` type exports

- [ ] **Step 1: Create the SQL migration**

Create `packages/database/src/migrations/0004_phase3_themes.sql`:

```sql
CREATE TABLE "themes" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workspace_id" uuid REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "name" varchar(200) NOT NULL,
  "version" varchar(50) NOT NULL,
  "tokens" jsonb DEFAULT '{}' NOT NULL,
  "dark_tokens" jsonb,
  "components" jsonb,
  "is_system" boolean DEFAULT false NOT NULL,
  "revision" integer DEFAULT 1 NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "themes_revision_positive_check" CHECK ("themes"."revision" > 0),
  CONSTRAINT "themes_system_workspace_null_check" CHECK (
    ("themes"."is_system" = true AND "themes"."workspace_id" IS NULL) OR
    ("themes"."is_system" = false AND "themes"."workspace_id" IS NOT NULL)
  ),
  CONSTRAINT "themes_name_length_check" CHECK (char_length("themes"."name") BETWEEN 1 AND 200)
);

CREATE UNIQUE INDEX "themes_workspace_name_unique"
  ON "themes" ("workspace_id", "name")
  WHERE "workspace_id" IS NOT NULL;

CREATE INDEX "themes_workspace_id_idx" ON "themes" ("workspace_id");

CREATE TABLE "user_themes" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "theme_id" uuid NOT NULL REFERENCES "themes"("id") ON DELETE CASCADE,
  "custom_overrides" jsonb,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);

CREATE UNIQUE INDEX "user_themes_user_workspace_unique"
  ON "user_themes" ("user_id", "workspace_id");

-- Seed system themes
INSERT INTO "themes" ("id", "name", "version", "tokens", "dark_tokens", "is_system") VALUES
  (
    '00000000-0000-4000-8000-000000000001',
    'Default Light',
    '1.0.0',
    '{"color":{"background":"#ffffff","foreground":"#1a1a1a","muted":"#6b7280","accent":"#2563eb","border":"#e5e7eb"},"typography":{"bodyFont":"''Inter'', ''Noto Sans TC'', system-ui, sans-serif","headingFont":"''Inter'', ''Noto Sans TC'', system-ui, sans-serif","monoFont":"''JetBrains Mono'', ''Fira Code'', ui-monospace, monospace"},"radius":{"sm":"0.25rem","md":"0.5rem","lg":"0.75rem"},"spacing":{"xs":"0.25rem","sm":"0.5rem","md":"1rem","lg":"1.5rem","xl":"2rem","2xl":"3rem"}}',
    NULL,
    true
  ),
  (
    '00000000-0000-4000-8000-000000000002',
    'Default Dark',
    '1.0.0',
    '{"color":{"background":"#0f172a","foreground":"#f1f5f9","muted":"#94a3b8","accent":"#60a5fa","border":"#334155"},"typography":{"bodyFont":"''Inter'', ''Noto Sans TC'', system-ui, sans-serif","headingFont":"''Inter'', ''Noto Sans TC'', system-ui, sans-serif","monoFont":"''JetBrains Mono'', ''Fira Code'', ui-monospace, monospace"},"radius":{"sm":"0.25rem","md":"0.5rem","lg":"0.75rem"},"spacing":{"xs":"0.25rem","sm":"0.5rem","md":"1rem","lg":"1.5rem","xl":"2rem","2xl":"3rem"}}',
    NULL,
    true
  ),
  (
    '00000000-0000-4000-8000-000000000003',
    'Warm Sepia',
    '1.0.0',
    '{"color":{"background":"#fdf6e3","foreground":"#3b2e1a","muted":"#8b7355","accent":"#b58900","border":"#e0d5b7"},"typography":{"bodyFont":"''Georgia'', ''Noto Serif TC'', serif","headingFont":"''Georgia'', ''Noto Serif TC'', serif","monoFont":"''JetBrains Mono'', ''Fira Code'', ui-monospace, monospace"},"radius":{"sm":"0.25rem","md":"0.375rem","lg":"0.5rem"},"spacing":{"xs":"0.25rem","sm":"0.5rem","md":"1rem","lg":"1.5rem","xl":"2rem","2xl":"3rem"}}',
    NULL,
    true
  );
```

- [ ] **Step 2: Create Drizzle schema for themes**

Create `packages/database/src/schema/themes.ts`:

```ts
import { relations, sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { user } from "./auth.js";
import { workspaces } from "./workspaces.js";

export const themes = pgTable(
  "themes",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id").references(() => workspaces.id, { onDelete: "cascade" }),
    name: varchar("name", { length: 200 }).notNull(),
    version: varchar("version", { length: 50 }).notNull(),
    tokens: jsonb("tokens").default({}).notNull(),
    darkTokens: jsonb("dark_tokens"),
    components: jsonb("components"),
    isSystem: boolean("is_system").default(false).notNull(),
    revision: integer("revision").default(1).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [
    uniqueIndex("themes_workspace_name_unique")
      .on(table.workspaceId, table.name)
      .where(sql`${table.workspaceId} IS NOT NULL`),
    index("themes_workspace_id_idx").on(table.workspaceId),
    check("themes_revision_positive_check", sql`${table.revision} > 0`),
    check(
      "themes_system_workspace_null_check",
      sql`(${table.isSystem} = true AND ${table.workspaceId} IS NULL) OR (${table.isSystem} = false AND ${table.workspaceId} IS NOT NULL)`,
    ),
    check("themes_name_length_check", sql`char_length(${table.name}) between 1 and 200`),
  ],
);

export const themesRelations = relations(themes, ({ one }) => ({
  workspace: one(workspaces, {
    fields: [themes.workspaceId],
    references: [workspaces.id],
  }),
}));

export const userThemes = pgTable(
  "user_themes",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    themeId: uuid("theme_id")
      .notNull()
      .references(() => themes.id, { onDelete: "cascade" }),
    customOverrides: jsonb("custom_overrides"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [uniqueIndex("user_themes_user_workspace_unique").on(table.userId, table.workspaceId)],
);

export const userThemesRelations = relations(userThemes, ({ one }) => ({
  user: one(user, { fields: [userThemes.userId], references: [user.id] }),
  workspace: one(workspaces, { fields: [userThemes.workspaceId], references: [workspaces.id] }),
  theme: one(themes, { fields: [userThemes.themeId], references: [themes.id] }),
}));
```

- [ ] **Step 3: Update schema/index.ts to export themes**

Add to `packages/database/src/schema/index.ts`:

```ts
export { themes, themesRelations, userThemes, userThemesRelations } from "./themes.js";
```

- [ ] **Step 4: Update database index.ts to export theme types**

Add to `packages/database/src/index.ts` — in the import section and type exports:

```ts
import type { themes, userThemes } from "./schema/index.js";
// ... in re-exports:
export { themes, themesRelations, userThemes, userThemesRelations } from "./schema/index.js";
// ... in type aliases:
export type Theme = InferSelectModel<typeof themes>;
export type NewTheme = InferInsertModel<typeof themes>;
export type UserTheme = InferSelectModel<typeof userThemes>;
export type NewUserTheme = InferInsertModel<typeof userThemes>;
```

- [ ] **Step 5: Run Drizzle generate to verify migration aligns with schema**

Run: `pnpm db:generate`
Expected: no new migration generated (our hand-written migration should match)

- [ ] **Step 6: Run typecheck**

Run: `pnpm --filter @glyphquire/database typecheck`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add packages/database/src/migrations/0004_phase3_themes.sql packages/database/src/schema/themes.ts packages/database/src/schema/index.ts packages/database/src/index.ts
git commit -m "feat: add themes and user_themes tables with system theme seed"
```

---

### Task 4: API Contract — Theme Endpoint Schemas

**Files:**

- Create: `packages/api-contract/src/themes/schemas.ts`
- Create: `packages/api-contract/src/themes/types.ts`
- Modify: `packages/api-contract/src/index.ts`

**Interfaces:**

- Consumes: `canonicalUuidSchema`, `cursorPaginationQuerySchema`, `requestIdSchema` from `@glyphquire/api-contract`, `partialThemeTokensSchema`, `themeComponentVariantsSchema` from `@glyphquire/theme-sdk`
- Produces:
  - `createThemeInputSchema`, `updateThemeInputSchema`, `setUserThemeInputSchema` Zod schemas
  - `themeResultSchema`, `themeListResultSchema`, `userThemeResultSchema` Zod schemas
  - `ThemeResult`, `ThemeListResult`, `UserThemeResult`, `CreateThemeInput`, `UpdateThemeInput`, `SetUserThemeInput` types

- [ ] **Step 1: Create theme API schemas**

Create `packages/api-contract/src/themes/schemas.ts`:

```ts
import { z } from "zod";
import {
  canonicalUuidSchema,
  requestIdSchema,
  cursorPaginationQuerySchema,
} from "../notes/schemas.js";
import { partialThemeTokensSchema, themeComponentVariantsSchema } from "@glyphquire/theme-sdk";

export const themeIdParamsSchema = z
  .object({
    themeId: canonicalUuidSchema,
  })
  .strict();

export const createThemeInputSchema = z
  .object({
    operationId: requestIdSchema,
    name: z.string().min(1).max(200),
    version: z.string().min(1).max(50),
    tokens: partialThemeTokensSchema.optional(),
    darkTokens: partialThemeTokensSchema.optional(),
    components: themeComponentVariantsSchema,
  })
  .strict();

export const updateThemeInputSchema = z
  .object({
    operationId: requestIdSchema,
    baseRevision: z.number().int().positive(),
    name: z.string().min(1).max(200).optional(),
    version: z.string().min(1).max(50).optional(),
    tokens: partialThemeTokensSchema.optional(),
    darkTokens: partialThemeTokensSchema.optional(),
    components: themeComponentVariantsSchema,
  })
  .strict();

export const setUserThemeInputSchema = z
  .object({
    themeId: canonicalUuidSchema,
    customOverrides: partialThemeTokensSchema.optional(),
  })
  .strict();

export const themeResultSchema = z.object({
  id: z.string(),
  workspaceId: z.string().nullable(),
  name: z.string(),
  version: z.string(),
  tokens: z.record(z.unknown()),
  darkTokens: z.record(z.unknown()).nullable(),
  components: z.record(z.unknown()).nullable(),
  isSystem: z.boolean(),
  revision: z.number(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const themeListResultSchema = z.object({
  items: z.array(themeResultSchema),
});

export const userThemeResultSchema = z.object({
  themeId: z.string(),
  theme: themeResultSchema,
  customOverrides: z.record(z.unknown()).nullable(),
  resolvedTokens: z.record(z.string(), z.string()),
});

export { cursorPaginationQuerySchema };
```

- [ ] **Step 2: Create theme types**

Create `packages/api-contract/src/themes/types.ts`:

```ts
import type { z } from "zod";
import type {
  createThemeInputSchema,
  updateThemeInputSchema,
  setUserThemeInputSchema,
  themeResultSchema,
  themeListResultSchema,
  userThemeResultSchema,
} from "./schemas.js";

export type CreateThemeInput = z.infer<typeof createThemeInputSchema>;
export type UpdateThemeInput = z.infer<typeof updateThemeInputSchema>;
export type SetUserThemeInput = z.infer<typeof setUserThemeInputSchema>;
export type ThemeResult = z.infer<typeof themeResultSchema>;
export type ThemeListResult = z.infer<typeof themeListResultSchema>;
export type UserThemeResult = z.infer<typeof userThemeResultSchema>;
```

- [ ] **Step 3: Update api-contract index.ts**

Add to `packages/api-contract/src/index.ts`:

```ts
export * from "./themes/schemas.js";
export * from "./themes/types.js";
```

- [ ] **Step 4: Run typecheck**

Run: `pnpm --filter @glyphquire/api-contract typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/api-contract/src/themes/
git add packages/api-contract/src/index.ts
git commit -m "feat: add theme API contract schemas and types"
```

---

### Task 5: ThemeService — Backend CRUD with Tenant Isolation

**Files:**

- Create: `apps/api/src/modules/themes/ThemeService.ts`
- Create: `apps/api/src/modules/themes/ThemeService.integration.test.ts`

**Interfaces:**

- Consumes: `Database`, `themes`, `userThemes`, `workspaceMembers` from `@glyphquire/database`; `CreateThemeInput`, `UpdateThemeInput`, `SetUserThemeInput` from `@glyphquire/api-contract`; `resolveTheme`, `tokensToCssVariables`, `defaultTheme`, `defaultDarkTheme` from `@glyphquire/theme-engine`
- Produces:
  - `ThemeService` interface: `list(actorId, workspaceId)`, `create(actorId, workspaceId, input)`, `get(actorId, themeId)`, `update(actorId, themeId, input)`, `remove(actorId, themeId)`, `getUserTheme(actorId, workspaceId)`, `setUserTheme(actorId, workspaceId, input)`
  - `ThemeServiceImpl` class implementing `ThemeService`

- [ ] **Step 1: Write failing integration tests**

Create `apps/api/src/modules/themes/ThemeService.integration.test.ts`:

```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDb, type Database } from "@glyphquire/database";
import { ThemeServiceImpl, type ThemeService } from "./ThemeService.js";

const TEST_DATABASE_URL =
  process.env.DATABASE_URL ?? "postgres://gq_app:gq_app_dev@localhost:5432/glyphquire_dev";

describe("ThemeService", () => {
  let db: Database;
  let service: ThemeService;
  let testUserId: string;
  let testWorkspaceId: string;

  beforeAll(async () => {
    db = createDb(TEST_DATABASE_URL);
    service = new ThemeServiceImpl(db);
  });

  afterAll(async () => {
    await db.$client.end();
  });

  beforeEach(async () => {
    // Create test user and workspace via raw SQL to avoid coupling to other services
    const userResult = await db.execute(
      `INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at)
       VALUES (gen_random_uuid(), 'Test User', 'theme-test-' || gen_random_uuid() || '@test.com', true, now(), now())
       RETURNING id`,
    );
    testUserId = (userResult.rows[0] as { id: string }).id;
    const wsResult = await db.execute(
      `INSERT INTO workspaces (id, name, owner_id, created_at, updated_at)
       VALUES (gen_random_uuid(), 'Test WS', '${testUserId}', now(), now()) RETURNING id`,
    );
    testWorkspaceId = (wsResult.rows[0] as { id: string }).id;
    await db.execute(
      `INSERT INTO workspace_members (workspace_id, user_id, role, created_at, updated_at)
       VALUES ('${testWorkspaceId}', '${testUserId}', 'owner', now(), now())`,
    );
  });

  it("list returns system themes plus workspace themes", async () => {
    const result = await service.list(testUserId, testWorkspaceId);
    expect(result.items.length).toBeGreaterThanOrEqual(3);
    expect(result.items.some((t) => t.name === "Default Light")).toBe(true);
    expect(result.items.some((t) => t.name === "Default Dark")).toBe(true);
    expect(result.items.some((t) => t.name === "Warm Sepia")).toBe(true);
  });

  it("creates a workspace theme", async () => {
    const created = await service.create(testUserId, testWorkspaceId, {
      operationId: crypto.randomUUID(),
      name: "Custom Theme",
      version: "1.0.0",
      tokens: {
        color: {
          background: "#111",
          foreground: "#eee",
          muted: "#888",
          accent: "#00f",
          border: "#444",
        },
      },
    });
    expect(created.name).toBe("Custom Theme");
    expect(created.isSystem).toBe(false);
    expect(created.workspaceId).toBe(testWorkspaceId);
  });

  it("rejects deletion of system themes", async () => {
    const list = await service.list(testUserId, testWorkspaceId);
    const systemTheme = list.items.find((t) => t.isSystem);
    expect(systemTheme).toBeDefined();
    await expect(service.remove(testUserId, systemTheme!.id)).rejects.toThrow();
  });

  it("update uses CAS with baseRevision", async () => {
    const created = await service.create(testUserId, testWorkspaceId, {
      operationId: crypto.randomUUID(),
      name: "CAS Theme",
      version: "1.0.0",
    });
    const updated = await service.update(testUserId, created.id, {
      operationId: crypto.randomUUID(),
      baseRevision: created.revision,
      name: "Updated CAS Theme",
    });
    expect(updated.revision).toBe(created.revision + 1);
    await expect(
      service.update(testUserId, created.id, {
        operationId: crypto.randomUUID(),
        baseRevision: created.revision,
        name: "Stale update",
      }),
    ).rejects.toThrow();
  });

  it("sets and gets user active theme", async () => {
    const list = await service.list(testUserId, testWorkspaceId);
    const defaultLight = list.items.find((t) => t.name === "Default Light")!;

    await service.setUserTheme(testUserId, testWorkspaceId, {
      themeId: defaultLight.id,
      customOverrides: {
        color: {
          background: "#fafafa",
          foreground: "#1a1a1a",
          muted: "#6b7280",
          accent: "#2563eb",
          border: "#e5e7eb",
        },
      },
    });

    const userTheme = await service.getUserTheme(testUserId, testWorkspaceId);
    expect(userTheme.themeId).toBe(defaultLight.id);
    expect(userTheme.customOverrides).toBeDefined();
    expect(userTheme.resolvedTokens["--gq-color-background"]).toBe("#fafafa");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @glyphquire/api test:integration -- --grep ThemeService`
Expected: FAIL — module not found

- [ ] **Step 3: Implement ThemeService.ts**

Create `apps/api/src/modules/themes/ThemeService.ts`:

```ts
import { themes, userThemes, workspaceMembers, type Database } from "@glyphquire/database";
import type {
  CreateThemeInput,
  UpdateThemeInput,
  SetUserThemeInput,
  ThemeResult,
  ThemeListResult,
  UserThemeResult,
} from "@glyphquire/api-contract";
import {
  resolveTheme,
  tokensToCssVariables,
  defaultTheme,
  defaultDarkTheme,
  type ThemeTokens,
} from "@glyphquire/theme-engine";
import { and, eq, isNull, or } from "drizzle-orm";
import { PublicApiError } from "../../middleware/error-handler.js";

export interface ThemeService {
  list(actorId: string, workspaceId: string): Promise<ThemeListResult>;
  create(actorId: string, workspaceId: string, input: CreateThemeInput): Promise<ThemeResult>;
  get(actorId: string, themeId: string): Promise<ThemeResult>;
  update(actorId: string, themeId: string, input: UpdateThemeInput): Promise<ThemeResult>;
  remove(actorId: string, themeId: string): Promise<void>;
  getUserTheme(actorId: string, workspaceId: string): Promise<UserThemeResult>;
  setUserTheme(
    actorId: string,
    workspaceId: string,
    input: SetUserThemeInput,
  ): Promise<UserThemeResult>;
}

function toResult(row: typeof themes.$inferSelect): ThemeResult {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    name: row.name,
    version: row.version,
    tokens: row.tokens as Record<string, unknown>,
    darkTokens: row.darkTokens as Record<string, unknown> | null,
    components: row.components as Record<string, unknown> | null,
    isSystem: row.isSystem,
    revision: row.revision,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export class ThemeServiceImpl implements ThemeService {
  constructor(private readonly db: Database) {}

  private async requireMembership(actorId: string, workspaceId: string): Promise<void> {
    const [member] = await this.db
      .select()
      .from(workspaceMembers)
      .where(
        and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, actorId)),
      )
      .limit(1);
    if (!member) throw new PublicApiError("NOT_FOUND", 404);
  }

  async list(actorId: string, workspaceId: string): Promise<ThemeListResult> {
    await this.requireMembership(actorId, workspaceId);
    const rows = await this.db
      .select()
      .from(themes)
      .where(or(eq(themes.workspaceId, workspaceId), isNull(themes.workspaceId)));
    return { items: rows.map(toResult) };
  }

  async create(
    actorId: string,
    workspaceId: string,
    input: CreateThemeInput,
  ): Promise<ThemeResult> {
    await this.requireMembership(actorId, workspaceId);
    const [row] = await this.db
      .insert(themes)
      .values({
        workspaceId,
        name: input.name,
        version: input.version,
        tokens: input.tokens ?? {},
        darkTokens: input.darkTokens ?? null,
        components: input.components ?? null,
        isSystem: false,
      })
      .returning();
    if (!row) throw new PublicApiError("SERVICE_UNAVAILABLE", 503);
    return toResult(row);
  }

  async get(actorId: string, themeId: string): Promise<ThemeResult> {
    const [row] = await this.db.select().from(themes).where(eq(themes.id, themeId)).limit(1);
    if (!row) throw new PublicApiError("NOT_FOUND", 404);
    if (row.workspaceId) await this.requireMembership(actorId, row.workspaceId);
    return toResult(row);
  }

  async update(actorId: string, themeId: string, input: UpdateThemeInput): Promise<ThemeResult> {
    const [existing] = await this.db.select().from(themes).where(eq(themes.id, themeId)).limit(1);
    if (!existing) throw new PublicApiError("NOT_FOUND", 404);
    if (existing.isSystem) throw new PublicApiError("DOCUMENT_INVALID", 400);
    if (!existing.workspaceId) throw new PublicApiError("DOCUMENT_INVALID", 400);
    await this.requireMembership(actorId, existing.workspaceId);

    if (existing.revision !== input.baseRevision) {
      throw new PublicApiError("CONFLICT", 409);
    }

    const updates: Record<string, unknown> = {
      revision: existing.revision + 1,
      updatedAt: new Date(),
    };
    if (input.name !== undefined) updates.name = input.name;
    if (input.version !== undefined) updates.version = input.version;
    if (input.tokens !== undefined) updates.tokens = input.tokens;
    if (input.darkTokens !== undefined) updates.darkTokens = input.darkTokens;
    if (input.components !== undefined) updates.components = input.components;

    const [row] = await this.db
      .update(themes)
      .set(updates)
      .where(and(eq(themes.id, themeId), eq(themes.revision, input.baseRevision)))
      .returning();
    if (!row) throw new PublicApiError("CONFLICT", 409);
    return toResult(row);
  }

  async remove(actorId: string, themeId: string): Promise<void> {
    const [existing] = await this.db.select().from(themes).where(eq(themes.id, themeId)).limit(1);
    if (!existing) throw new PublicApiError("NOT_FOUND", 404);
    if (existing.isSystem) throw new PublicApiError("DOCUMENT_INVALID", 400);
    if (!existing.workspaceId) throw new PublicApiError("DOCUMENT_INVALID", 400);
    await this.requireMembership(actorId, existing.workspaceId);
    await this.db.delete(themes).where(eq(themes.id, themeId));
  }

  async getUserTheme(actorId: string, workspaceId: string): Promise<UserThemeResult> {
    await this.requireMembership(actorId, workspaceId);
    const [ut] = await this.db
      .select()
      .from(userThemes)
      .where(and(eq(userThemes.userId, actorId), eq(userThemes.workspaceId, workspaceId)))
      .limit(1);

    let themeRow: typeof themes.$inferSelect;
    if (ut) {
      const [t] = await this.db.select().from(themes).where(eq(themes.id, ut.themeId)).limit(1);
      if (!t) throw new PublicApiError("NOT_FOUND", 404);
      themeRow = t;
    } else {
      const [t] = await this.db
        .select()
        .from(themes)
        .where(and(eq(themes.isSystem, true), eq(themes.name, "Default Light")))
        .limit(1);
      if (!t) throw new PublicApiError("SERVICE_UNAVAILABLE", 503);
      themeRow = t;
    }

    const baseTokens = (themeRow.tokens ?? {}) as Partial<ThemeTokens>;
    const overrides = (ut?.customOverrides ?? {}) as Partial<ThemeTokens>;
    const resolved = resolveTheme(defaultTheme, { ...baseTokens, ...overrides });
    const cssVars = tokensToCssVariables(resolved);

    return {
      themeId: themeRow.id,
      theme: toResult(themeRow),
      customOverrides: (ut?.customOverrides as Record<string, unknown>) ?? null,
      resolvedTokens: cssVars,
    };
  }

  async setUserTheme(
    actorId: string,
    workspaceId: string,
    input: SetUserThemeInput,
  ): Promise<UserThemeResult> {
    await this.requireMembership(actorId, workspaceId);
    const [themeRow] = await this.db
      .select()
      .from(themes)
      .where(eq(themes.id, input.themeId))
      .limit(1);
    if (!themeRow) throw new PublicApiError("NOT_FOUND", 404);

    const [existing] = await this.db
      .select()
      .from(userThemes)
      .where(and(eq(userThemes.userId, actorId), eq(userThemes.workspaceId, workspaceId)))
      .limit(1);

    if (existing) {
      await this.db
        .update(userThemes)
        .set({
          themeId: input.themeId,
          customOverrides: input.customOverrides ?? null,
          updatedAt: new Date(),
        })
        .where(eq(userThemes.id, existing.id));
    } else {
      await this.db.insert(userThemes).values({
        userId: actorId,
        workspaceId,
        themeId: input.themeId,
        customOverrides: input.customOverrides ?? null,
      });
    }

    return this.getUserTheme(actorId, workspaceId);
  }
}
```

- [ ] **Step 4: Run integration tests**

Run: `pnpm --filter @glyphquire/api test:integration -- --grep ThemeService`
Expected: PASS (after running migration)

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/themes/
git commit -m "feat: add ThemeService with CRUD, CAS, tenant isolation, and user theme"
```

---

### Task 6: Theme API Routes and App Wiring

**Files:**

- Create: `apps/api/src/routes/v1/themes.ts`
- Create: `apps/api/src/routes/v1/themes.integration.test.ts`
- Modify: `apps/api/src/app.ts`

**Interfaces:**

- Consumes: `ThemeService` from Task 5; `createThemeInputSchema`, `updateThemeInputSchema`, `setUserThemeInputSchema`, `themeIdParamsSchema` from Task 4; `getRequestContext` from existing middleware
- Produces: 7 route handlers mounted at `/api/v1`

- [ ] **Step 1: Implement theme routes**

Create `apps/api/src/routes/v1/themes.ts`:

```ts
import {
  createThemeInputSchema,
  updateThemeInputSchema,
  setUserThemeInputSchema,
  themeIdParamsSchema,
  workspaceIdParamsSchema,
} from "@glyphquire/api-contract";
import { Hono } from "hono";
import { PublicApiError } from "../../middleware/error-handler.js";
import { getRequestContext } from "../../middleware/request-context.js";
import type { SecurityVariables } from "../../middleware/security.js";
import type { ThemeService } from "../../modules/themes/ThemeService.js";

function invalidRequest(): never {
  throw new PublicApiError("DOCUMENT_INVALID", 400);
}

async function parseJsonBody(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    invalidRequest();
  }
}

export function createThemeRoutes(themeService: ThemeService) {
  return new Hono<{ Variables: SecurityVariables }>()
    .get("/workspaces/:workspaceId/themes", async (context) => {
      const params = workspaceIdParamsSchema.safeParse({
        workspaceId: context.req.param("workspaceId"),
      });
      if (!params.success) invalidRequest();
      const { actorId } = getRequestContext(context);
      const result = await themeService.list(actorId, params.data.workspaceId);
      return context.json(result, 200);
    })
    .post("/workspaces/:workspaceId/themes", async (context) => {
      const params = workspaceIdParamsSchema.safeParse({
        workspaceId: context.req.param("workspaceId"),
      });
      if (!params.success) invalidRequest();
      const body = createThemeInputSchema.safeParse(await parseJsonBody(context.req.raw));
      if (!body.success) invalidRequest();
      const { actorId } = getRequestContext(context);
      const result = await themeService.create(actorId, params.data.workspaceId, body.data);
      return context.json(result, 201);
    })
    .get("/themes/:themeId", async (context) => {
      const params = themeIdParamsSchema.safeParse({ themeId: context.req.param("themeId") });
      if (!params.success) invalidRequest();
      const { actorId } = getRequestContext(context);
      const result = await themeService.get(actorId, params.data.themeId);
      return context.json(result, 200);
    })
    .put("/themes/:themeId", async (context) => {
      const params = themeIdParamsSchema.safeParse({ themeId: context.req.param("themeId") });
      if (!params.success) invalidRequest();
      const body = updateThemeInputSchema.safeParse(await parseJsonBody(context.req.raw));
      if (!body.success) invalidRequest();
      const { actorId } = getRequestContext(context);
      const result = await themeService.update(actorId, params.data.themeId, body.data);
      return context.json(result, 200);
    })
    .delete("/themes/:themeId", async (context) => {
      const params = themeIdParamsSchema.safeParse({ themeId: context.req.param("themeId") });
      if (!params.success) invalidRequest();
      const { actorId } = getRequestContext(context);
      await themeService.remove(actorId, params.data.themeId);
      return context.json({ ok: true }, 200);
    })
    .get("/user-theme", async (context) => {
      const { actorId } = getRequestContext(context);
      const workspaceId = context.req.query("workspaceId");
      if (!workspaceId) invalidRequest();
      const result = await themeService.getUserTheme(actorId, workspaceId);
      return context.json(result, 200);
    })
    .put("/user-theme", async (context) => {
      const { actorId } = getRequestContext(context);
      const workspaceId = context.req.query("workspaceId");
      if (!workspaceId) invalidRequest();
      const body = setUserThemeInputSchema.safeParse(await parseJsonBody(context.req.raw));
      if (!body.success) invalidRequest();
      const result = await themeService.setUserTheme(actorId, workspaceId, body.data);
      return context.json(result, 200);
    });
}
```

- [ ] **Step 2: Wire theme routes into app.ts**

In `apps/api/src/app.ts`, add:

Import:

```ts
import { ThemeServiceImpl, type ThemeService } from "./modules/themes/ThemeService.js";
import { createThemeRoutes } from "./routes/v1/themes.js";
```

In `AppDependencies` interface add `themeService?: ThemeService;`.

In `createAppRuntime`, after `const noteService = ...`:

```ts
const themeService = dependencies.themeService ?? new ThemeServiceImpl(db);
```

After the `.route("/api/v1", createVersionRoutes(noteService))` line:

```ts
.route("/api/v1", createThemeRoutes(themeService))
```

- [ ] **Step 3: Write integration tests for routes**

Create `apps/api/src/routes/v1/themes.integration.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../app.js";

const TEST_ENV = {
  DATABASE_URL:
    process.env.DATABASE_URL ?? "postgres://gq_app:gq_app_dev@localhost:5432/glyphquire_dev",
  BETTER_AUTH_URL: "http://localhost:3001",
  WEB_ORIGIN: "http://localhost:5173",
  BETTER_AUTH_SECRET: "test-secret-at-least-32-characters-long!!",
  TRUSTED_PROXY_CIDRS: "",
  FORWARDED_IP_HEADER: "",
};

describe("Theme API routes", () => {
  let app: ReturnType<typeof createApp>;

  beforeAll(() => {
    app = createApp(TEST_ENV);
  });

  it("GET /api/v1/workspaces/:id/themes returns 401 without auth", async () => {
    const res = await app.request("/api/v1/workspaces/00000000-0000-4000-8000-000000000001/themes");
    expect(res.status).toBe(401);
  });

  it("DELETE /api/v1/themes/:id returns 401 without auth", async () => {
    const res = await app.request("/api/v1/themes/00000000-0000-4000-8000-000000000001", {
      method: "DELETE",
    });
    expect(res.status).toBe(401);
  });
});
```

- [ ] **Step 4: Run route integration tests**

Run: `pnpm --filter @glyphquire/api test:integration -- --grep "Theme API"`
Expected: PASS

- [ ] **Step 5: Run typecheck and full test suite**

Run: `pnpm typecheck && pnpm test`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/routes/v1/themes.ts apps/api/src/routes/v1/themes.integration.test.ts apps/api/src/app.ts
git commit -m "feat: add theme API routes and wire into Hono app"
```

---

### Task 7: ThemeProvider Vue Composable

**Files:**

- Create: `apps/web/src/themes/ThemeProvider.ts`
- Create: `apps/web/src/themes/ThemeProvider.test.ts`
- Create: `apps/web/src/stores/theme.ts`

**Interfaces:**

- Consumes: `resolveTheme`, `tokensToCssVariables`, `resolveVariants`, `defaultTheme`, `defaultDarkTheme`, `defaultVariants`, `type ThemeTokens`, `type ThemeComponentVariants` from `@glyphquire/theme-engine`
- Produces:
  - `useTheme()` composable: `tokens` (reactive `ThemeTokens`), `variants` (reactive `ThemeComponentVariants`), `cssVariables` (computed `Record<string, string>`), `isDark` (ref), `setTheme(tokens, variants)`, `setDraftTokens(partial)`, `commitDraft()`, `resetDraft()`, `applyToDocument()`
  - `THEME_INJECTION_KEY` (InjectionKey)
  - `useThemeStore` Pinia store

- [ ] **Step 1: Write failing tests for ThemeProvider**

Create `apps/web/src/themes/ThemeProvider.test.ts`:

```ts
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { useTheme, THEME_INJECTION_KEY } from "./ThemeProvider.js";
import {
  defaultTheme,
  defaultDarkTheme,
  defaultVariants,
  tokensToCssVariables,
} from "@glyphquire/theme-engine";

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
});
```

- [ ] **Step 2: Implement ThemeProvider.ts**

Create `apps/web/src/themes/ThemeProvider.ts`:

```ts
import { computed, ref, type InjectionKey, type Ref, type ComputedRef } from "vue";
import {
  resolveTheme,
  tokensToCssVariables,
  resolveVariants,
  defaultTheme,
  defaultDarkTheme,
  defaultVariants,
  type ThemeTokens,
  type ThemeComponentVariants,
} from "@glyphquire/theme-engine";

export interface ThemeContext {
  readonly tokens: ComputedRef<ThemeTokens>;
  readonly variants: ComputedRef<ThemeComponentVariants>;
  readonly cssVariables: ComputedRef<Record<string, string>>;
  readonly isDark: Ref<boolean>;
  setTheme(tokens: Partial<ThemeTokens>, variants?: Partial<ThemeComponentVariants>): void;
  setDraftTokens(overrides: Partial<ThemeTokens>): void;
  setDraftVariants(overrides: Partial<ThemeComponentVariants>): void;
  commitDraft(): void;
  resetDraft(): void;
  applyToDocument(): void;
}

export const THEME_INJECTION_KEY: InjectionKey<ThemeContext> = Symbol("glyphquire-theme");

export function useTheme(): ThemeContext {
  const isDark = ref(false);
  const baseTokenOverrides = ref<Partial<ThemeTokens>>({});
  const baseVariantOverrides = ref<Partial<ThemeComponentVariants>>({});
  const draftTokenOverrides = ref<Partial<ThemeTokens> | null>(null);
  const draftVariantOverrides = ref<Partial<ThemeComponentVariants> | null>(null);

  const baseTheme = computed(() => (isDark.value ? defaultDarkTheme : defaultTheme));

  const tokens = computed(() => {
    const effective = draftTokenOverrides.value ?? baseTokenOverrides.value;
    return resolveTheme(baseTheme.value, effective);
  });

  const variants = computed(() => {
    const effective = draftVariantOverrides.value ?? baseVariantOverrides.value;
    return resolveVariants(defaultVariants, effective);
  });

  const cssVariables = computed(() => tokensToCssVariables(tokens.value));

  function setTheme(
    tokenOverrides: Partial<ThemeTokens>,
    variantOverrides?: Partial<ThemeComponentVariants>,
  ) {
    baseTokenOverrides.value = tokenOverrides;
    if (variantOverrides) baseVariantOverrides.value = variantOverrides;
    draftTokenOverrides.value = null;
    draftVariantOverrides.value = null;
  }

  function setDraftTokens(overrides: Partial<ThemeTokens>) {
    draftTokenOverrides.value = overrides;
  }

  function setDraftVariants(overrides: Partial<ThemeComponentVariants>) {
    draftVariantOverrides.value = overrides;
  }

  function commitDraft() {
    if (draftTokenOverrides.value) baseTokenOverrides.value = draftTokenOverrides.value;
    if (draftVariantOverrides.value) baseVariantOverrides.value = draftVariantOverrides.value;
    draftTokenOverrides.value = null;
    draftVariantOverrides.value = null;
  }

  function resetDraft() {
    draftTokenOverrides.value = null;
    draftVariantOverrides.value = null;
  }

  function applyToDocument() {
    const vars = cssVariables.value;
    const root = document.documentElement;
    for (const [key, value] of Object.entries(vars)) {
      root.style.setProperty(key, value);
    }
  }

  return {
    tokens,
    variants,
    cssVariables,
    isDark,
    setTheme,
    setDraftTokens,
    setDraftVariants,
    commitDraft,
    resetDraft,
    applyToDocument,
  };
}
```

- [ ] **Step 3: Create theme Pinia store**

Create `apps/web/src/stores/theme.ts`:

```ts
import { defineStore } from "pinia";
import { ref, shallowRef } from "vue";
import type { ThemeResult, UserThemeResult } from "@glyphquire/api-contract";

export const useThemeStore = defineStore("theme", () => {
  const availableThemes = ref<ThemeResult[]>([]);
  const activeUserTheme = shallowRef<UserThemeResult | null>(null);
  const loading = ref(false);
  const error = ref<string | null>(null);
  const editorOpen = ref(false);

  function setAvailableThemes(themes: ThemeResult[]) {
    availableThemes.value = themes;
  }

  function setActiveUserTheme(userTheme: UserThemeResult) {
    activeUserTheme.value = userTheme;
  }

  function openEditor() {
    editorOpen.value = true;
  }

  function closeEditor() {
    editorOpen.value = false;
  }

  return {
    availableThemes,
    activeUserTheme,
    loading,
    error,
    editorOpen,
    setAvailableThemes,
    setActiveUserTheme,
    openEditor,
    closeEditor,
  };
});
```

- [ ] **Step 4: Run tests**

Run: `pnpm --filter @glyphquire/web test -- --grep ThemeProvider`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/themes/ThemeProvider.ts apps/web/src/themes/ThemeProvider.test.ts apps/web/src/stores/theme.ts
git commit -m "feat: add ThemeProvider composable and theme Pinia store"
```

---

### Task 8: Component Theme CSS — All 12 Visual Components

**Files:**

- Create: `apps/web/src/themes/tokens.css`
- Create: `apps/web/src/themes/components/heading.css`
- Create: `apps/web/src/themes/components/paragraph.css`
- Create: `apps/web/src/themes/components/quote.css`
- Create: `apps/web/src/themes/components/code.css`
- Create: `apps/web/src/themes/components/callout.css`
- Create: `apps/web/src/themes/components/sticky-note.css`
- Create: `apps/web/src/themes/components/toggle.css`
- Create: `apps/web/src/themes/components/tabs.css`
- Create: `apps/web/src/themes/components/columns.css`
- Create: `apps/web/src/themes/components/divider.css`
- Create: `apps/web/src/themes/components/image.css`
- Create: `apps/web/src/themes/components/math.css`

**Interfaces:**

- Consumes: CSS variable naming from Task 1 (`--gq-color-*`, `--gq-typography-*`, `--gq-radius-*`, `--gq-spacing-*`)
- Produces: Complete CSS for all 12 themed visual components. Each CSS file self-contained; no cross-imports between component CSS files. Variant styles via `[data-variant]` / `[data-decoration]` attribute selectors.

- [ ] **Step 1: Create fallback token definitions**

Create `apps/web/src/themes/tokens.css`:

```css
:root {
  --gq-color-background: #ffffff;
  --gq-color-foreground: #1a1a1a;
  --gq-color-muted: #6b7280;
  --gq-color-accent: #2563eb;
  --gq-color-border: #e5e7eb;
  --gq-typography-body-font: "Inter", "Noto Sans TC", system-ui, sans-serif;
  --gq-typography-heading-font: "Inter", "Noto Sans TC", system-ui, sans-serif;
  --gq-typography-mono-font: "JetBrains Mono", "Fira Code", ui-monospace, monospace;
  --gq-radius-sm: 0.25rem;
  --gq-radius-md: 0.5rem;
  --gq-radius-lg: 0.75rem;
  --gq-spacing-xs: 0.25rem;
  --gq-spacing-sm: 0.5rem;
  --gq-spacing-md: 1rem;
  --gq-spacing-lg: 1.5rem;
  --gq-spacing-xl: 2rem;
  --gq-spacing-2xl: 3rem;
}
```

- [ ] **Step 2: Create heading.css**

Create `apps/web/src/themes/components/heading.css`:

```css
[data-glyphquire-node="heading"],
.ProseMirror h1,
.ProseMirror h2,
.ProseMirror h3,
.ProseMirror h4,
.ProseMirror h5,
.ProseMirror h6 {
  font-family: var(--gq-typography-heading-font);
  color: var(--gq-color-foreground);
  line-height: 1.3;
  margin-top: var(--gq-spacing-lg);
  margin-bottom: var(--gq-spacing-sm);
}

[data-decoration="line"] {
  border-bottom: 2px solid var(--gq-color-accent);
  padding-bottom: var(--gq-spacing-xs);
}

[data-decoration="sparkle"] {
  background: linear-gradient(135deg, var(--gq-color-accent), var(--gq-color-foreground));
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
  background-clip: text;
}
```

- [ ] **Step 3: Create paragraph.css**

Create `apps/web/src/themes/components/paragraph.css`:

```css
.ProseMirror p {
  font-family: var(--gq-typography-body-font);
  color: var(--gq-color-foreground);
  line-height: 1.7;
  margin-bottom: var(--gq-spacing-sm);
}
```

- [ ] **Step 4: Create quote.css**

Create `apps/web/src/themes/components/quote.css`:

```css
.ProseMirror blockquote,
[data-glyphquire-node="quote"] {
  font-family: var(--gq-typography-body-font);
  color: var(--gq-color-muted);
  border-left: 3px solid var(--gq-color-accent);
  padding: var(--gq-spacing-sm) var(--gq-spacing-md);
  margin: var(--gq-spacing-md) 0;
  border-radius: 0 var(--gq-radius-sm) var(--gq-radius-sm) 0;
}

[data-variant="sticky"] {
  background: oklch(90% 0.05 85);
  border-left: none;
  border-radius: var(--gq-radius-md);
  box-shadow: 2px 2px 6px oklch(0% 0 0 / 0.1);
  transform: rotate(-0.5deg);
  padding: var(--gq-spacing-md);
}

[data-variant="paper"] {
  background: var(--gq-color-background);
  border: 1px solid var(--gq-color-border);
  border-left: 3px solid var(--gq-color-accent);
  border-radius: var(--gq-radius-md);
  padding: var(--gq-spacing-md);
  box-shadow: 0 1px 3px oklch(0% 0 0 / 0.05);
}
```

- [ ] **Step 5: Create code.css**

Create `apps/web/src/themes/components/code.css`:

```css
.ProseMirror pre,
.ProseMirror code {
  font-family: var(--gq-typography-mono-font);
}

.ProseMirror pre {
  background: oklch(from var(--gq-color-foreground) l c h / 0.05);
  border: 1px solid var(--gq-color-border);
  border-radius: var(--gq-radius-md);
  padding: var(--gq-spacing-md);
  overflow-x: auto;
  margin: var(--gq-spacing-md) 0;
}

.ProseMirror code {
  background: oklch(from var(--gq-color-foreground) l c h / 0.05);
  border-radius: var(--gq-radius-sm);
  padding: 0.125rem 0.375rem;
  font-size: 0.875em;
}

[data-variant="terminal"] pre {
  background: #0d1117;
  color: #c9d1d9;
  border: 1px solid #30363d;
  border-radius: var(--gq-radius-lg);
  box-shadow: inset 0 1px 3px oklch(0% 0 0 / 0.2);
}
```

- [ ] **Step 6: Create callout.css**

Create `apps/web/src/themes/components/callout.css`:

```css
[data-glyphquire-node="callout"] {
  border-radius: var(--gq-radius-md);
  padding: var(--gq-spacing-md);
  margin: var(--gq-spacing-md) 0;
  font-family: var(--gq-typography-body-font);
}

[data-glyphquire-node="callout"][data-variant="solid"] {
  background: oklch(from var(--gq-color-accent) l c h / 0.1);
  border: 1px solid oklch(from var(--gq-color-accent) l c h / 0.3);
}

[data-glyphquire-node="callout"][data-variant="glass"] {
  background: oklch(from var(--gq-color-accent) l c h / 0.05);
  backdrop-filter: blur(8px);
  border: 1px solid oklch(from var(--gq-color-accent) l c h / 0.15);
}

[data-glyphquire-node="callout"][data-variant="outline"] {
  background: transparent;
  border: 2px solid var(--gq-color-accent);
}

@media (prefers-reduced-motion: no-preference) {
  [data-glyphquire-node="callout"][data-animation="glow"] {
    animation: gq-callout-glow 3s ease-in-out infinite alternate;
  }

  [data-glyphquire-node="callout"][data-animation="lift"]:hover {
    transform: translateY(-2px);
    box-shadow: 0 4px 12px oklch(0% 0 0 / 0.1);
    transition:
      transform 200ms ease,
      box-shadow 200ms ease;
  }
}

@keyframes gq-callout-glow {
  from {
    box-shadow: 0 0 4px oklch(from var(--gq-color-accent) l c h / 0.2);
  }
  to {
    box-shadow: 0 0 12px oklch(from var(--gq-color-accent) l c h / 0.4);
  }
}
```

- [ ] **Step 7: Create sticky-note.css**

Create `apps/web/src/themes/components/sticky-note.css`:

```css
[data-glyphquire-node="sticky"] {
  font-family: var(--gq-typography-body-font);
  padding: var(--gq-spacing-md);
  margin: var(--gq-spacing-md) 0;
  border-radius: var(--gq-radius-md);
}

[data-glyphquire-node="sticky"][data-variant="plain"] {
  background: oklch(92% 0.06 90);
  border: 1px solid oklch(85% 0.06 90);
}

[data-glyphquire-node="sticky"][data-variant="paper"] {
  background: oklch(95% 0.04 85);
  border: none;
  box-shadow: 2px 3px 8px oklch(0% 0 0 / 0.12);
  transform: rotate(-1deg);
}

[data-glyphquire-node="sticky"][data-variant="neon"] {
  background: oklch(15% 0 0);
  color: oklch(85% 0.2 160);
  border: 1px solid oklch(60% 0.2 160);
  box-shadow: 0 0 8px oklch(60% 0.2 160 / 0.3);
}
```

- [ ] **Step 8: Create toggle.css**

Create `apps/web/src/themes/components/toggle.css`:

```css
[data-glyphquire-node="toggle"] {
  font-family: var(--gq-typography-body-font);
  margin: var(--gq-spacing-sm) 0;
}

[data-glyphquire-node="toggle"][data-variant="plain"] {
  border-bottom: 1px solid var(--gq-color-border);
  padding: var(--gq-spacing-sm) 0;
}

[data-glyphquire-node="toggle"][data-variant="card"] {
  background: var(--gq-color-background);
  border: 1px solid var(--gq-color-border);
  border-radius: var(--gq-radius-md);
  padding: var(--gq-spacing-sm) var(--gq-spacing-md);
  box-shadow: 0 1px 2px oklch(0% 0 0 / 0.05);
}
```

- [ ] **Step 9: Create tabs.css**

Create `apps/web/src/themes/components/tabs.css`:

```css
[data-glyphquire-node="tabs"] {
  font-family: var(--gq-typography-body-font);
  margin: var(--gq-spacing-md) 0;
}

[data-glyphquire-node="tabs"][data-variant="plain"] [data-tab-trigger] {
  border-bottom: 2px solid transparent;
  padding: var(--gq-spacing-xs) var(--gq-spacing-sm);
  color: var(--gq-color-muted);
}

[data-glyphquire-node="tabs"][data-variant="plain"] [data-tab-trigger][aria-selected="true"] {
  border-bottom-color: var(--gq-color-accent);
  color: var(--gq-color-foreground);
}

[data-glyphquire-node="tabs"][data-variant="pill"] [data-tab-trigger] {
  border-radius: var(--gq-radius-lg);
  padding: var(--gq-spacing-xs) var(--gq-spacing-md);
  color: var(--gq-color-muted);
}

[data-glyphquire-node="tabs"][data-variant="pill"] [data-tab-trigger][aria-selected="true"] {
  background: var(--gq-color-accent);
  color: var(--gq-color-background);
}

[data-glyphquire-node="tabs"][data-variant="underline"] [data-tab-trigger] {
  border-bottom: 1px solid var(--gq-color-border);
  padding: var(--gq-spacing-xs) var(--gq-spacing-sm);
}

[data-glyphquire-node="tabs"][data-variant="underline"] [data-tab-trigger][aria-selected="true"] {
  border-bottom: 2px solid var(--gq-color-foreground);
  font-weight: 600;
}
```

- [ ] **Step 10: Create columns.css**

Create `apps/web/src/themes/components/columns.css`:

```css
[data-glyphquire-node="columns"] {
  display: flex;
  gap: var(--gq-spacing-md);
  margin: var(--gq-spacing-md) 0;
}

[data-glyphquire-node="columns"] > [data-glyphquire-node="column"] {
  flex: 1;
  min-width: 0;
}
```

- [ ] **Step 11: Create divider.css**

Create `apps/web/src/themes/components/divider.css`:

```css
.ProseMirror hr {
  border: none;
  border-top: 1px solid var(--gq-color-border);
  margin: var(--gq-spacing-lg) 0;
}
```

- [ ] **Step 12: Create image.css**

Create `apps/web/src/themes/components/image.css`:

```css
.ProseMirror img {
  max-width: 100%;
  height: auto;
  border-radius: var(--gq-radius-md);
  margin: var(--gq-spacing-md) 0;
}
```

- [ ] **Step 13: Create math.css**

Create `apps/web/src/themes/components/math.css`:

```css
.ProseMirror .katex-display,
.ProseMirror .katex {
  color: var(--gq-color-foreground);
  font-size: 1em;
}

.ProseMirror .katex-display {
  margin: var(--gq-spacing-md) 0;
  padding: var(--gq-spacing-sm);
  overflow-x: auto;
}
```

- [ ] **Step 14: Commit**

```bash
git add apps/web/src/themes/
git commit -m "feat: add theme-aware CSS for all 12 visual components with variant support"
```

---

### Task 9: Extend Milkdown Node Views with Variant Attributes

**Files:**

- Modify: `apps/web/src/editors/visual/nodes/callout.ts`
- Modify: `apps/web/src/editors/visual/nodes/sticky.ts`
- Modify: `apps/web/src/editors/visual/nodes/toggle.ts`
- Modify: `apps/web/src/editors/visual/nodes/tabs.ts`
- Modify: `apps/web/src/editors/visual/nodes/columns.ts`
- Modify: `apps/web/src/editors/visual/schema.ts`

**Interfaces:**

- Consumes: `THEME_INJECTION_KEY`, `ThemeContext` from Task 7; existing Milkdown node schemas from Phase 2
- Produces: Each node schema's `toDOM` adds `data-variant` or `data-decoration` or `data-animation` attributes read from the current ThemeComponentVariants via a shared helper

- [ ] **Step 1: Add variant attribute helper to schema.ts**

In `apps/web/src/editors/visual/schema.ts`, add a new exported function:

```ts
export function themeVariantAttrs(
  componentKey: string,
  variants: Record<string, Record<string, string>>,
): Record<string, string> {
  const componentVariants = variants[componentKey];
  if (!componentVariants) return {};
  const attrs: Record<string, string> = {};
  for (const [key, value] of Object.entries(componentVariants)) {
    if (key === "variant") {
      attrs["data-variant"] = value;
    } else if (key === "decoration") {
      attrs["data-decoration"] = value;
    } else if (key === "animation") {
      attrs["data-animation"] = value;
    }
  }
  return attrs;
}
```

- [ ] **Step 2: Extend callout.ts toDOM to include data-variant and data-animation**

In `apps/web/src/editors/visual/nodes/callout.ts`, update the `toDOM` in `visualCalloutSchema`:

```ts
toDOM: () => ["section", { "data-glyphquire-node": "callout" }, 0],
```

Change to:

```ts
toDOM: (node) => [
  "section",
  {
    "data-glyphquire-node": "callout",
    "data-variant": "solid",
    "data-animation": "none",
  },
  0,
],
```

The ThemeProvider will dynamically update these attributes via a Milkdown plugin decorations in a later step.

- [ ] **Step 3: Extend sticky.ts, toggle.ts, tabs.ts similarly**

For each file, add default `"data-variant": "plain"` to the `toDOM` output.

`apps/web/src/editors/visual/nodes/sticky.ts` toDOM:

```ts
toDOM: () => ["section", { "data-glyphquire-node": "sticky", "data-variant": "plain" }, 0],
```

`apps/web/src/editors/visual/nodes/toggle.ts` toDOM:

```ts
toDOM: () => ["details", { "data-glyphquire-node": "toggle", "data-variant": "plain" }, 0],
```

`apps/web/src/editors/visual/nodes/tabs.ts` toDOM:

```ts
toDOM: () => ["section", { "data-glyphquire-node": "tabs", "data-variant": "plain" }, 0],
```

- [ ] **Step 4: Run existing tests to ensure no regressions**

Run: `pnpm test`
Expected: ALL PASS (node view changes are additive — new attributes only)

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/editors/visual/
git commit -m "feat: extend Milkdown node views with data-variant and data-animation attributes"
```

---

### Task 10: Theme Editor UI Components

**Files:**

- Create: `apps/web/src/components/theme-editor/ThemeEditorPanel.vue`
- Create: `apps/web/src/components/theme-editor/ThemeSelector.vue`
- Create: `apps/web/src/components/theme-editor/TokenEditor.vue`
- Create: `apps/web/src/components/theme-editor/ColorTokenGroup.vue`
- Create: `apps/web/src/components/theme-editor/TypographyTokenGroup.vue`
- Create: `apps/web/src/components/theme-editor/RadiusTokenGroup.vue`
- Create: `apps/web/src/components/theme-editor/SpacingTokenGroup.vue`
- Create: `apps/web/src/components/theme-editor/VariantPicker.vue`
- Create: `apps/web/src/components/theme-editor/ComponentVariantRow.vue`
- Create: `apps/web/src/components/theme-editor/ThemeActions.vue`
- Create: `apps/web/src/themes/useThemeEditor.ts`
- Modify: `apps/web/src/components/workbench/TopBar.vue`
- Modify: `apps/web/src/components/workbench/Workbench.vue`

**Interfaces:**

- Consumes: `useTheme()` from Task 7; `useThemeStore` from Task 7; `ThemeResult`, `UserThemeResult` from Task 4
- Produces: Complete theme editor slide-over panel with live preview

- [ ] **Step 1: Create useThemeEditor composable**

Create `apps/web/src/themes/useThemeEditor.ts`:

```ts
import { ref, computed, watch } from "vue";
import type { ThemeTokens, ThemeComponentVariants } from "@glyphquire/theme-engine";
import type { ThemeContext } from "./ThemeProvider.js";

export function useThemeEditor(themeContext: ThemeContext) {
  const draftColor = ref({ ...themeContext.tokens.value.color });
  const draftTypography = ref({ ...themeContext.tokens.value.typography });
  const draftRadius = ref({ ...themeContext.tokens.value.radius });
  const draftSpacing = ref({ ...themeContext.tokens.value.spacing });
  const hasUnsavedChanges = ref(false);

  function updateColor(key: keyof ThemeTokens["color"], value: string) {
    draftColor.value = { ...draftColor.value, [key]: value };
    hasUnsavedChanges.value = true;
    themeContext.setDraftTokens({
      color: draftColor.value,
      typography: draftTypography.value,
      radius: draftRadius.value,
      spacing: draftSpacing.value,
    });
  }

  function updateTypography(key: keyof ThemeTokens["typography"], value: string) {
    draftTypography.value = { ...draftTypography.value, [key]: value };
    hasUnsavedChanges.value = true;
    themeContext.setDraftTokens({
      color: draftColor.value,
      typography: draftTypography.value,
      radius: draftRadius.value,
      spacing: draftSpacing.value,
    });
  }

  function updateRadius(key: keyof ThemeTokens["radius"], value: string) {
    draftRadius.value = { ...draftRadius.value, [key]: value };
    hasUnsavedChanges.value = true;
    themeContext.setDraftTokens({
      color: draftColor.value,
      typography: draftTypography.value,
      radius: draftRadius.value,
      spacing: draftSpacing.value,
    });
  }

  function updateSpacing(key: string, value: string) {
    draftSpacing.value = { ...draftSpacing.value, [key]: value };
    hasUnsavedChanges.value = true;
    themeContext.setDraftTokens({
      color: draftColor.value,
      typography: draftTypography.value,
      radius: draftRadius.value,
      spacing: draftSpacing.value,
    });
  }

  function reset() {
    draftColor.value = { ...themeContext.tokens.value.color };
    draftTypography.value = { ...themeContext.tokens.value.typography };
    draftRadius.value = { ...themeContext.tokens.value.radius };
    draftSpacing.value = { ...themeContext.tokens.value.spacing };
    hasUnsavedChanges.value = false;
    themeContext.resetDraft();
  }

  function loadFromTokens(tokens: ThemeTokens) {
    draftColor.value = { ...tokens.color };
    draftTypography.value = { ...tokens.typography };
    draftRadius.value = { ...tokens.radius };
    draftSpacing.value = { ...tokens.spacing };
    hasUnsavedChanges.value = false;
  }

  return {
    draftColor,
    draftTypography,
    draftRadius,
    draftSpacing,
    hasUnsavedChanges,
    updateColor,
    updateTypography,
    updateRadius,
    updateSpacing,
    reset,
    loadFromTokens,
  };
}
```

- [ ] **Step 2: Create all Vue components**

Create the theme editor Vue components. Each is a self-contained SFC. Due to plan length, provide the component structure and key implementation details:

**`ThemeEditorPanel.vue`**: Slide-over panel with `role="dialog"`, `aria-modal="true"`, focus trap via existing `focusTrap.ts`. Contains ThemeSelector, TokenEditor, VariantPicker, ThemeActions. Imports `useThemeEditor` and passes state down.

**`ThemeSelector.vue`**: `<select>` dropdown with `v-model` for theme selection. Lists system themes and workspace themes from `useThemeStore`.

**`TokenEditor.vue`**: Renders ColorTokenGroup, TypographyTokenGroup, RadiusTokenGroup, SpacingTokenGroup in collapsible sections.

**`ColorTokenGroup.vue`**: Five rows, each with `<label>`, `<input type="color">`, and `<input type="text">` for hex. Emits `update:color` events.

**`TypographyTokenGroup.vue`**: Three rows with `<select>` for font-family presets and text preview. Emits `update:typography`.

**`RadiusTokenGroup.vue`**: Three `<input type="range">` sliders with `aria-valuemin="0"`, `aria-valuemax="2rem"`, `aria-valuenow`. Emits `update:radius`.

**`SpacingTokenGroup.vue`**: Six range sliders for xs through 2xl. Emits `update:spacing`.

**`VariantPicker.vue`**: Renders ComponentVariantRow for each component with variants.

**`ComponentVariantRow.vue`**: `<label>` + `<select>` with enum values per component.

**`ThemeActions.vue`**: Save, Reset, Dark Mode toggle buttons.

- [ ] **Step 3: Add theme button to TopBar.vue**

In `apps/web/src/components/workbench/TopBar.vue`, add a theme button in the toolbar between the mode toggles and the Commands button:

```html
<button
  type="button"
  class="rounded-md border border-gray-300 px-3 py-1 text-xs font-medium text-gray-700 hover:bg-gray-50"
  aria-label="Open theme editor"
  @click="emit('open-theme-editor')"
>
  Theme
</button>
```

Add `"open-theme-editor": []` to the `defineEmits`.

- [ ] **Step 4: Mount ThemeEditorPanel in Workbench.vue**

In `apps/web/src/components/workbench/Workbench.vue`, import and mount `ThemeEditorPanel`:

```html
<ThemeEditorPanel v-if="themeStore.editorOpen" @close="themeStore.closeEditor()" />
```

Wire TopBar's `open-theme-editor` event to `themeStore.openEditor()`.

- [ ] **Step 5: Run typecheck and tests**

Run: `pnpm typecheck && pnpm test`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/components/theme-editor/ apps/web/src/themes/useThemeEditor.ts apps/web/src/components/workbench/TopBar.vue apps/web/src/components/workbench/Workbench.vue
git commit -m "feat: add theme editor UI panel with live preview, variant picker, and token editing"
```

---

### Task 11: KaTeX Math Rendering Integration

**Files:**

- Modify: `apps/web/package.json` (add `katex` dependency)
- Create: `apps/web/src/editors/visual/nodes/math.ts`
- Modify: `apps/web/src/editors/visual/schema.ts` (register math plugin)

**Interfaces:**

- Consumes: Milkdown plugin system, KaTeX library, math CSS from Task 8
- Produces: `visualMathSchema` and `visualMathView` Milkdown plugins for inline `$...$` and display `$$...$$` math rendering

- [ ] **Step 1: Add katex dependency**

Run: `pnpm --filter @glyphquire/web add katex`

- [ ] **Step 2: Create math node view**

Create `apps/web/src/editors/visual/nodes/math.ts`:

```ts
import type { MilkdownPlugin } from "@milkdown/kit/ctx";
import { $nodeSchema, $view } from "@milkdown/kit/utils";
import katex from "katex";

export const visualMathBlockSchema = $nodeSchema("gq_math_block", () => ({
  group: "block",
  content: "text*",
  marks: "",
  defining: true,
  isolating: true,
  atom: false,
  code: true,
  attrs: {
    value: { default: "" },
  },
  parseDOM: [
    {
      tag: "div[data-glyphquire-node='math-block']",
      getAttrs: (dom) => ({
        value: (dom as HTMLElement).getAttribute("data-value") ?? "",
      }),
    },
  ],
  toDOM: (node) => [
    "div",
    {
      "data-glyphquire-node": "math-block",
      "data-value": node.attrs.value as string,
    },
    0,
  ],
}));

export const visualMathBlockView = $view(visualMathBlockSchema.node, () => (node, view, getPos) => {
  const container = document.createElement("div");
  container.classList.add("gq-math-block");
  container.setAttribute("data-glyphquire-node", "math-block");

  const latex = node.textContent || (node.attrs.value as string) || "";

  try {
    katex.render(latex, container, {
      displayMode: true,
      throwOnError: false,
      output: "mathml",
    });
  } catch {
    container.textContent = latex;
  }

  return {
    dom: container,
    update(updatedNode) {
      if (updatedNode.type.name !== "gq_math_block") return false;
      const updatedLatex = updatedNode.textContent || (updatedNode.attrs.value as string) || "";
      try {
        katex.render(updatedLatex, container, {
          displayMode: true,
          throwOnError: false,
          output: "mathml",
        });
      } catch {
        container.textContent = updatedLatex;
      }
      return true;
    },
  };
});

export const mathPlugins: MilkdownPlugin[] = [visualMathBlockSchema, visualMathBlockView];
```

- [ ] **Step 3: Run typecheck**

Run: `pnpm --filter @glyphquire/web typecheck`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/editors/visual/nodes/math.ts apps/web/package.json pnpm-lock.yaml
git commit -m "feat: add KaTeX math block rendering in visual editor"
```

---

### Task 12: E2E Tests — Theme Switching and Visual Verification

**Files:**

- Create: `tests/e2e/theme.spec.ts`

**Interfaces:**

- Consumes: running dev server with theme routes, theme editor UI, visual editor
- Produces: Playwright E2E tests for theme workflow

- [ ] **Step 1: Create theme E2E tests**

Create `tests/e2e/theme.spec.ts`:

```ts
import { test, expect } from "@playwright/test";

test.describe("Theme System", () => {
  test("theme editor panel opens and closes from TopBar", async ({ page }) => {
    await page.goto("/");
    // Login flow assumed handled by fixture
    const themeButton = page.getByRole("button", { name: "Open theme editor" });
    await expect(themeButton).toBeVisible();
    await themeButton.click();

    const panel = page.getByRole("dialog", { name: /theme/i });
    await expect(panel).toBeVisible();

    await page.keyboard.press("Escape");
    await expect(panel).not.toBeVisible();
  });

  test("theme selector lists system themes", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: "Open theme editor" }).click();

    const selector = page.getByRole("combobox", { name: /theme/i });
    await expect(selector).toBeVisible();

    const options = await selector.locator("option").allTextContents();
    expect(options).toContain("Default Light");
    expect(options).toContain("Default Dark");
    expect(options).toContain("Warm Sepia");
  });

  test("color token change applies live to document", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: "Open theme editor" }).click();

    const bgInput = page.locator('input[aria-label="Background color"]');
    await bgInput.fill("#ff0000");
    await bgInput.press("Enter");

    const bgVar = await page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue("--gq-color-background").trim(),
    );
    expect(bgVar).toBe("#ff0000");
  });

  test("prefers-reduced-motion suppresses callout animation", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto("/");
    // Verify no animation-name is applied to callout elements
    const animation = await page.evaluate(() => {
      const el = document.querySelector("[data-glyphquire-node='callout']");
      return el ? getComputedStyle(el).animationName : "none";
    });
    expect(animation).toBe("none");
  });
});
```

- [ ] **Step 2: Run E2E tests**

Run: `pnpm test:e2e -- --grep "Theme System"`
Expected: PASS (requires dev server running)

- [ ] **Step 3: Commit**

```bash
git add tests/e2e/theme.spec.ts
git commit -m "test: add E2E tests for theme editor, live preview, and reduced-motion"
```

---

### Task 13: Quality Gate — Typecheck, Lint, Build, All Tests

**Files:**

- No new files. Verify entire project passes all quality gates.

**Interfaces:**

- Consumes: everything from Tasks 1–12
- Produces: clean typecheck, lint, build, and test run across all packages

- [ ] **Step 1: Run full quality gate suite**

```bash
pnpm typecheck
pnpm lint
pnpm build
pnpm test
pnpm test:cross-package
pnpm test:integration
```

Expected: ALL PASS

- [ ] **Step 2: Fix any issues found**

Address any typecheck errors, lint warnings, or test failures. Each fix should be minimal and targeted.

- [ ] **Step 3: Commit fixes if any**

```bash
git add -A
git commit -m "fix: resolve quality gate issues for phase 3"
```

---

### Task 14: Final Security Review and Spec Verification

**Files:**

- No new files. Read-only verification pass.

**Interfaces:**

- Consumes: all Phase 3 code from Tasks 1–13
- Produces: verified security posture and spec compliance report

- [ ] **Step 1: Verify security constraints**

Check each security constraint from the spec:

1. Theme manifest tokens/components validated by Zod at API boundary
2. System themes immutable (`is_system = true`, mutation rejected)
3. Workspace themes tenant-isolated
4. No `v-html`, `innerHTML`, `eval`, or `Function` for theme content
5. KaTeX options: `throwOnError: false`, no `trust`, no HTML output
6. Font values validated (no `url()`, `expression()`)
7. Color values validated (no `url()`, `var()`, CSS expressions)
8. Theme editor writes only design tokens and predefined variant enums

- [ ] **Step 2: Verify spec coverage**

Map each spec section to its implementing task:

| Spec Section                           | Task                             |
| -------------------------------------- | -------------------------------- |
| §1 Design Tokens and Theme Resolution  | Task 1                           |
| §2 Built-in Component Visual Rendering | Tasks 8, 9, 11                   |
| §3 Theme Persistence and API           | Tasks 3, 4, 5, 6                 |
| §4 Theme Editor UI                     | Task 10                          |
| §5 Plugin Manifest Foundation          | Task 2                           |
| §6 Package Layout                      | Tasks 1, 2, 3, 4, 5, 6, 7, 8, 10 |
| §7 Security Constraints                | Task 14 (this task)              |
| §8 Testing Strategy                    | Tasks 1–12                       |

- [ ] **Step 3: Run E2E and accessibility tests**

```bash
pnpm test:e2e
```

- [ ] **Step 4: Commit verification ledger entry**

Update the SDD progress ledger with Phase 3 completion status.
