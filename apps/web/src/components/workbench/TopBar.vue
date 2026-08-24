<template>
  <header class="flex items-center justify-between border-b border-gray-200 bg-white px-4 py-2">
    <div class="flex items-center gap-3">
      <span class="text-sm font-semibold text-gray-900">GlyphQuire</span>
      <span class="text-sm text-gray-400" aria-hidden="true">/</span>
      <span class="text-sm text-gray-600">{{ noteTitle ?? "No note open" }}</span>
    </div>

    <div class="flex items-center gap-2">
      <div
        class="flex items-center rounded-md border border-gray-300 p-0.5"
        role="radiogroup"
        aria-label="Editor mode"
      >
        <button
          type="button"
          role="radio"
          :aria-checked="mode === 'source'"
          class="rounded px-2 py-1 text-xs font-medium"
          :class="mode === 'source' ? 'bg-gray-900 text-white' : 'text-gray-600 hover:bg-gray-100'"
          @click="emit('update:mode', 'source')"
        >
          Source
        </button>
        <button
          type="button"
          role="radio"
          :aria-checked="mode === 'visual'"
          class="rounded px-2 py-1 text-xs font-medium"
          :class="mode === 'visual' ? 'bg-gray-900 text-white' : 'text-gray-600 hover:bg-gray-100'"
          @click="emit('update:mode', 'visual')"
        >
          Visual
        </button>
      </div>

      <button
        type="button"
        class="rounded-md border border-gray-300 px-3 py-1 text-xs font-medium text-gray-700 hover:bg-gray-50"
        aria-label="Open command palette"
        @click="emit('open-palette')"
      >
        Commands
        <kbd class="ml-1 rounded bg-gray-100 px-1 text-[10px] text-gray-500">⌘K</kbd>
      </button>
    </div>
  </header>
</template>

<script setup lang="ts">
import type { WorkbenchEditorMode } from "./types.js";

defineProps<{
  noteTitle: string | null;
  mode: WorkbenchEditorMode;
}>();

const emit = defineEmits<{
  "update:mode": [mode: WorkbenchEditorMode];
  "open-palette": [];
}>();
</script>
