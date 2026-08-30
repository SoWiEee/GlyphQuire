<template>
  <div class="min-h-screen bg-slate-950 p-8 text-slate-100">
    <main class="mx-auto max-w-6xl space-y-6">
      <header class="flex items-center justify-between border-b border-slate-700 pb-5">
        <div>
          <p class="text-xs font-semibold uppercase tracking-[0.24em] text-cyan-300">GlyphQuire</p>
          <h1 class="mt-2 text-3xl font-semibold tracking-tight">{{ title }}</h1>
        </div>
        <span class="rounded-full border border-cyan-400/40 px-3 py-1 text-xs text-cyan-200"
          >Local demo</span
        >
      </header>

      <section v-if="scene === 'semantic'" class="grid gap-6 lg:grid-cols-[0.8fr_1.2fr]">
        <aside class="space-y-4 rounded-xl border border-slate-700 bg-slate-900 p-5">
          <p class="text-sm leading-6 text-slate-300">
            Semantic Markdown blocks remain structured while the visual editor keeps the writing
            flow calm and readable.
          </p>
          <ul class="space-y-3 text-sm text-slate-300">
            <li class="flex items-center gap-3">
              <span class="h-2 w-2 rounded-full bg-cyan-300" />Callouts for emphasis
            </li>
            <li class="flex items-center gap-3">
              <span class="h-2 w-2 rounded-full bg-violet-300" />Toggles for progressive detail
            </li>
            <li class="flex items-center gap-3">
              <span class="h-2 w-2 rounded-full bg-amber-300" />Tabs and columns for comparison
            </li>
          </ul>
        </aside>
        <section
          data-testid="readme-semantic-editor"
          aria-label="Semantic editor"
          class="space-y-4 rounded-xl bg-white p-6 text-slate-900 shadow-2xl"
        >
          <div
            data-glyphquire-node="callout"
            class="rounded-lg border-l-4 border-cyan-500 bg-cyan-50 p-4"
          >
            <p class="font-semibold text-cyan-950">A focused writing space</p>
            <p class="mt-1 text-sm text-cyan-900">
              Keep intent visible without losing Markdown portability.
            </p>
          </div>
          <details
            data-glyphquire-node="toggle"
            open
            class="rounded-lg border border-slate-200 p-4"
          >
            <summary class="cursor-pointer font-semibold">Toggle supporting notes</summary>
            <p class="mt-3 text-sm text-slate-600">
              Details stay close to the paragraph they explain.
            </p>
          </details>
          <div
            data-glyphquire-node="tabs"
            class="grid grid-cols-3 gap-2 rounded-lg bg-slate-100 p-2 text-center text-sm"
          >
            <span class="rounded bg-slate-900 px-3 py-2 text-white">Overview</span
            ><span class="px-3 py-2 text-slate-600">Examples</span
            ><span class="px-3 py-2 text-slate-600">Notes</span>
          </div>
          <div data-glyphquire-node="columns" class="grid gap-3 sm:grid-cols-2">
            <div class="rounded-lg border border-slate-200 p-4">
              <p class="font-medium">Source</p>
              <p class="mt-2 text-sm text-slate-600">Canonical Markdown remains inspectable.</p>
            </div>
            <div class="rounded-lg border border-slate-200 p-4">
              <p class="font-medium">Visual</p>
              <p class="mt-2 text-sm text-slate-600">Rendered blocks stay easy to scan.</p>
            </div>
          </div>
        </section>
      </section>

      <section v-else class="grid gap-6 lg:grid-cols-[1fr_1fr]">
        <section
          aria-label="Share link"
          class="space-y-5 rounded-xl border border-slate-700 bg-slate-900 p-6"
        >
          <div class="flex items-center justify-between">
            <h2 class="text-xl font-semibold">Read-only sharing</h2>
            <span class="rounded bg-emerald-400/15 px-2 py-1 text-xs text-emerald-200"
              >Protected</span
            >
          </div>
          <p class="text-sm leading-6 text-slate-300">
            Share a focused note with a revocable, read-only link and a clear expiry.
          </p>
          <div class="rounded-lg border border-slate-700 bg-slate-950 p-4">
            <p class="text-xs uppercase tracking-wider text-slate-400">Access</p>
            <p class="mt-2 text-sm text-slate-200">Anyone with the link can read</p>
          </div>
          <button
            type="button"
            aria-label="Create share link"
            class="rounded-lg bg-cyan-400 px-4 py-2 text-sm font-semibold text-slate-950"
          >
            Create share link
          </button>
        </section>
        <Phase5MaintenancePanel
          workspace-id="11111111-1111-4111-8111-111111111111"
          :client="maintenanceClient"
          :poll-interval-ms="1000"
          :max-poll-attempts="1"
        />
      </section>
    </main>
  </div>
</template>

<script setup lang="ts">
import { computed } from "vue";
import Phase5MaintenancePanel from "../components/admin/Phase5MaintenancePanel.vue";
import type { Phase5MaintenanceClient } from "../api/Phase5Client.js";

const scene = computed(() => new URLSearchParams(window.location.search).get("scene"));
const title = computed(() =>
  scene.value === "semantic" ? "Semantic blocks" : "Sharing and maintenance",
);
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
  async startSearchRebuild(_input) {
    return { jobId: "77777777-7777-4777-8777-777777777777", duplicate: false };
  },
  async runAssetCleanup(_input) {
    return { jobId: "88888888-8888-4888-8888-888888888888", duplicate: false };
  },
  async replayDeadLetter(_deadLetterId) {
    return { jobId: "99999999-9999-4999-8999-999999999999", duplicate: false };
  },
};
</script>
