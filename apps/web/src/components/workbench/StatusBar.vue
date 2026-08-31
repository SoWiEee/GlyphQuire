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
      <StatusIndicator class="text-gray-100" :state="saveState" :detail="saveDetail" compact />
      <span aria-label="Editor mode">{{ modeLabel }}</span>
      <span aria-label="Word count">{{ wordCount }} words</span>
    </div>
  </footer>
</template>

<script setup lang="ts">
import { computed } from "vue";
import StatusIndicator from "./StatusIndicator.vue";
import type { WorkbenchEditorMode, WorkbenchSaveState } from "./types.js";

const props = defineProps<{
  noteTitle: string | null;
  mode: WorkbenchEditorMode;
  wordCount: number;
  saveState: WorkbenchSaveState;
  saveDetail?: string;
}>();

const MODE_LABELS: Record<WorkbenchEditorMode, string> = {
  source: "Source",
  visual: "Visual",
  split: "Split",
};

const modeLabel = computed(() => MODE_LABELS[props.mode]);
</script>
