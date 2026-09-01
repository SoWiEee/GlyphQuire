# Task 2 Report

status: DONE

## Scope

Replaced the owned workbench/runtime/editor UI glyphs and the theme-panel
inline close SVG with the shared `GqIcon` wrapper and Task 1 allowlisted icon
names. Status indicators now use semantic icon names; runtime Run, Stop, Reset,
and Loading controls use icons with their existing visible labels; note
creation, active-note selection, rename actions, trash disclosure, context
rail close, editor-tab close, theme-editor close, and the visual toggle
disclosure use shared icons. Existing events, labels, test IDs, disabled and
read-only behavior, focus handling, keyboard handling, and `aria-expanded`
state remain unchanged.

Modified files:

- `apps/web/src/components/workbench/StatusIndicator.vue`
- `apps/web/src/runtime/RuntimeHost.vue`
- `apps/web/src/components/workbench/ContextRail.vue`
- `apps/web/src/components/notes/NoteExplorer.vue`
- `apps/web/src/components/workbench/EditorTabs.vue`
- `apps/web/src/components/theme-editor/ThemeEditorPanel.vue`
- `apps/web/src/editors/visual/nodes/toggle.ts`

## Verification

- `pnpm --filter @glyphquire/web exec vitest run src/components/workbench/StatusIndicator.test.ts src/runtime/RuntimeHost.test.ts src/components/workbench/ContextRail.test.ts src/components/notes/NoteExplorer.smoke.test.ts src/components/workbench/Workbench.test.ts src/components/workbench/workbench-a11y.test.ts` — passed, 6 files / 29 tests.
- `pnpm --filter @glyphquire/web typecheck` — passed.
- `pnpm lint` — passed.
- `pnpm exec oxfmt --check apps/web/src/components/workbench/StatusIndicator.vue apps/web/src/runtime/RuntimeHost.vue apps/web/src/components/workbench/ContextRail.vue apps/web/src/components/notes/NoteExplorer.vue apps/web/src/components/workbench/EditorTabs.vue apps/web/src/components/theme-editor/ThemeEditorPanel.vue apps/web/src/editors/visual/nodes/toggle.ts` — passed.
- `git diff --check` — passed.

## Notable decisions and deferred items

- The raw DOM toggle node view renders `GqIcon` into its existing chevron span
  and unmounts it when the node view is destroyed, retaining the existing
  ProseMirror event and mutation boundaries.
- No component test selectors or accessible names needed changing, so no test
  files were modified.
