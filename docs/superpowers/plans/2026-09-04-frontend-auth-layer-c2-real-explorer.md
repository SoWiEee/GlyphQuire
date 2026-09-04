# Frontend Auth Layer C-2 — Real Notes Explorer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the workbench's demo note list with the signed-in user's real notes: source the note list from `useNotesStore`, mount the full-featured `NoteExplorer` (create / rename / delete / trash) inside the workbench, add inline title search, and bridge "open a note" to the C-1 production session factory so selecting a note edits its real content.

**Architecture:** `WorkbenchContext` gains a `syncNotes(notes)` seam that reconciles its authoritative note list (and open tabs) with an externally-owned list, reusing its existing tab/session lifecycle. `Workbench.vue` runs in one of two modes discriminated by whether `props.initialNotes` was supplied: the existing demo/test mode (explicit `initialNotes` → `ExplorerPane`), or the new production mode (no `initialNotes` + a real workspace → `NoteExplorer` backed by `useNotesStore`, kept in sync into the context via `syncNotes`). `NoteExplorer` gains a client-side title filter. Opening a note flows `NoteExplorer → Workbench.openNote → WorkbenchContext.openNote → C-1 session factory (getNote)`.

**Tech Stack:** Vue 3 (`<script setup>`), Pinia, Vitest, `@vue/test-utils`.

**Spec:** docs/superpowers/specs/2026-09-03-frontend-auth-workspace-bootstrap-design.md (§5.2). Prerequisites — Layers A, B, C-0, C-1 — are all implemented and verified. C-1 provides the production `WorkbenchSessionFactory` via the authenticated host; this slice feeds it real note ids.

## Global Constraints

- No change to the C-1 session factory, the editor session, or the note lifecycle in `useNotesStore` — this slice sources and displays real notes and bridges "open" to the existing machinery.
- `syncNotes` must preserve `WorkbenchContext`'s invariants: never leave `activeNoteId` pointing at a note absent from `notes`; drop open tabs whose note disappeared; when the active note disappears, re-activate the last surviving tab (or none) through the existing session path — mirroring `closeNote`.
- The demo/test path (explicit `props.initialNotes`) must remain byte-for-byte behavior-compatible: every existing `Workbench.test.ts` / `WorkbenchPage.test.ts` case stays green unchanged. The new production path is reached only when `props.initialNotes` is `undefined`.
- `NoteSummary` (from `useNotesStore.activeNotes`) is `{ id, workspaceId, title, revision, visibility, createdAt, updatedAt, deletedAt }` — map to `WorkbenchNote` as `{ id, title, markdown: "" }` (content is loaded lazily by the C-1 factory on open).
- Linter oxlint, formatter oxfmt, tests vitest. Web tests: `pnpm --filter @glyphquire/web exec vitest run <file>`.

---

### Task 1: `WorkbenchContext.syncNotes`

**Files:**
- Modify: `apps/web/src/components/workbench/WorkbenchContext.ts` (add `syncNotes` to the `WorkbenchContext` interface + implementation)
- Modify: `apps/web/src/components/workbench/WorkbenchContext.test.ts` (add a test)

**Interfaces:**
- Produces: `syncNotes(notes: readonly WorkbenchNote[]): void` on the `WorkbenchContext` interface — replaces `state.notes` with the supplied list, reconciles `openTabs`/`activeNoteId`, and re-activates the session only when the active note was removed.

- [ ] **Step 1: Write the failing test**

Add to `apps/web/src/components/workbench/WorkbenchContext.test.ts` (a new `it(...)`, reusing the file's existing `createSession` helper + imports):

```ts
it("syncNotes reconciles the note list, tabs, and active session", async () => {
  const first: WorkbenchNote = { id: "first", title: "First", markdown: "# First" };
  const second: WorkbenchNote = { id: "second", title: "Second", markdown: "# Second" };
  const firstSession = createSession("first", "# Authoritative first");
  const secondSession = createSession("second", "# Authoritative second");
  const sessionFactory = vi.fn(async (note: Readonly<WorkbenchNote>) => {
    const handle: WorkbenchSessionHandle =
      note.id === "first" ? { session: firstSession } : { session: secondSession };
    return handle;
  });
  const context = createWorkbenchContext({
    initialNotes: [first, second],
    sessionFactory,
    workspaceId: "22222222-2222-4222-8222-222222222222",
  });
  await flushPromises();
  context.openNote("second");
  await flushPromises();
  expect(context.snapshot().activeNoteId).toBe("second");

  // A rename updates the title; the removed "first" is dropped from tabs;
  // "second" (active) still exists so the session is untouched.
  context.syncNotes([{ id: "second", title: "Second renamed", markdown: "" }]);
  await flushPromises();
  expect(context.snapshot().notes.map((n) => n.title)).toEqual(["Second renamed"]);
  expect(context.snapshot().openTabs.map((n) => n.id)).toEqual(["second"]);
  expect(context.snapshot().activeNoteId).toBe("second");
  expect(secondSession.dispose).not.toHaveBeenCalled();

  // Removing the active note re-activates the last surviving tab (none here → null).
  context.syncNotes([{ id: "third", title: "Third", markdown: "" }]);
  await flushPromises();
  expect(context.snapshot().activeNoteId).toBeNull();
  expect(context.snapshot().openTabs).toEqual([]);
  expect(secondSession.dispose).toHaveBeenCalled();

  await context.dispose();
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @glyphquire/web exec vitest run src/components/workbench/WorkbenchContext.test.ts`
Expected: FAIL — `context.syncNotes` is not a function.

- [ ] **Step 3: Add `syncNotes` to the interface**

In `apps/web/src/components/workbench/WorkbenchContext.ts`, add to the `WorkbenchContext` interface (beside `openNote`/`closeNote`):

```ts
  syncNotes(notes: readonly WorkbenchNote[]): void;
```

- [ ] **Step 4: Implement `syncNotes`**

In `createWorkbenchContext`, add this function beside `closeNote` (it reuses `activeNoteFor`, `refreshNoteProjection`, and `activateSession`, all already defined in scope):

```ts
  function syncNotes(nextNotes: readonly WorkbenchNote[]): void {
    if (disposed) return;
    const nextIds = new Set(nextNotes.map((note) => note.id));
    state.notes = nextNotes.map((note) => ({ ...note }));
    const activeRemoved = state.activeNoteId !== null && !nextIds.has(state.activeNoteId);
    state.openTabs = state.openTabs.filter((tab) => nextIds.has(tab.id));
    if (activeRemoved) {
      state.activeNoteId =
        state.openTabs.length > 0 ? state.openTabs[state.openTabs.length - 1]!.id : null;
      refreshNoteProjection();
      void activateSession(state.activeNote);
    } else {
      refreshNoteProjection();
    }
  }
```

- [ ] **Step 5: Return it from the context factory**

In the `return { ... }` object at the end of `createWorkbenchContext`, add `syncNotes,` beside `openNote`/`closeNote`.

- [ ] **Step 6: Run the test to verify it passes**

Run: `pnpm --filter @glyphquire/web exec vitest run src/components/workbench/WorkbenchContext.test.ts`
Expected: PASS (all tests, including the new one).

- [ ] **Step 7: Typecheck + lint + commit**

Run: `pnpm --filter @glyphquire/web typecheck`
Run: `pnpm exec oxlint apps/web/src/components/workbench/WorkbenchContext.ts apps/web/src/components/workbench/WorkbenchContext.test.ts`

```bash
git add apps/web/src/components/workbench/WorkbenchContext.ts apps/web/src/components/workbench/WorkbenchContext.test.ts
git commit -m "feat: add syncNotes seam to the workbench context"
```

---

### Task 2: Inline Title Search in `NoteExplorer`

**Files:**
- Modify: `apps/web/src/components/notes/NoteExplorer.vue`
- Modify: `apps/web/src/components/notes/NoteExplorer.smoke.test.ts` (add a filter test)

**Interfaces:**
- No new props/emits. Adds a local `query` ref and a `filteredActiveNotes` computed that filters `store.activeNotes` by case-insensitive title substring; the active-notes `<ul>` iterates `filteredActiveNotes`.

- [ ] **Step 1: Write the failing test**

The file already defines a `note(overrides)` helper returning a `NoteResult`, `WORKSPACE_ID`/`NOTE_ID` constants, and seeds the store via `store.configure({ listNotes, createNote, renameNote, deleteNote, restoreNote })` (a fake `listNotes` returning `{ items, nextCursor }`). Reuse exactly that pattern:

```ts
it("filters the active notes list by title substring", async () => {
  const store = useNotesStore();
  const listNotes = vi.fn(async () => ({
    items: [
      note({ id: NOTE_ID, title: "Grocery list" }),
      note({ id: "55555555-5555-4555-8555-555555555555", title: "Meeting notes" }),
    ],
    nextCursor: null,
  }));
  store.configure({
    listNotes,
    createNote: vi.fn(),
    renameNote: vi.fn(),
    deleteNote: vi.fn(),
    restoreNote: vi.fn(),
  });
  const wrapper = mount(NoteExplorer, { props: { workspaceId: WORKSPACE_ID } });
  await flushPromises();
  await wrapper.get('input[aria-label="Filter notes"]').setValue("meeting");
  expect(wrapper.text()).toContain("Meeting notes");
  expect(wrapper.text()).not.toContain("Grocery list");
});
```

(`note()`/`WORKSPACE_ID`/`NOTE_ID` are already defined at the top of the file — do not redefine them; the second note just needs a distinct canonical-UUID id as shown. The `store.configure` seam ensures `store.loadWorkspace` calls the fake `listNotes`, never the network.)

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @glyphquire/web exec vitest run src/components/notes/NoteExplorer.smoke.test.ts`
Expected: FAIL — there is no `input[aria-label="Filter notes"]` yet.

- [ ] **Step 3: Add the filter UI + computed**

In `apps/web/src/components/notes/NoteExplorer.vue`:

1. In `<script setup>`, add near the other refs:

```ts
const query = ref("");
const filteredActiveNotes = computed(() => {
  const needle = query.value.trim().toLowerCase();
  if (!needle) return store.activeNotes;
  return store.activeNotes.filter((note) => note.title.toLowerCase().includes(needle));
});
```

(Ensure `computed` is imported from `vue` — it likely already is; add it if not.)

2. In the template, add a search input directly under the header (before the active-notes `<ul>`):

```html
<div class="px-3 pb-2">
  <label for="note-explorer-filter" class="sr-only">Filter notes</label>
  <input
    id="note-explorer-filter"
    v-model="query"
    type="text"
    aria-label="Filter notes"
    placeholder="Search notes"
    class="w-full rounded border border-gray-300 px-2 py-1 text-sm"
  />
</div>
```

3. Change the active-notes list to iterate the filtered list: replace `v-for="note in store.activeNotes"` with `v-for="note in filteredActiveNotes"` (the empty-state `v-if` should use `filteredActiveNotes.length === 0 && !store.loading`).

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @glyphquire/web exec vitest run src/components/notes/NoteExplorer.smoke.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck + lint + commit**

Run: `pnpm --filter @glyphquire/web typecheck`
Run: `pnpm exec oxlint apps/web/src/components/notes/NoteExplorer.vue apps/web/src/components/notes/NoteExplorer.smoke.test.ts`

```bash
git add apps/web/src/components/notes/NoteExplorer.vue apps/web/src/components/notes/NoteExplorer.smoke.test.ts
git commit -m "feat: add inline title search to the note explorer"
```

---

### Task 3: Wire Real Notes into the Workbench

**Files:**
- Modify: `apps/web/src/components/workbench/Workbench.vue`
- Modify: `apps/web/src/components/workbench/Workbench.test.ts` (add a production-mode test)

**Interfaces:**
- Consumes: `useNotesStore` (list of real notes), `NoteExplorer` (real Explorer UI), `WorkbenchContext.syncNotes` (Task 1).
- Behavior: `Workbench.vue` renders `NoteExplorer` (backed by `useNotesStore`) instead of `ExplorerPane` when in production mode — i.e. when `props.initialNotes` is `undefined` AND a real `currentWorkspaceId` is present — and keeps `WorkbenchContext.notes` synced from `useNotesStore.activeNotes`. In demo/test mode (explicit `props.initialNotes`), the existing `ExplorerPane` path is unchanged.

- [ ] **Step 1: Write the failing production-mode test**

The file already defines `fakeSession(...)` (the session fake, ~line 60), `WORKSPACE_ID` (~line 23), and a `beforeEach` that sets an active pinia. Add `import { useNotesStore } from "../../stores/notes.js";` and `import type { NoteResult } from "@glyphquire/api-contract";` if not already imported. The test mounts `Workbench` with NO `initialNotes` + a real `workspaceId`, configures the notes store with a fake `listNotes`, and asserts the real note renders and opening it (via `NoteExplorer`'s open button, whose text is the note title) invokes the session factory:

```ts
it("shows real notes and opens one when authenticated (production mode)", async () => {
  const NOTE_A = "44444444-4444-4444-8444-444444444444";
  const realNote: NoteResult = {
    id: NOTE_A,
    workspaceId: WORKSPACE_ID,
    title: "Real note",
    revision: 3,
    visibility: "private",
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
    deletedAt: null,
    contentMarkdown: "",
    schemaVersion: 1,
  };
  const notesStore = useNotesStore();
  notesStore.configure({
    listNotes: vi.fn(async () => ({ items: [realNote], nextCursor: null })),
    createNote: vi.fn(),
    renameNote: vi.fn(),
    deleteNote: vi.fn(),
    restoreNote: vi.fn(),
  });
  const authority = fakeSession();
  const sessionFactory = vi.fn(async () => authority.session);
  const wrapper = mount(Workbench, { props: { sessionFactory, workspaceId: WORKSPACE_ID } });
  await flushPromises();
  expect(wrapper.text()).toContain("Real note");
  const openButton = wrapper
    .findAll('nav[aria-label="Notes explorer"] button')
    .find((button) => button.text().includes("Real note"));
  if (!openButton) throw new Error("expected a NoteExplorer open button for the real note");
  await openButton.trigger("click");
  await flushPromises();
  expect(sessionFactory).toHaveBeenCalled();
});
```

(`fakeSession`/`WORKSPACE_ID` are already in the file — reuse them; `authority.session` is what the existing tests pass to `sessionFactory`. `NoteExplorer`'s open button renders the note title as its text — confirmed in `NoteExplorer.vue` — so the text-based `find` targets it. The `beforeEach` already set an active pinia, so `useNotesStore()` resolves; no `global.plugins` needed if the file's `beforeEach` provides pinia — match the file's existing mount calls, adding `global: { plugins: [createPinia()] }` only if the other tests do.)

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @glyphquire/web exec vitest run src/components/workbench/Workbench.test.ts`
Expected: FAIL — `Workbench` renders `ExplorerPane` (demo) and does not show the store's real notes / mount `NoteExplorer`.

- [ ] **Step 3: Add production mode to `Workbench.vue`**

In `apps/web/src/components/workbench/Workbench.vue`:

1. Imports: add

```ts
import NoteExplorer from "../notes/NoteExplorer.vue";
import { useNotesStore } from "../../stores/notes.js";
```

2. Script: add the production-mode discriminator and the store sync. After `const workbenchContext = createWorkbenchContext({ ... })` and `currentWorkspaceId` are defined, add:

```ts
const notesStore = useNotesStore();
const productionNotes = computed(
  () => props.initialNotes === undefined && currentWorkspaceId.value !== null,
);

function toWorkbenchNote(summary: { id: string; title: string }): WorkbenchNote {
  return { id: summary.id, title: summary.title, markdown: "" };
}

watch(
  [productionNotes, currentWorkspaceId],
  ([isProduction, workspaceId]) => {
    if (isProduction && workspaceId) void notesStore.loadWorkspace(workspaceId);
  },
  { immediate: true },
);

watch(
  () => (productionNotes.value ? notesStore.activeNotes : null),
  (activeNotes) => {
    if (activeNotes) workbenchContext.syncNotes(activeNotes.map(toWorkbenchNote));
  },
  { immediate: true, deep: true },
);
```

(`createWorkbenchContext` must be created with `initialNotes: props.initialNotes` still — in production `props.initialNotes` is `undefined`, so the context starts from its own default; the first `syncNotes` immediately replaces `state.notes` with the real list. If starting from the demo defaults in production is undesirable in the brief moment before the first sync, pass `initialNotes: props.initialNotes ?? (currentWorkspaceId.value ? [] : undefined)` when constructing the context so production starts empty. Prefer this explicit empty-start form.)

3. Template: render `NoteExplorer` in production mode, `ExplorerPane` otherwise. Replace the existing `<ExplorerPane :notes="notes" :active-note-id="activeNoteId" @select="openNote" />` with:

```html
<NoteExplorer
  v-if="productionNotes && currentWorkspaceId"
  :workspace-id="currentWorkspaceId"
  :active-note-id="activeNoteId"
  @open="openNote"
/>
<ExplorerPane v-else :notes="notes" :active-note-id="activeNoteId" @select="openNote" />
```

- [ ] **Step 4: Run the new test + the full existing Workbench suite**

Run: `pnpm --filter @glyphquire/web exec vitest run src/components/workbench/Workbench.test.ts`
Expected: PASS — the new production-mode test passes AND every existing test (which all pass explicit `initialNotes`, so `productionNotes` is `false` and the `ExplorerPane` path is unchanged) still passes.

- [ ] **Step 5: Typecheck + lint**

Run: `pnpm --filter @glyphquire/web typecheck`
Run: `pnpm exec oxlint apps/web/src/components/workbench/Workbench.vue apps/web/src/components/workbench/Workbench.test.ts`
Expected: clean.

- [ ] **Step 6: Full web suite (regression guard)**

Run: `pnpm --filter @glyphquire/web test`
Expected: PASS, full suite green — especially `WorkbenchPage.test.ts` (which stubs `Workbench`, so it is unaffected) and every existing `Workbench.test.ts` case.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/components/workbench/Workbench.vue apps/web/src/components/workbench/Workbench.test.ts
git commit -m "feat: source real notes into the workbench explorer"
```

---

## Notes for the Reviewer / Verifier

- **Discriminator rationale:** production (the C-1 authenticated host) renders `<Workbench>` with no `initialNotes` prop (WorkbenchPage passes only `session-factory`/`workspace-id`), while every existing `Workbench.test.ts` passes explicit `initialNotes`. Gating the real-notes path on `props.initialNotes === undefined` therefore reaches production without altering any existing test's behavior. `WorkbenchPage.test.ts` stubs `Workbench` entirely, so it is untouched.
- **`syncNotes` safety:** it mirrors `closeNote`'s active-note-removal handling (re-activate the last surviving tab or `null`, via the existing `activateSession`), so it cannot leave a dangling `activeNoteId` or a session for a note no longer in the list. Task 1's test exercises rename (title update), active-note-survives (session untouched), and active-note-removed (session disposed, active → null).
- **Content loading:** the mapped `WorkbenchNote.markdown` is `""`; the C-1 session factory calls `getNote(note.id)` on open to load authoritative content + revision, so the empty placeholder is never shown as note content.
- **Out of scope (C-3):** HomePage `/` → workspace redirect and the Recent-notes panel are the next slice. Trash/rename/delete come free from the reused `NoteExplorer`; this slice does not re-implement them.
- **Manual E2E (verifier, with backing services + dev server):** sign in → the Explorer lists the workspace's real notes → create one (persists) → filter by title → open one → edit → autosave. C-2's automated proof is unit/component level; the full live flow is exercisable once running against the API.
