<template>
  <footer
    class="gq-statusbar flex items-center justify-between border-t px-4 py-1 text-xs"
    role="status"
    aria-live="polite"
  >
    <span class="gq-statusbar__note" aria-label="使用中的筆記">
      {{ noteTitle ?? "尚未開啟筆記" }}
    </span>
    <div class="gq-statusbar__details flex items-center gap-4">
      <StatusIndicator
        class="gq-statusbar__indicator"
        :state="saveState"
        :detail="saveDetail"
        compact
      />
      <span class="gq-statusbar__mode" aria-label="編輯模式">{{ modeLabel }}</span>
      <span class="gq-statusbar__word-count" aria-label="字數">{{ wordCount }} 字</span>
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
  source: "原始碼",
  visual: "視覺",
  split: "分割",
};

const modeLabel = computed(() => MODE_LABELS[props.mode]);
</script>
