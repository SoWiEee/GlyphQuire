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
  </nav>
</template>

<script setup lang="ts">
import type { ToolbarAction } from "./types.js";

defineProps<{ disabled: boolean }>();

const emit = defineEmits<{
  action: [action: ToolbarAction];
}>();

const actions: ReadonlyArray<{ id: ToolbarAction; label: string; shortLabel: string }> = [
  { id: "bold", label: "Bold", shortLabel: "B" },
  { id: "italic", label: "Italic", shortLabel: "I" },
  { id: "heading", label: "Heading", shortLabel: "H" },
  { id: "bulletList", label: "Bullet list", shortLabel: "List" },
  { id: "link", label: "Link", shortLabel: "Link" },
];
</script>
