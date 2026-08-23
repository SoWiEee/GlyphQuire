<template>
  <footer
    class="flex items-center justify-between border-t border-gray-200 bg-gray-900 px-4 py-1 text-xs text-gray-200"
    role="status"
    aria-live="polite"
  >
    <span aria-label="Active note">
      {{ noteTitle ?? "No note open" }}
    </span>
    <div class="flex items-center gap-4">
      <span aria-label="Editor mode">{{ mode === "source" ? "Source" : "Visual" }}</span>
      <span aria-label="Word count">{{ wordCount }} words</span>
    </div>
  </footer>
</template>

<script setup lang="ts">
import type { WorkbenchEditorMode } from "./types.js";

defineProps<{
  noteTitle: string | null;
  mode: WorkbenchEditorMode;
  wordCount: number;
}>();
</script>
