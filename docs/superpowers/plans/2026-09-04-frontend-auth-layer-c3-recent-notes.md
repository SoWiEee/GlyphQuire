# Frontend Auth Layer C-3 — Recent Notes in the Explorer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "Recent" quick-access section to the top of `NoteExplorer` showing the few most-recently-updated notes, so a signed-in user can jump straight back to what they were working on.

**Architecture:** A pure, additive UI change to `NoteExplorer.vue`: a `recentNotes` computed derives the top-N of `store.activeNotes` sorted by `updatedAt` descending; a small "Recent" list renders above the full notes list and is hidden while the title filter is active (the filtered full list is the focus then). Each recent entry emits the existing `open` event. No store, routing, or session change — the `/` → workspace redirect this slice's spec section also mentions was already delivered by Layer B's router guard.

**Tech Stack:** Vue 3 (`<script setup>`), Pinia, Vitest, `@vue/test-utils`.

**Spec:** docs/superpowers/specs/2026-09-03-frontend-auth-workspace-bootstrap-design.md (§5.3). Prerequisites A/B/C-0/C-1/C-2 are all shipped and verified; C-2 mounted `NoteExplorer` in the workbench with real notes + inline search, which this extends.

## Global Constraints

- Additive only: no change to `useNotesStore`, routing, the C-1 session factory, or the existing Explorer list/search behavior. The `open` event and every existing `NoteExplorer` affordance stay unchanged.
- `NoteSummary.updatedAt` is an ISO-8601 timestamp string; ISO-8601 strings sort correctly lexicographically, so a plain string comparison orders by recency without `Date` parsing.
- The Recent section is hidden while the title filter (`query`) is non-empty.
- Linter oxlint, tests vitest. Web tests: `pnpm --filter @glyphquire/web exec vitest run <file>`.

---

### Task 1: Recent Notes Section in `NoteExplorer`

**Files:**
- Modify: `apps/web/src/components/notes/NoteExplorer.vue`
- Modify: `apps/web/src/components/notes/NoteExplorer.smoke.test.ts`

**Interfaces:**
- No new props/emits. Adds a `recentNotes` computed (top-5 of `store.activeNotes` by `updatedAt` desc) and a "Recent" list section that emits the existing `open` event.

- [ ] **Step 1: Write the failing test**

Add to `apps/web/src/components/notes/NoteExplorer.smoke.test.ts` (reuse the file's existing `note(overrides)` helper, `WORKSPACE_ID`, and `store.configure({...})` seam):

```ts
it("shows the most-recently-updated notes in a Recent section and opens one", async () => {
  const store = useNotesStore();
  const older = note({
    id: "55555555-5555-4555-8555-555555555555",
    title: "Older note",
    updatedAt: "2026-08-01T00:00:00.000Z",
  });
  const newer = note({
    id: "66666666-6666-4666-8666-666666666666",
    title: "Newer note",
    updatedAt: "2026-08-20T00:00:00.000Z",
  });
  store.configure({
    listNotes: vi.fn(async () => ({ items: [older, newer], nextCursor: null })),
    createNote: vi.fn(),
    renameNote: vi.fn(),
    deleteNote: vi.fn(),
    restoreNote: vi.fn(),
  });
  const wrapper = mount(NoteExplorer, { props: { workspaceId: WORKSPACE_ID } });
  await flushPromises();

  const recent = wrapper.get('[aria-label="Recent notes"]');
  const recentTitles = recent.findAll("button").map((button) => button.text());
  // Most-recent first.
  expect(recentTitles[0]).toContain("Newer note");
  expect(recentTitles).toContain("Older note");

  await recent.findAll("button")[0]!.trigger("click");
  expect(wrapper.emitted("open")?.[0]).toEqual(["66666666-6666-4666-8666-666666666666"]);

  // Recent hides while filtering.
  await wrapper.get('input[aria-label="Filter notes"]').setValue("older");
  expect(wrapper.find('[aria-label="Recent notes"]').exists()).toBe(false);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @glyphquire/web exec vitest run src/components/notes/NoteExplorer.smoke.test.ts`
Expected: FAIL — there is no `[aria-label="Recent notes"]` region yet.

- [ ] **Step 3: Add the `recentNotes` computed**

In `apps/web/src/components/notes/NoteExplorer.vue` `<script setup>`, add near `filteredActiveNotes`:

```ts
const RECENT_LIMIT = 5;
const recentNotes = computed(() =>
  [...store.activeNotes]
    .sort((first, second) => second.updatedAt.localeCompare(first.updatedAt))
    .slice(0, RECENT_LIMIT),
);
```

- [ ] **Step 4: Add the Recent section to the template**

In `apps/web/src/components/notes/NoteExplorer.vue`, directly AFTER the filter-input `<div class="px-3 pb-2"> … </div>` block and BEFORE the active-notes `<ul>`, add:

```html
<nav
  v-if="!query.trim() && recentNotes.length > 0"
  aria-label="Recent notes"
  class="pb-2"
>
  <h3 class="px-3 pt-1 pb-1 text-xs font-semibold uppercase tracking-wide text-gray-400">
    Recent
  </h3>
  <ul>
    <li v-for="note in recentNotes" :key="`recent-${note.id}`">
      <button
        type="button"
        class="flex w-full items-center truncate px-3 py-1 text-left text-sm text-gray-700 hover:bg-gray-100"
        @click="emit('open', note.id)"
      >
        <span class="truncate">{{ note.title }}</span>
      </button>
    </li>
  </ul>
</nav>
```

(`query`, `recentNotes`, and `emit('open', ...)` are all already in scope. The full notes list below is unchanged.)

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm --filter @glyphquire/web exec vitest run src/components/notes/NoteExplorer.smoke.test.ts`
Expected: PASS (all tests).

- [ ] **Step 6: Typecheck + lint + full web suite**

Run: `pnpm --filter @glyphquire/web typecheck`
Run: `pnpm exec oxlint apps/web/src/components/notes/NoteExplorer.vue apps/web/src/components/notes/NoteExplorer.smoke.test.ts`
Run: `pnpm --filter @glyphquire/web test`
Expected: all clean; full web suite green (no regressions).

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/components/notes/NoteExplorer.vue apps/web/src/components/notes/NoteExplorer.smoke.test.ts
git commit -m "feat: add a Recent notes section to the explorer"
```

---

## Notes for the Reviewer / Verifier

- The `/` → workspace redirect named in spec §5.3 was already delivered by Layer B's router guard (`resolveGuard`: an authenticated user at `/` is redirected to `/workspace/:personalWorkspaceId`), so this slice implements only the Recent-notes affordance.
- Sorting by the ISO-8601 `updatedAt` string is correct because ISO-8601 timestamps are lexicographically ordered; no `Date` parsing is needed. `[...store.activeNotes]` copies before sorting so the store's array is never mutated.
- Recent lives inside the same `<nav aria-label="Recent notes">` region so the test can scope to it; the main list keeps `aria-label="Active notes"`/its existing structure. Both point at the same `open` event, so clicking a recent entry opens the note exactly like the main list.
