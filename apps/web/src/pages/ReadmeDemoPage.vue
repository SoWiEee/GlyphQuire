<template>
  <div class="min-h-screen bg-slate-100 p-8 text-slate-900">
    <main class="mx-auto max-w-6xl space-y-6">
      <header class="flex items-center justify-between border-b border-slate-200 pb-5">
        <div>
          <p class="text-xs font-semibold uppercase tracking-[0.24em] text-cyan-700">GlyphQuire</p>
          <h1 class="mt-2 text-3xl font-semibold tracking-tight">{{ title }}</h1>
        </div>
        <span class="rounded-full border border-cyan-600/30 px-3 py-1 text-xs text-cyan-800"
          >Local demo</span
        >
      </header>

      <section v-if="scene === 'modes'" class="space-y-4">
        <div
          class="flex items-end justify-between rounded-xl border border-slate-200 bg-white p-5 shadow-sm"
        >
          <div>
            <p class="text-xs font-semibold uppercase tracking-wider text-cyan-700">Workbench</p>
            <h2 class="mt-1 text-xl font-semibold">A calm place to write</h2>
            <p class="mt-2 max-w-2xl text-sm leading-6 text-slate-600">
              Switch between Source, Visual, and Split modes while one canonical document stays in
              control.
            </p>
          </div>
        </div>
        <div
          class="h-[650px] overflow-hidden rounded-xl border border-slate-200 bg-white shadow-xl"
        >
          <Workbench
            :initial-notes="demoNotes"
            :session-factory="demoSessionFactory"
            :workspace-id="WORKSPACE_ID"
            :note-id="NOTE_ID"
          />
        </div>
      </section>

      <section v-else-if="scene === 'semantic'" class="grid gap-6 lg:grid-cols-[0.8fr_1.2fr]">
        <aside class="space-y-4 rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
          <p class="text-sm leading-6 text-slate-600">
            Semantic Markdown blocks remain structured while the visual editor keeps the writing
            flow calm and readable.
          </p>
          <ul class="space-y-3 text-sm text-slate-600">
            <li class="flex items-center gap-3">
              <span class="h-2 w-2 rounded-full bg-cyan-500" />Callouts for emphasis
            </li>
            <li class="flex items-center gap-3">
              <span class="h-2 w-2 rounded-full bg-violet-500" />Toggles for progressive detail
            </li>
            <li class="flex items-center gap-3">
              <span class="h-2 w-2 rounded-full bg-amber-500" />Tabs and columns for comparison
            </li>
          </ul>
        </aside>
        <section
          data-testid="readme-semantic-editor"
          aria-label="Semantic editor"
          class="readme-semantic-editor rounded-xl bg-white p-6 shadow-xl"
        >
          <VisualEditor :markdown="semanticMarkdown" :read-only="true" />
        </section>
      </section>

      <section v-else-if="scene === 'tools'" class="grid gap-6 lg:grid-cols-2">
        <SearchPalette :workspace-id="WORKSPACE_ID" @select-note="() => undefined" />
        <TransferDialog :workspace-id="WORKSPACE_ID" />
      </section>

      <section v-else class="grid gap-6 lg:grid-cols-2">
        <section
          aria-label="Share link"
          class="space-y-5 rounded-xl border border-slate-200 bg-white p-6 shadow-sm"
        >
          <div class="flex items-center justify-between">
            <h2 class="text-xl font-semibold">Read-only sharing</h2>
            <span class="rounded bg-emerald-100 px-2 py-1 text-xs text-emerald-800">Protected</span>
          </div>
          <p class="text-sm leading-6 text-slate-600">
            Share a focused note with a revocable, read-only link and a clear expiry.
          </p>
          <div class="rounded-lg border border-slate-200 bg-slate-50 p-4">
            <p class="text-xs uppercase tracking-wider text-slate-500">Access</p>
            <p class="mt-2 text-sm text-slate-700">Anyone with the link can read</p>
          </div>
          <button
            type="button"
            aria-label="Create share link"
            class="rounded-lg bg-cyan-600 px-4 py-2 text-sm font-semibold text-white"
          >
            Create share link
          </button>
        </section>
      </section>
    </main>
  </div>
</template>

<script setup lang="ts">
import { computed } from "vue";
import SearchPalette from "../components/search/SearchPalette.vue";
import TransferDialog from "../components/transfer/TransferDialog.vue";
import VisualEditor from "../components/visual/VisualEditor.vue";
import Workbench from "../components/workbench/Workbench.vue";
import type { EditorSession, EditorSessionState } from "../editors/editor-session.types.js";
import type { WorkbenchNote } from "../components/workbench/types.js";

const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
const NOTE_ID = "22222222-2222-4222-8222-222222222222";
const scene = computed(() => new URLSearchParams(window.location.search).get("scene"));
const title = computed(() =>
  scene.value === "modes"
    ? "Editor modes"
    : scene.value === "semantic"
      ? "Semantic blocks"
      : scene.value === "tools"
        ? "Search and transfer"
        : "Sharing",
);
const semanticMarkdown = `---
glyphquire-spec: 1
---

:::callout{type="info" title="A focused writing space"}
Keep intent visible without losing Markdown portability.
:::

::::toggle{title="Toggle supporting notes" open="true"}
Details stay close to the paragraph they explain.
::::

::::tabs

:::tab{title="Overview"}
Structured notes remain readable.
:::

:::tab{title="Examples"}
Canonical Markdown stays portable.
:::

::::

::::columns{count="2"}

:::column
Source remains inspectable.
:::

:::column
Visual blocks stay easy to scan.
:::

::::
`;

const demoNotes: readonly WorkbenchNote[] = [
  {
    id: NOTE_ID,
    title: "Project notebook",
    markdown:
      "Welcome to your notebook.\nCapture ideas, shape structured notes, and keep every edit portable.",
  },
];

const demoSessionFactory = async (): Promise<EditorSession> => {
  let current: EditorSessionState = {
    noteId: NOTE_ID,
    markdown: demoNotes[0]?.markdown ?? "",
    baseRevision: 2,
    dirty: false,
    saveStatus: "clean",
    conflict: null,
    mode: "source",
    activePane: "source",
    diagnostics: [],
    readOnly: false,
    isReadOnly: false,
    draftDurability: "persisted",
    draftDurabilityError: null,
    autosave: {
      status: "clean",
      revision: 2,
      lastSavedAt: "2026-08-30T00:00:00.000Z",
      lastError: null,
      conflict: null,
      pending: null,
    },
  };
  const listeners = new Set<(state: EditorSessionState) => void>();
  const notify = () => listeners.forEach((listener) => listener(current));
  return {
    snapshot: () => current,
    edit(markdown) {
      current = { ...current, markdown, dirty: true, saveStatus: "dirty" };
      notify();
    },
    async switchMode(mode) {
      current = { ...current, mode, activePane: mode === "visual" ? "visual" : "source" };
      notify();
      return { success: true, mode };
    },
    async attachModeAdapters() {
      return () => undefined;
    },
    async saveNow() {
      current = { ...current, dirty: false, saveStatus: "saved" };
      notify();
    },
    async requestTakeover() {
      return false;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async dispose() {
      listeners.clear();
    },
  };
};
</script>

<style scoped>
.readme-semantic-editor :deep([data-glyphquire-node] > header) {
  display: none;
}

.readme-semantic-editor :deep([data-glyphquire-node="callout"]) {
  border: 1px solid rgb(103 232 249 / 0.45);
  border-radius: 0.75rem;
  background: linear-gradient(135deg, rgb(236 254 255), rgb(239 246 255));
  padding: 1rem 1.25rem;
  color: rgb(15 23 42);
}

.readme-semantic-editor :deep([data-glyphquire-node="toggle"]) {
  border: 1px solid rgb(196 181 253 / 0.55);
  border-radius: 0.75rem;
  background: rgb(250 245 255);
  padding: 1rem 1.25rem;
  color: rgb(30 27 75);
}

.readme-semantic-editor :deep([data-glyphquire-node="tabs"]) {
  border: 1px solid rgb(251 191 36 / 0.55);
  border-radius: 0.75rem;
  background: rgb(255 251 235);
  padding: 1rem 1.25rem;
  color: rgb(69 26 3);
}

.readme-semantic-editor :deep([data-glyphquire-node="columns"]) {
  display: flex;
  gap: 1rem;
  border-radius: 0.75rem;
  background: rgb(248 250 252);
  padding: 1rem;
  color: rgb(30 41 59);
}

.readme-semantic-editor :deep([data-glyphquire-node="column"]) {
  flex: 1;
  border: 1px solid rgb(203 213 225);
  border-radius: 0.5rem;
  background: white;
  padding: 0.875rem;
}
</style>
