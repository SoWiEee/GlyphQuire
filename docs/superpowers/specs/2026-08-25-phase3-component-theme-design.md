# Phase 3 — Component + Theme Design

## Goal

Deliver theme-aware visual rendering for all 14 built-in blocks, a design-token-driven theme engine, a GUI theme editor, workspace-scoped theme persistence with API, and the declarative plugin manifest foundation.

## Architecture

`packages/theme-engine` owns pure token resolution and CSS variable generation with zero DOM dependency. `packages/theme-sdk` owns Zod schemas shared between API validation and frontend. `apps/web` owns Vue-specific rendering: ThemeProvider composable, Milkdown node view extensions, theme editor UI. `apps/api` owns theme CRUD behind the same tenant-isolation pattern as notes.

## Tech Stack

Node.js 22+, pnpm, TypeScript strict, Vue 3, Pinia, Hono, Zod, Drizzle ORM, PostgreSQL, Milkdown, ProseMirror, KaTeX (new), Vitest, Playwright.

## Spec References

- `SPEC.md` §11 Component System, §12 Plugin Manifest, §13 Theme Engine
- `MARKDOWN_SPEC.md` §30 Custom Block Constraints, §31 Renderer Presets, §32 Theme Independence, §33 Theme-level User Customization
- `SPEC.md` §41 Accessibility (component a11y, `prefers-reduced-motion`)
- `SPEC.md` §42 Internationalization (no hardcoded UI text in component logic)
- ADR-007: Built-ins + declarative custom blocks
- ADR-008: Design Tokens + approved variants

## Scope

### In scope

- Design token types, default light/dark themes, token resolution, CSS variable generation
- Component variant types and resolution
- Theme-aware visual rendering for all 14 built-in components (Milkdown node views + GFM element styling)
- ThemeProvider Vue composable with live token injection and dark mode support
- Theme editor panel (token GUI + variant picker, no JSON editor)
- Theme persistence: `themes` and `user_themes` tables, migration, system theme seed
- Theme API: CRUD for workspace themes, active theme get/set with custom overrides
- Plugin manifest Zod schema (full structure; only `themes` field exercised in Phase 3)
- KaTeX integration for math block rendering
- `prefers-reduced-motion` respect for animation variants
- WCAG 2.2 AA for theme editor UI

### Out of scope

- Custom block creation UI/API (future phase)
- Third-party plugin installation
- Plugin manifest `blocks`/`runtimes`/`permissions` processing (schema defined, not exercised)
- Theme sharing / public themes gallery (Phase 5+)
- Unrestricted CSS / CSS sandbox
- Interactive runtime sandbox activation for p5/canvas (Phase 4)
- Theme export/import file format
- JSON editor advanced mode in theme editor

---

## 1. Design Tokens and Theme Resolution

### 1.1 Token Structure

```ts
interface ThemeTokens {
  color: {
    background: string;
    foreground: string;
    muted: string;
    accent: string;
    border: string;
  };
  typography: {
    bodyFont: string;
    headingFont: string;
    monoFont: string;
  };
  radius: {
    sm: string;
    md: string;
    lg: string;
  };
  spacing: Record<string, string>; // xs, sm, md, lg, xl, 2xl
}
```

All color values use oklch or hex. Font values are CSS font-family stacks. Radius and spacing values are CSS length strings.

### 1.2 Resolution

`resolveTheme(base: ThemeTokens, overrides: Partial<ThemeTokens>): ThemeTokens` performs deep merge. Missing override keys fall back to base. Invalid values are rejected by Zod validation before reaching the resolver.

Two built-in base themes: `defaultTheme` (light) and `defaultDarkTheme`. A third system theme "Warm Sepia" demonstrates non-trivial token customization.

### 1.3 CSS Variable Generation

`tokensToCssVariables(tokens: ThemeTokens): Record<string, string>` flattens the nested token object into a CSS variable map:

```
color.background → --gq-color-background
typography.bodyFont → --gq-typography-body-font
radius.sm → --gq-radius-sm
spacing.md → --gq-spacing-md
```

The ThemeProvider composable applies these to `:root` as inline style properties.

### 1.4 Component Variants

```ts
interface ThemeComponentVariants {
  heading?: { decoration?: "none" | "sparkle" | "line" };
  quote?: { variant?: "plain" | "sticky" | "paper" };
  callout?: { variant?: "solid" | "glass" | "outline"; animation?: "none" | "glow" | "lift" };
  code?: { variant?: "plain" | "terminal" };
  toggle?: { variant?: "plain" | "card" };
  tabs?: { variant?: "plain" | "pill" | "underline" };
  stickyNote?: { variant?: "plain" | "paper" | "neon" };
}
```

Variants are not CSS variables. They determine which rendering template or CSS class combination a component uses. The ThemeProvider resolves variants and makes them available via Vue `provide/inject`.

### 1.5 Theme Manifest

```ts
interface ThemeManifest {
  id: string;
  name: string;
  version: string;
  tokens?: Partial<ThemeTokens>;
  darkTokens?: Partial<ThemeTokens>;
  components?: Partial<ThemeComponentVariants>;
}
```

`darkTokens` are overrides applied on top of `tokens` when the user is in dark mode. If `darkTokens` is absent, the system dark base theme provides the dark foundation and `tokens` overrides are applied on top of it.

---

## 2. Built-in Component Visual Rendering

### 2.1 GFM Native Elements

These are ProseMirror native node types, not directive-based. Theme integration via Milkdown plugins that add `data-*` attributes for variant selection:

| Component | Theme Integration | Variant Support |
|-----------|------------------|-----------------|
| heading | `data-decoration` attribute | sparkle, line, none |
| paragraph | typography tokens only | none |
| quote | `data-variant` attribute | plain, sticky, paper |
| code | `data-variant` attribute | plain, terminal |
| image | responsive + lazy loading | none |
| divider | token-driven color/spacing | none |
| math | KaTeX rendering, token-driven font/color | none |

### 2.2 Extended Blocks

Existing Milkdown node views from Phase 2 are extended to read injected `ThemeComponentVariants`:

| Component | Variant Support | Animation |
|-----------|-----------------|-----------|
| callout | solid, glass, outline | glow, lift (motion-safe) |
| sticky-note | plain, paper, neon | none |
| toggle | plain, card | none |
| tabs | plain, pill, underline | none |
| columns | token-driven spacing | none |
| p5 | inert placeholder (Phase 4) | none |
| canvas | inert placeholder (Phase 4) | none |

### 2.3 CSS Architecture

Each component has a dedicated CSS file in `apps/web/src/themes/components/`. All styles use `var(--gq-*)` tokens exclusively. Variant styles use `[data-variant]` or `[data-decoration]` attribute selectors. No component CSS imports another component's CSS.

Animation variants use CSS `@keyframes` guarded by:
```css
@media (prefers-reduced-motion: no-preference) { ... }
```

### 2.4 KaTeX Integration

Add `katex` as a dependency. Math blocks (`$...$` inline, `$$...$$` display) render via KaTeX in the Milkdown visual mode. KaTeX CSS uses theme tokens for font color and background. Source mode shows raw LaTeX.

---

## 3. Theme Persistence and API

### 3.1 Database Schema

**`themes` table:**

| Column | Type | Constraints |
|--------|------|-------------|
| id | uuid | PK, default gen_random_uuid() |
| workspace_id | uuid | FK workspaces, nullable (null = system theme) |
| name | varchar(200) | NOT NULL |
| version | varchar(50) | NOT NULL |
| tokens | jsonb | NOT NULL, default '{}' |
| dark_tokens | jsonb | nullable |
| components | jsonb | nullable |
| is_system | boolean | NOT NULL, default false |
| revision | integer | NOT NULL, default 1 |
| created_at | timestamptz | NOT NULL, default now() |
| updated_at | timestamptz | NOT NULL, default now() |

Constraints: system themes have `workspace_id IS NULL AND is_system = true`. Workspace themes have `workspace_id IS NOT NULL AND is_system = false`. Unique on `(workspace_id, name)` where `workspace_id IS NOT NULL`.

**`user_themes` table:**

| Column | Type | Constraints |
|--------|------|-------------|
| id | uuid | PK, default gen_random_uuid() |
| user_id | uuid | FK users, NOT NULL |
| workspace_id | uuid | FK workspaces, NOT NULL |
| theme_id | uuid | FK themes, NOT NULL |
| custom_overrides | jsonb | nullable |
| created_at | timestamptz | NOT NULL, default now() |
| updated_at | timestamptz | NOT NULL, default now() |

Unique on `(user_id, workspace_id)`.

**System theme seed:** migration inserts three system themes: "Default Light", "Default Dark", "Warm Sepia".

### 3.2 API Endpoints

All workspace-scoped endpoints require authenticated membership (same pattern as notes).

```
GET    /api/v1/workspaces/:workspaceId/themes
POST   /api/v1/workspaces/:workspaceId/themes      (requires operationId)
GET    /api/v1/themes/:themeId
PUT    /api/v1/themes/:themeId                       (CAS with baseRevision)
DELETE /api/v1/themes/:themeId                       (system themes rejected)

GET    /api/v1/user-theme                            (returns active theme + resolved tokens)
PUT    /api/v1/user-theme                            (set active theme + optional overrides)
```

Theme list returns system themes (visible to all workspaces) plus workspace-scoped themes. Theme CRUD for workspace themes requires owner/editor role. Viewer can read and set their active theme but not create/modify workspace themes.

### 3.3 ThemeService

`ThemeService` follows the same pattern as `NoteService`: constructor takes `Database`, all queries include workspace membership scope, mutations use revision-based CAS. System themes are loaded once and cached in memory.

### 3.4 Validation

Request bodies validated with Zod schemas from `packages/theme-sdk`. Token values validated for format (color strings, font stacks, CSS lengths). Component variant values validated against closed enums. Invalid manifests rejected with `DOCUMENT_INVALID` 400.

### 3.5 Rate Limiting

Theme mutations share the existing note mutation rate limit bucket (`note:mutation:user:*`, 30/min). Theme reads are not rate-limited beyond the global requireLimiter readiness check.

---

## 4. Theme Editor UI

### 4.1 Panel Structure

Slide-over panel opened from TopBar theme button. Contains:

- **ThemeSelector**: dropdown to choose base theme (system + workspace themes, or "Custom")
- **TokenEditor**: grouped token editing
  - ColorTokenGroup: 5 color pickers with hex input
  - TypographyTokenGroup: 3 font-family selectors with preview text
  - RadiusTokenGroup: 3 range sliders
  - SpacingTokenGroup: 6 range sliders
- **VariantPicker**: one row per component with variant dropdown/radio
- **ThemeActions**: Save, Reset, dark mode toggle

### 4.2 Interaction Flow

1. User selects a base theme from ThemeSelector
2. Token/variant changes apply immediately to `:root` CSS variables (live preview)
3. "Save" persists custom_overrides via `PUT /api/v1/user-theme`
4. "Reset" clears overrides, reverts to base theme defaults
5. Dark mode toggle switches between editing `tokens` vs `darkTokens`
6. Panel close with unsaved changes prompts confirmation

### 4.3 Live Preview

ThemeProvider composable maintains a reactive `draftTokens` state. ThemeEditorPanel writes to draft on every change. `tokensToCssVariables` recomputes. CSS variables update on `:root`. All themed components reflect changes immediately. Save persists to server; failure rolls back draft to last saved state.

### 4.4 Accessibility

- Panel: `role="dialog"`, `aria-label`, `aria-modal`, focus trap
- Color pickers: manual hex input field alongside visual picker
- Sliders: `aria-valuemin`, `aria-valuemax`, `aria-valuenow`, keyboard arrows
- `prefers-reduced-motion`: animation variant previews show static label instead of animation
- All interactive elements keyboard-navigable with visible focus

---

## 5. Plugin Manifest Foundation

### 5.1 Schema

`packages/theme-sdk` defines the full `PluginManifest` Zod schema per spec §12:

```ts
interface PluginManifest {
  id: string;
  name: string;
  version: string;
  apiVersion: string;
  blocks?: BlockManifest[];
  themes?: ThemeManifest[];
  runtimes?: RuntimeManifest[];
  permissions?: PluginPermission[];
}
```

Phase 3 exercises only the `themes` field. `blocks`, `runtimes`, and `permissions` are schema-defined and validated but not processed by any runtime code. Their types are exported for future phases.

### 5.2 Theme Upload via Manifest

`POST /api/v1/workspaces/:workspaceId/themes` accepts a `ThemeManifest` body (the `themes[0]` entry from a plugin manifest, or a standalone theme manifest). The API validates the manifest, extracts tokens/darkTokens/components, and persists to the `themes` table.

---

## 6. Package Layout

### New packages

```
packages/theme-engine/
  src/
    tokens.ts             default themes, ThemeTokens type
    resolve.ts            resolveTheme, mergeTokens
    css-variables.ts      tokensToCssVariables
    variants.ts           ThemeComponentVariants, defaultVariants, resolveVariants
    index.ts
  tests/

packages/theme-sdk/
  src/
    schemas.ts            Zod schemas for tokens, variants, manifest, plugin manifest
    types.ts              inferred TypeScript types
    validation.ts         validateManifest
    index.ts
  tests/
```

### Modified packages

```
packages/database/
  src/migrations/0004_phase3_themes.sql
  src/schema/themes.ts
  src/schema/user-themes.ts

packages/api-contract/
  src/themes/schemas.ts       API request/response schemas
  src/themes/types.ts

apps/api/
  src/modules/themes/ThemeService.ts
  src/modules/themes/ThemeService.integration.test.ts
  src/routes/v1/themes.ts
  src/routes/v1/themes.integration.test.ts

apps/web/
  src/themes/ThemeProvider.ts
  src/themes/useThemeEditor.ts
  src/themes/tokens.css
  src/themes/components/*.css
  src/components/theme-editor/*.vue
  src/editors/visual/nodes/* (extend existing)
  src/stores/theme.ts
```

---

## 7. Security Constraints

- Theme manifest tokens/components validated by Zod schema at API boundary. No arbitrary CSS injection.
- System themes immutable (is_system = true, mutation rejected).
- Workspace themes tenant-isolated: all queries scoped by workspace membership.
- Theme editor writes only design tokens and predefined variant enums. No `v-html`, `innerHTML`, `eval`, or `Function` for theme content.
- KaTeX renders math from sanitized LaTeX input. `katex` options: `throwOnError: false`, no `trust` callback, no HTML output mode.
- Font values validated against an allowlist of safe font-family patterns (no `url()` or `expression()`).
- Color values validated as hex, rgb, hsl, or oklch patterns. No `url()`, `var()` references, or CSS expressions.

---

## 8. Testing Strategy

- **Unit tests**: theme-engine resolve/merge, CSS variable generation, variant resolution, Zod schema validation
- **Integration tests**: ThemeService CRUD, tenant isolation, system theme immutability, CAS
- **Component tests**: theme editor panel interactions, live preview, save/reset flow
- **E2E tests**: theme switch in workbench, variant visual changes, dark mode toggle, `prefers-reduced-motion`
- **Accessibility tests**: axe on theme editor, keyboard-only theme editing, visible focus
- **Golden tests**: each built-in component rendered with each variant, screenshot comparison
