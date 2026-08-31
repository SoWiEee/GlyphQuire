<template>
  <footer
    class="gq-statusbar flex items-center justify-between border-t px-4 py-1 text-xs"
    role="status"
    aria-live="polite"
  >
    <span class="gq-statusbar__note" aria-label="Active note">
      {{ noteTitle ?? "No note open" }}
    </span>
    <div class="gq-statusbar__details flex items-center gap-4">
      <StatusIndicator
        class="gq-statusbar__indicator"
        :state="saveState"
        :detail="saveDetail"
        compact
      />
      <span class="gq-statusbar__mode" aria-label="Editor mode">{{ modeLabel }}</span>
      <span class="gq-statusbar__word-count" aria-label="Word count">{{ wordCount }} words</span>
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
