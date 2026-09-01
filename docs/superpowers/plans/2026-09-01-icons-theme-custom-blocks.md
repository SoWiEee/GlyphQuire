# Icons, Theme Persistence, and Custom Blocks Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a shared Lucide icon language, authenticated user theme persistence, and workspace-scoped declarative Custom Blocks with safe Markdown round-tripping.

**Architecture:** Shared schemas and allowlists live in `packages/theme-sdk`. The document engine consumes immutable declarative definitions through a registry adapter and emits a recoverable `custom-block` AST node. API services own authorization, CAS, and PostgreSQL persistence; the web app owns rendering, editor controls, and server-synchronized theme state.

**Tech Stack:** TypeScript, Vue 3, `@lucide/vue`, Hono, Zod, Drizzle/PostgreSQL, Milkdown/ProseMirror, Vitest, Playwright, Oxlint, Oxfmt.

## Global Constraints

- Custom Blocks are workspace-scoped, declarative, versioned, and never execute arbitrary Vue, JavaScript, HTML, CSS, filesystem access, credentials, or unrestricted network requests.
- The first Custom Block release accepts only `static` and `interactive-ui` capabilities; `p5` and `canvas` remain on the existing sandbox contract.
- Published Custom Block versions are immutable; mutations require membership, owner/editor permission, `operationId`, and `baseRevision` CAS.
- Theme preference is user-scoped and synchronized by API across workspaces/devices; do not add localStorage fallback or compatibility aliases.
- Icon names, Custom Block presets, variants, capabilities, and props schema keywords are allowlists enforced server-side and client-side.
- Keep verification focused: core unit/integration tests and one desktop Chrome smoke; no broad visual snapshots or mobile E2E.
- Preserve `AGENTS.md` and all existing untracked user planning documents; stage only files explicitly owned by the current task.

---

### Task 1: Shared Icon Contract and Lucide Wrapper

**Files:**
- Modify: `packages/theme-sdk/src/schemas.ts`, `packages/theme-sdk/src/index.ts`, `packages/theme-sdk/tests/schemas.test.ts`
- Create: `packages/theme-sdk/src/icons.ts`, `apps/web/src/components/icons/GqIcon.vue`, `apps/web/src/components/icons/GqIcon.test.ts`
- Modify: `apps/web/package.json`, `pnpm-lock.yaml`

**Interfaces:**
- Produce `IconName`, `iconNameSchema`, and `CUSTOM_BLOCK_ICON_NAMES` from `@glyphquire/theme-sdk`.
- Produce `<GqIcon :name :size :stroke-width :decorative :label />` with `size` values `sm | md | lg`, `currentColor`, and `aria-hidden` for decorative use.

- [ ] **Step 1: Add the allowlist and schema.**

  Define a finite list covering existing controls and Custom Block semantics (`x`, `check`, `loader-circle`, `circle-alert`, `info`, `lightbulb`, `sticky-note`, `chevron-down`, `chevrons-right`, `columns-3`, `layout-panel-top`, `search`, `upload`, `download`, `link-2`, `settings`, `palette`, `play`, `square`, `rotate-ccw`, `bold`, `italic`, `heading-2`, `list`, and `file-text`). Export the tuple, union, and Zod enum; reject every other name.

- [ ] **Step 2: Install Lucide and implement `GqIcon`.**

  Run `pnpm --filter @glyphquire/web add @lucide/vue@latest`. Map each allowlisted name to its imported Lucide component in a static record so bundling remains tree-shakeable. Render the component with `aria-hidden="true"` when `decorative` is true; otherwise require a non-empty accessible label. Do not add the deprecated `lucide-vue-next` package.

- [ ] **Step 3: Test the contract.**

  Assert the schema rejects unknown names and the Vue component emits the expected SVG, size class, `currentColor`, and accessible label/hidden semantics.

- [ ] **Step 4: Verify.**

  Run `pnpm --filter @glyphquire/theme-sdk test`, `pnpm --filter @glyphquire/web exec vitest run src/components/icons/GqIcon.test.ts`, `pnpm lint`, and `pnpm exec oxfmt --check` on touched files.

### Task 2: Replace UI Glyphs with Icons

**Files:**
- Modify: `apps/web/src/components/workbench/StatusIndicator.vue`
- Modify: `apps/web/src/runtime/RuntimeHost.vue`
- Modify: `apps/web/src/components/workbench/ContextRail.vue`
- Modify: `apps/web/src/components/notes/NoteExplorer.vue`
- Modify: `apps/web/src/components/workbench/EditorTabs.vue`
- Modify: `apps/web/src/components/theme-editor/ThemeEditorPanel.vue`
- Modify: `apps/web/src/editors/visual/nodes/toggle.ts`
- Modify: focused existing component tests only when selectors or accessible names change

**Interfaces:**
- Consume `GqIcon` and `IconName` from Task 1.
- Preserve all existing emitted events, button labels, disabled states, and keyboard behavior.

- [ ] **Step 1: Replace status and runtime text glyphs.**

  Map saved/saving/dirty/error/unavailable to semantic icons; map Run/Stop/Reset and Note Explorer selection to icons while keeping visible text where it communicates the action. Do not expose internal capability names.

- [ ] **Step 2: Replace close and disclosure glyphs.**

  Use `x` in close controls and `chevron-down`/`chevrons-right` in toggle disclosure. Keep `aria-expanded`, `aria-label`, focus rings, and read-only behavior unchanged.

- [ ] **Step 3: Verify focused UI behavior.**

  Run `pnpm --filter @glyphquire/web exec vitest run src/components/workbench/Workbench.test.ts src/components/workbench/workbench-a11y.test.ts`, `pnpm --filter @glyphquire/web typecheck`, and `pnpm lint`.

### Task 3: Persist User Theme Preferences in the API

**Files:**
- Create: `packages/database/src/schema/user-preferences.ts`, `packages/database/src/migrations/0012_user_preferences.sql`
- Modify: `packages/database/src/schema/index.ts`, `packages/database/src/index.ts`
- Create: `packages/api-contract/src/preferences/schemas.ts`, `packages/api-contract/src/preferences/types.ts`
- Modify: `packages/api-contract/src/index.ts`
- Create: `apps/api/src/modules/preferences/UserPreferenceService.ts`, `apps/api/src/routes/v1/preferences.ts`
- Modify: `apps/api/src/app.ts`
- Create: `apps/api/src/modules/preferences/UserPreferenceService.integration.test.ts`, `apps/api/src/routes/v1/preferences.integration.test.ts`

**Interfaces:**
- `GET /api/v1/me/preferences/theme` returns `{ themeId: string | null, mode: "light" | "dark", customOverrides: object, variantOverrides: object, revision: number, updatedAt: string }`.
- `PUT /api/v1/me/preferences/theme` accepts the same complete payload plus `baseRevision`; revision `0` creates the first row and later writes use exact CAS.
- Theme ids must reference system themes only; workspace theme selection remains handled by existing workspace-scoped APIs.

- [ ] **Step 1: Add schema and migration.**

  Create one row per user with a foreign key to `user`, nullable system `theme_id`, checked `mode`, JSONB overrides, positive revision, and timestamps. Add indexes/constraints and register the schema exports. Use the final migration filename `0012_user_preferences.sql`.

- [ ] **Step 2: Add strict contracts and service.**

  Reuse `partialThemeTokensSchema` and `themeComponentVariantsSchema`; reject unknown keys and non-system theme ids. Implement read defaults without writing a row, insert-on-revision-zero, and update-on-matching-revision. Return existing public error envelopes for invalid input and revision conflicts.

- [ ] **Step 3: Add routes and app wiring.**

  Read `actorId` only from request context; never accept a user id or workspace id from the request. Register the routes under `/api/v1` and keep authentication middleware ordering identical to other protected routes.

- [ ] **Step 4: Test.**

  Cover unauthenticated rejection, default read, first write, CAS conflict, cross-user isolation, system-theme validation, malformed overrides, and error envelopes with PostgreSQL integration tests.

### Task 4: Synchronize ThemeProvider and Theme Editor

**Files:**
- Create: `apps/web/src/api/ThemePreferenceClient.ts`, `apps/web/src/themes/useThemePersistence.ts`
- Modify: `apps/web/src/themes/ThemeProvider.ts`, `apps/web/src/stores/theme.ts`, `apps/web/src/layouts/AppLayout.vue`, `apps/web/src/components/theme-editor/ThemeEditorPanel.vue`, `apps/web/src/components/theme-editor/ThemeActions.vue`
- Create: `apps/web/src/themes/useThemePersistence.test.ts`

**Interfaces:**
- `ThemePreferenceClient.get()` and `.put(input)` use the shared API contract and return the server revision.
- `useThemePersistence(context)` exposes `load()` and `save()`; `save()` commits the provider only after a successful response.

- [ ] **Step 1: Load authenticated preferences at app bootstrap.**

  Call `GET /api/v1/me/preferences/theme` once from the application-scoped theme context. Apply server mode, system theme, token overrides, and variants through `ThemeProvider`; unauthenticated routes retain the default in-memory theme without creating client storage.

- [ ] **Step 2: Persist editor saves and dark-mode changes.**

  Make Save send the complete payload with the provider revision. Keep drafts on request failure, show a concise error, and update the revision only from the response. The Dark control writes `light`/`dark`, not a hidden boolean fallback.

- [ ] **Step 3: Populate the theme selector from the existing theme API.**

  Load the current workspace's themes into `useThemeStore.availableThemes`; keep system-theme selection globally valid and prevent selecting a workspace theme outside the active membership scope.

- [ ] **Step 4: Test and verify.**

  Cover load/apply, save success, save failure retaining draft, revision conflict, and reload persistence with mocked client responses. Run the focused web tests, typecheck, lint, and build.

### Task 5: Declarative Custom Block Contract and Document Engine

**Files:**
- Modify: `packages/theme-sdk/src/schemas.ts`, `packages/theme-sdk/src/types.ts`, `packages/theme-sdk/src/index.ts`
- Modify: `packages/document-engine/src/ast/nodes.ts`, `packages/document-engine/src/registry/types.ts`, `packages/document-engine/src/registry/registry.ts`, `packages/document-engine/src/registry/index.ts`, `packages/document-engine/src/parser/transform.ts`, `packages/document-engine/src/serializer/to-mdast.ts`
- Create: `packages/document-engine/src/registry/declarative.ts`
- Create/modify: `packages/theme-sdk/tests/custom-block-schema.test.ts`, `packages/document-engine/src/registry/declarative.test.ts`, `packages/document-engine/src/parser/custom-block.test.ts`, `packages/document-engine/src/serializer/custom-block.test.ts`

**Interfaces:**
- `CustomBlockDefinition` contains `name`, positive `version`, `kind`, bounded `propsSchema`, `contentPolicy`, allowlisted `icon`, approved `preset`, optional approved `variant`, token mapping, and `capabilities: ("static" | "interactive-ui")[]`.
- `CustomBlockNode` contains `type: "custom-block"`, `name`, `version`, string attributes, parsed props, children, and optional original source.
- `registerDeclarative(registry, definition)` adapts a validated definition to the existing registry without constructing executable code.

- [ ] **Step 1: Define and validate the bounded schema.**

  Allow only JSON-compatible scalar props with explicit `type`, `required`, `enum`, and max-length/maximum constraints. Reject built-in names, duplicate names, unsupported capabilities, arbitrary CSS/HTML/URLs, and unknown schema keywords.

- [ ] **Step 2: Add the AST and registry adapter.**

  Parse a matching directive into `custom-block` while preserving name/version/attributes/children. The adapter may select only approved primitive renderers; it must never evaluate a function supplied by the definition payload.

- [ ] **Step 3: Add serializer and unsupported preservation.**

  Serialize `custom-block` back to its directive form. If a definition is missing or invalid, produce the existing unsupported/invalid placeholder with original source and ensure parse → serialize keeps the authored directive byte-stable where the existing grammar permits.

- [ ] **Step 4: Test.**

  Add valid, invalid, nested, malformed, unknown-definition, and round-trip fixtures. Run the document-engine and theme-sdk test suites plus typecheck.

### Task 6: Custom Block Persistence and Workspace API

**Files:**
- Create: `packages/database/src/schema/custom-blocks.ts`, `packages/database/src/migrations/0013_custom_blocks.sql`
- Modify: `packages/database/src/schema/index.ts`, `packages/database/src/index.ts`
- Create: `packages/api-contract/src/custom-blocks/schemas.ts`, `packages/api-contract/src/custom-blocks/types.ts`
- Modify: `packages/api-contract/src/index.ts`
- Create: `apps/api/src/modules/custom-blocks/CustomBlockService.ts`, `apps/api/src/routes/v1/custom-blocks.ts`
- Modify: `apps/api/src/app.ts`
- Create: `apps/api/src/modules/custom-blocks/CustomBlockService.integration.test.ts`, `apps/api/src/routes/v1/custom-blocks.integration.test.ts`

**Interfaces:**
- `GET/POST /api/v1/workspaces/:workspaceId/custom-blocks` lists or creates definitions.
- `PUT /api/v1/custom-blocks/:id/draft` updates a draft with `baseRevision`.
- `POST /api/v1/custom-blocks/:id/publish` publishes the next immutable version.
- `DELETE /api/v1/custom-blocks/:id` deletes only an unpublished draft.

- [ ] **Step 1: Add versioned tables and constraints.**

  Store block identity, workspace, name, current revision, and creator in `custom_blocks`; store version, validated definition JSONB, draft/published state, creator, and publish timestamp in `custom_block_versions`. Enforce unique workspace/name and unique block/version constraints.

- [ ] **Step 2: Implement authorization and lifecycle.**

  Owners/editors may create, edit, publish, and delete drafts; viewers may list and resolve. Enforce reserved-name, schema, icon, preset, capability, and cross-workspace checks before writes. Published rows cannot be updated or deleted.

- [ ] **Step 3: Register routes and test.**

  Return cursor-free bounded lists for the five-user workload, use existing public errors, and cover membership isolation, viewer denial, CAS conflict, publish immutability, duplicate names, invalid definitions, and draft deletion.

### Task 7: Web Custom Block Management and Editor Integration

**Files:**
- Create: `apps/web/src/api/CustomBlockClient.ts`, `apps/web/src/stores/custom-blocks.ts`
- Create: `apps/web/src/components/custom-blocks/CustomBlocksPanel.vue`, `apps/web/src/components/custom-blocks/CustomBlockForm.vue`, `apps/web/src/components/custom-blocks/CustomBlockPicker.vue`, `apps/web/src/components/custom-blocks/UnsupportedCustomBlock.vue`
- Modify: `apps/web/src/components/workbench/Workbench.vue` (including command definitions), `apps/web/src/components/workbench/ContextRail.vue`, `apps/web/src/editors/visual/MilkdownVisualAdapter.ts`, `apps/web/src/editors/visual/schema.ts`
- Create: `apps/web/src/components/custom-blocks/custom-blocks.test.ts`

**Interfaces:**
- `CustomBlockClient` consumes Task 6 contracts and returns published/draft definitions.
- `useCustomBlocksStore` exposes `definitions`, `load(workspaceId)`, `createDraft`, `updateDraft`, `publish`, and `deleteDraft`.
- `CustomBlockPicker` emits a directive insertion request; `UnsupportedCustomBlock` renders a non-executable recoverable notice.

- [ ] **Step 1: Add management UI.**

  Add a focused Workbench tool panel with list, create form, draft edit, preview, publish, and delete-draft actions. Use `GqIcon`; expose only friendly labels and server error messages safe for the user.

- [ ] **Step 2: Load workspace definitions.**

  Load definitions after workspace selection, build a registry from validated definitions, and dispose/rebuild it on workspace change. Never merge definitions from another workspace.

- [ ] **Step 3: Add editor picker and rendering.**

  Add a Custom Blocks entry to the existing block picker/command path. Insert only serialized directives; render approved primitives in Visual mode and the unsupported notice for missing definitions. Keep source mode canonical and preserve round-trip.

- [ ] **Step 4: Test and verify.**

  Cover store request states, form validation, publish/delete affordances, picker insertion, unsupported rendering, keyboard labels, and workspace fencing with focused tests. Run web typecheck, lint, build, and one desktop Chrome smoke for insertion and keyboard operation.

### Task 8: SPEC Update and Integrated Release Verification

**Files:**
- Modify: `docs/SPEC.md`, `docs/MARKDOWN_SPEC.md`, `README.md` only where the user-facing feature list is stale
- Create: `docs/superpowers/plans/2026-09-01-icons-theme-custom-blocks-report.md`

- [ ] **Step 1: Update normative documentation.**

  Record the final icon accessibility contract, user preference persistence, Custom Block lifecycle/schema, unsupported placeholder behavior, and explicit runtime capability boundary. Remove obsolete phase labels or debug-only wording from user-facing sections.

- [ ] **Step 2: Run integrated gates.**

  Run `pnpm typecheck`, `pnpm lint`, `pnpm build`, focused package tests for `theme-sdk`, `document-engine`, API preferences/custom blocks, and web tests. Run the desktop Chrome smoke only; do not add mobile browser checks.

- [ ] **Step 3: Perform final review.**

  Confirm no untracked user documents were staged, no compatibility layer/fallback was introduced, no raw code/CSS path is reachable from Custom Block input, and no user-visible debug/phase naming remains. Record commands and outcomes in the report.
