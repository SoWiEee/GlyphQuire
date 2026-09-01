<template>
  <div
    class="flex items-center gap-1.5 text-xs"
    :class="{ 'gq-status-indicator--compact': compact }"
    :data-status="state"
    role="status"
    aria-live="polite"
  >
    <span :data-status-icon="state" aria-hidden="true">
      <GqIcon :name="statusCopy.icon" size="sm" />
    </span>
    <span>{{ statusCopy.label }}</span>
    <span v-if="detail" class="opacity-80">{{ detail }}</span>
  </div>
</template>

<script setup lang="ts">
import { computed } from "vue";
import type { IconName } from "@glyphquire/theme-sdk";
import GqIcon from "../icons/GqIcon.vue";
import type { WorkbenchSaveState } from "./types.js";

const props = defineProps<{
  state: WorkbenchSaveState;
  detail?: string;
  compact?: boolean;
}>();

const STATUS_COPY: Record<WorkbenchSaveState, { label: string; icon: IconName }> = {
  saved: { label: "Saved", icon: "check" },
  saving: { label: "Saving", icon: "loader-circle" },
  dirty: { label: "Unsaved changes", icon: "circle-alert" },
  offline: { label: "Offline", icon: "info" },
  error: { label: "Save failed", icon: "circle-alert" },
  conflict: { label: "Conflict", icon: "circle-alert" },
  "read-only": { label: "Read-only", icon: "info" },
  unavailable: { label: "Unavailable", icon: "circle-alert" },
};

const statusCopy = computed(() => STATUS_COPY[props.state]);
</script>

<style scoped>
.gq-status-indicator--compact {
  white-space: nowrap;
}
</style>
