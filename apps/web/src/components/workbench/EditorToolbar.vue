<template>
  <nav
    class="gq-editor-toolbar flex items-center gap-1 border-b border-gray-200 px-3 py-1.5"
    aria-label="Editor toolbar"
  >
    <button
      v-for="action in actions"
      :key="action.id"
      type="button"
      class="rounded border border-transparent px-2 py-1 text-xs font-medium text-gray-700 hover:border-gray-300 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50"
      :aria-label="action.label"
      :disabled="disabled"
      :title="action.label"
      @click="emit('action', action.id)"
    >
      {{ action.shortLabel }}
    </button>
    <span class="ml-auto text-[10px] uppercase tracking-wide text-gray-400" aria-hidden="true">
      {{ mode }}
    </span>
    <button
      type="button"
      class="rounded border border-gray-300 px-2 py-1 text-xs font-medium text-gray-700 hover:bg-gray-50"
      aria-label="Open command palette"
      title="Open command palette"
      @click="emit('openPalette')"
    >
      Commands <kbd class="ml-1 rounded bg-gray-100 px-1 text-[10px] text-gray-600">⌘K</kbd>
    </button>
  </nav>
</template>

<script setup lang="ts">
import type { WorkbenchEditorMode, ToolbarAction } from "./types.js";

defineProps<{
  disabled: boolean;
  mode: WorkbenchEditorMode;
}>();

const emit = defineEmits<{
  action: [action: ToolbarAction];
  openPalette: [];
}>();

const actions: ReadonlyArray<{ id: ToolbarAction; label: string; shortLabel: string }> = [
  { id: "bold", label: "Bold", shortLabel: "B" },
  { id: "italic", label: "Italic", shortLabel: "I" },
  { id: "heading", label: "Heading", shortLabel: "H" },
  { id: "bulletList", label: "Bullet list", shortLabel: "List" },
  { id: "link", label: "Link", shortLabel: "Link" },
];
</script>
