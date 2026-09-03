<template>
  <div
    class="flex items-center gap-1.5 text-xs"
    :class="{ 'gq-status-indicator--compact': compact }"
    :data-status="state"
    role="status"
    aria-live="polite"
  >
    <span
      :key="iconRenderKey"
      :data-status-icon="state"
      :class="iconAnimationClass"
      aria-hidden="true"
    >
      <GqIcon :name="statusCopy.icon" size="sm" />
    </span>
    <span>{{ statusCopy.label }}</span>
    <span v-if="detail" class="opacity-80">{{ detail }}</span>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from "vue";
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

// Replays the "saved" pop-in once per transition into the saved state, without
// re-triggering on unrelated re-renders (e.g. `detail`/`compact` prop churn).
const savedPopSeq = ref(0);
watch(
  () => props.state,
  (next, previous) => {
    if (next === "saved" && previous !== "saved") {
      savedPopSeq.value += 1;
    }
  },
);

const iconRenderKey = computed(() =>
  props.state === "saved" ? `saved-${savedPopSeq.value}` : props.state,
);

const iconAnimationClass = computed(() => {
  if (props.state === "saving") return "gq-status-indicator__icon--spin";
  if (props.state === "saved" && savedPopSeq.value > 0) return "gq-status-indicator__icon--pop";
  return "";
});
</script>

<style scoped>
.gq-status-indicator--compact {
  white-space: nowrap;
}

.gq-status-indicator__icon--spin,
.gq-status-indicator__icon--pop {
  display: inline-flex;
}

.gq-status-indicator__icon--spin {
  animation: gq-status-indicator-spin 900ms linear infinite;
}

.gq-status-indicator__icon--pop {
  animation: gq-status-indicator-pop 320ms cubic-bezier(0.2, 0, 0, 1) both;
}

@keyframes gq-status-indicator-spin {
  to {
    transform: rotate(360deg);
  }
}

@keyframes gq-status-indicator-pop {
  0% {
    opacity: 0;
    transform: scale(0.6);
  }
  60% {
    opacity: 1;
    transform: scale(1.15);
  }
  100% {
    opacity: 1;
    transform: scale(1);
  }
}

@media (prefers-reduced-motion: reduce) {
  .gq-status-indicator__icon--spin,
  .gq-status-indicator__icon--pop {
    animation: none;
  }
}
</style>
