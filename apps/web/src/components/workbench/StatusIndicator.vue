<template>
  <div
    class="flex items-center gap-1.5 text-xs"
    :class="{ 'gq-status-indicator--compact': compact }"
    :data-status="state"
    role="status"
    aria-live="polite"
  >
    <span :data-status-icon="state" aria-hidden="true">{{ statusCopy.icon }}</span>
    <span>{{ statusCopy.label }}</span>
    <span v-if="detail" class="opacity-80">{{ detail }}</span>
  </div>
</template>

<script setup lang="ts">
import { computed } from "vue";
import type { WorkbenchSaveState } from "./types.js";

const props = defineProps<{
  state: WorkbenchSaveState;
  detail?: string;
  compact?: boolean;
}>();

const STATUS_COPY: Record<WorkbenchSaveState, { label: string; icon: string }> = {
  saved: { label: "Saved", icon: "✓" },
  saving: { label: "Saving", icon: "↻" },
  dirty: { label: "Unsaved changes", icon: "•" },
  offline: { label: "Offline", icon: "⌁" },
  error: { label: "Save failed", icon: "×" },
  conflict: { label: "Conflict", icon: "!" },
  "read-only": { label: "Read-only", icon: "▣" },
  unavailable: { label: "Unavailable", icon: "×" },
};

const statusCopy = computed(() => STATUS_COPY[props.state]);
</script>

<style scoped>
.gq-status-indicator--compact {
  white-space: nowrap;
}
</style>
