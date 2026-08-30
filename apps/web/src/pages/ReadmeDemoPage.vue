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

      <section v-if="scene === 'modes'" class="grid gap-6 lg:grid-cols-[0.72fr_1.28fr]">
        <aside class="space-y-5 rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
          <p class="text-xs font-semibold uppercase tracking-wider text-slate-500">Workbench</p>
          <h2 class="text-xl font-semibold">A calm place to write</h2>
          <p class="text-sm leading-6 text-slate-600">
            Switch between Source, Visual, and Split modes while the document stays canonical.
          </p>
          <div class="space-y-2 text-sm text-slate-600">
            <p class="flex items-center gap-2">
              <span class="h-2 w-2 rounded-full bg-cyan-500" />Canonical Markdown
            </p>
            <p class="flex items-center gap-2">
              <span class="h-2 w-2 rounded-full bg-violet-500" />Optimistic autosave
            </p>
            <p class="flex items-center gap-2">
              <span class="h-2 w-2 rounded-full bg-emerald-500" />Conflict-safe revisions
            </p>
          </div>
        </aside>
        <section class="space-y-4 rounded-xl border border-slate-200 bg-white p-6 shadow-xl">
          <div class="flex items-center justify-between border-b border-slate-200 pb-4">
            <div>
              <p class="text-xs uppercase tracking-wider text-slate-500">Welcome</p>
              <h2 class="mt-1 text-lg font-semibold">Project notebook</h2>
            </div>
            <div
              role="radiogroup"
              aria-label="Editor mode"
              class="flex rounded-md border border-slate-300 p-0.5 text-xs"
            >
              <button
                type="button"
                role="radio"
                aria-checked="false"
                class="rounded px-2 py-1 text-slate-600"
              >
                Source
              </button>
              <button
                type="button"
                role="radio"
                aria-checked="true"
                class="rounded bg-slate-900 px-2 py-1 text-white"
              >
                Visual
              </button>
              <button
                type="button"
                role="radio"
                aria-checked="false"
                class="rounded px-2 py-1 text-slate-600"
              >
                Split
              </button>
            </div>
          </div>
          <div
            role="tabpanel"
            aria-label="Project editor"
            class="min-h-[320px] rounded-lg bg-slate-50 p-6"
          >
            <p class="text-2xl font-semibold text-slate-900">Welcome to your notebook</p>
            <p class="mt-4 max-w-xl text-slate-600">
              Capture ideas, shape structured notes, and keep every edit portable.
            </p>
            <div class="mt-8 grid gap-3 sm:grid-cols-3">
              <div class="rounded-lg border border-slate-200 bg-white p-3 text-sm text-slate-600">
                Outline
              </div>
              <div class="rounded-lg border border-slate-200 bg-white p-3 text-sm text-slate-600">
                Draft
              </div>
              <div class="rounded-lg border border-slate-200 bg-white p-3 text-sm text-slate-600">
                Review
              </div>
            </div>
          </div>
          <button
            type="button"
            aria-label="Open command palette"
            class="rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-700"
            @click="paletteOpen = true"
          >
            Commands <kbd class="ml-1 rounded bg-slate-100 px-1 text-xs">⌘K</kbd>
          </button>
          <div
            v-if="paletteOpen"
            role="dialog"
            aria-label="Command palette"
            class="rounded-lg border border-slate-300 bg-white p-3 shadow-lg"
          >
            <input
              aria-label="Filter commands"
              placeholder="Filter commands"
              class="w-full rounded border border-slate-200 px-3 py-2 text-sm"
            />
            <ul role="listbox" aria-label="Commands" class="mt-2 space-y-1 text-sm">
              <li
                v-for="command in commands"
                :key="command"
                role="option"
                class="rounded px-3 py-2 text-slate-700"
              >
                {{ command }}
              </li>
            </ul>
          </div>
        </section>
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
          class="rounded-xl bg-white p-6 shadow-xl"
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
        <Phase5MaintenancePanel
          :workspace-id="WORKSPACE_ID"
          :client="maintenanceClient"
          :poll-interval-ms="1000"
          :max-poll-attempts="1"
        />
      </section>
    </main>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from "vue";
import Phase5MaintenancePanel from "../components/admin/Phase5MaintenancePanel.vue";
import SearchPalette from "../components/search/SearchPalette.vue";
import TransferDialog from "../components/transfer/TransferDialog.vue";
import VisualEditor from "../components/visual/VisualEditor.vue";
import type { Phase5MaintenanceClient } from "../api/Phase5Client.js";

const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
const scene = computed(() => new URLSearchParams(window.location.search).get("scene"));
const paletteOpen = ref(false);
const commands = [
  "Switch to Visual mode",
  "Manage assets",
  "Search notes",
  "Import or export",
  "Create read-only share link",
];
const title = computed(() =>
  scene.value === "modes"
    ? "Editor modes"
    : scene.value === "semantic"
      ? "Semantic blocks"
      : scene.value === "tools"
        ? "Search and transfer"
        : "Sharing and maintenance",
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
const maintenanceClient: Phase5MaintenanceClient = {
  async getMaintenanceCapabilities() {
    return {
      operator: true,
      capabilities: ["search.rebuild", "asset.cleanup", "jobs.dead_letters", "backup.verify"],
    };
  },
  async listDeadLetters() {
    return { items: [], nextCursor: null };
  },
  async getBackupVerification() {
    return { items: [], nextCursor: null };
  },
  async startSearchRebuild() {
    return { jobId: "77777777-7777-4777-8777-777777777777", duplicate: false };
  },
  async runAssetCleanup() {
    return { jobId: "88888888-8888-4888-8888-888888888888", duplicate: false };
  },
  async replayDeadLetter() {
    return { jobId: "99999999-9999-4999-8999-999999999999", duplicate: false };
  },
};
</script>
