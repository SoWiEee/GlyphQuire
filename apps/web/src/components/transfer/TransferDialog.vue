<template>
  <section aria-label="Import and export" class="space-y-4 rounded border border-border p-4">
    <header class="flex items-center justify-between">
      <h2 class="text-sm font-semibold text-foreground">Import and export</h2>
      <button
        v-if="closable"
        type="button"
        aria-label="Close transfer dialog"
        @click="emit('close')"
      >
        Close
      </button>
    </header>

    <form class="space-y-2" @submit.prevent="startImport">
      <label class="block text-sm text-foreground">
        Import Markdown or ZIP
        <input
          type="file"
          accept=".md,.markdown,.zip,text/markdown,application/zip"
          aria-label="Import Markdown or ZIP"
          class="mt-1 block w-full text-sm"
          @change="selectImport"
        />
      </label>
      <button
        type="button"
        aria-label="Start import"
        :disabled="!importFile || store.busy"
        class="rounded bg-accent px-3 py-2 text-sm text-accent-contrast disabled:opacity-50"
        @click="startImport"
      >
        Start import
      </button>
    </form>

    <form class="space-y-2" @submit.prevent="startExport">
      <label class="block text-sm text-foreground">
        Export format
        <select
          v-model="format"
          aria-label="Export format"
          class="mt-1 block rounded border border-border px-2 py-1 text-sm"
        >
          <option value="markdown">Markdown</option>
          <option value="zip">ZIP</option>
          <option value="html">HTML</option>
        </select>
      </label>
      <button
        type="button"
        aria-label="Export workspace"
        :disabled="store.busy"
        class="rounded bg-accent px-3 py-2 text-sm text-accent-contrast disabled:opacity-50"
        @click="startExport"
      >
        Export workspace
      </button>
    </form>

    <div class="space-y-2" aria-label="Additional export formats">
      <p class="text-sm text-foreground">Additional formats</p>
      <div class="flex flex-wrap gap-2">
        <button
          type="button"
          aria-label="Export workspace as plain text"
          :disabled="store.busy"
          class="rounded border border-border px-3 py-2 text-sm disabled:opacity-50"
          @click="startAdditionalExport('plain-text')"
        >
          Export plain text
        </button>
        <button
          type="button"
          aria-label="Export workspace as AST JSON"
          :disabled="store.busy"
          class="rounded border border-border px-3 py-2 text-sm disabled:opacity-50"
          @click="startAdditionalExport('ast-json')"
        >
          Export AST JSON
        </button>
      </div>
    </div>

    <div aria-live="polite" class="space-y-1 text-sm text-foreground">
      <p v-for="entry in importEntries" :key="entry.id">
        {{ importStatusLabel(entry.status) }}
        <span v-if="entry.progress.totalItems > 0">
          ({{ entry.progress.completedItems }}/{{ entry.progress.totalItems }})
        </span>
      </p>
      <p v-for="entry in exportEntries" :key="entry.id">
        {{ exportStatusLabel(entry.format, entry.status) }}
        <button
          v-if="entry.status === 'completed' && !entry.downloadUrl"
          type="button"
          class="ml-2 underline"
          :aria-label="`Prepare ${entry.format} download`"
          @click="prepareDownload(entry.id)"
        >
          Prepare download
        </button>
        <a
          v-if="entry.status === 'completed' && entry.downloadUrl"
          :href="entry.downloadUrl"
          target="_blank"
          rel="noopener noreferrer"
          referrerpolicy="no-referrer"
          class="ml-2 underline"
        >
          Download export
        </a>
      </p>
      <button v-if="store.pollingPaused" type="button" class="underline" @click="retryPolling">
        Retry status checks
      </button>
    </div>

    <p v-if="store.error" role="alert" class="text-sm text-danger">{{ store.error }}</p>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import type { ExportFormat, ExportResult, ImportJobResult } from "@glyphquire/api-contract";
import { useWorkspaceToolsStore } from "../../stores/workspace-tools.js";

const MAX_IMPORT_BYTES = 25 * 1024 * 1024;
const ACCEPTED_IMPORT_TYPES = new Set(["text/markdown", "application/zip"]);

const props = withDefaults(
  defineProps<{
    workspaceId: string;
    noteId?: string;
    baseRevision?: number;
    closable?: boolean;
  }>(),
  { noteId: undefined, baseRevision: undefined, closable: false },
);

const emit = defineEmits<{ close: [] }>();
const store = useWorkspaceToolsStore();
const importFile = ref<File | null>(null);
const format = ref<ExportFormat>("markdown");
const importEntries = computed(() => Object.values(store.imports));
const exportEntries = computed(() => Object.values(store.exports));

function formatLabel(value: ExportFormat): string {
  switch (value) {
    case "markdown":
      return "Markdown";
    case "zip":
      return "ZIP";
    case "html":
      return "HTML";
    case "plain-text":
      return "plain text";
    case "ast-json":
      return "AST JSON";
  }
}

function importStatusLabel(statusValue: ImportJobResult["status"]): string {
  switch (statusValue) {
    case "pending":
      return "Import queued";
    case "processing":
      return "Import in progress";
    case "completed":
      return "Import complete";
    case "failed":
      return "Import failed";
    case "expired":
      return "Import expired";
  }
}

function exportStatusLabel(formatValue: ExportFormat, statusValue: ExportResult["status"]): string {
  const formatText = formatLabel(formatValue);
  switch (statusValue) {
    case "pending":
      return `${formatText} export queued`;
    case "processing":
      return `${formatText} export in progress`;
    case "completed":
      return `${formatText} export ready`;
    case "failed":
      return `${formatText} export failed`;
    case "expired":
      return `${formatText} export expired`;
  }
}

function selectImport(event: Event): void {
  const selected = (event.target as HTMLInputElement).files?.[0] ?? null;
  if (
    !selected ||
    selected.size < 1 ||
    selected.size > MAX_IMPORT_BYTES ||
    !ACCEPTED_IMPORT_TYPES.has(selected.type)
  ) {
    importFile.value = null;
    return;
  }
  importFile.value = selected;
}

async function startImport(): Promise<void> {
  const file = importFile.value;
  if (!file) return;
  try {
    await store.startImport({
      workspaceId: props.workspaceId,
      file,
      ...(props.noteId !== undefined && props.baseRevision !== undefined
        ? { noteId: props.noteId, baseRevision: props.baseRevision }
        : {}),
    });
    importFile.value = null;
  } catch {
    // The store exposes only the stable public projection in its alert.
  }
}

async function startExport(): Promise<void> {
  await startExportWithFormat(format.value);
}

async function startAdditionalExport(
  selectedFormat: Extract<ExportFormat, "plain-text" | "ast-json">,
): Promise<void> {
  await startExportWithFormat(selectedFormat);
}

async function startExportWithFormat(selectedFormat: ExportFormat): Promise<void> {
  try {
    await store.startExport({
      scope: { type: "workspace", workspaceId: props.workspaceId },
      format: selectedFormat,
    });
  } catch {
    // The store exposes only the stable public projection in its alert.
  }
}

async function prepareDownload(exportId: string): Promise<void> {
  try {
    await store.getExportDownload(exportId);
  } catch {
    // The store exposes only the stable public projection in its alert.
  }
}

async function retryPolling(): Promise<void> {
  try {
    await store.retryPolling();
  } catch {
    // The store exposes only the stable public projection in its alert.
  }
}

onMounted(() => {
  void store.resumePending().catch(() => undefined);
});
</script>
