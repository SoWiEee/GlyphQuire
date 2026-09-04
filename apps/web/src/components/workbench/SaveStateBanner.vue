<template>
  <section
    class="flex items-center justify-between gap-3 border-b border-border bg-surface-muted px-4 py-2 text-sm text-foreground"
    :data-save-state="state"
    :role="isAlert ? 'alert' : undefined"
  >
    <div class="flex min-w-0 items-start gap-3">
      <StatusIndicator :state="state" compact />
      <p class="min-w-0">{{ message }}</p>
    </div>
    <div v-if="showRetry || showConflictRecovery" class="flex shrink-0 gap-2">
      <button
        v-if="showRetry"
        type="button"
        class="rounded border border-border px-2 py-1 text-xs font-medium text-foreground hover:bg-surface"
        aria-label="Retry save"
        @click="emit('retry')"
      >
        Retry save
      </button>
      <button
        v-if="showConflictRecovery"
        type="button"
        class="rounded border border-border px-2 py-1 text-xs font-medium text-foreground hover:bg-surface"
        aria-label="Open conflict recovery"
        @click="emit('openConflict')"
      >
        Review conflict
      </button>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed } from "vue";
import StatusIndicator from "./StatusIndicator.vue";
import type { WorkbenchSaveState } from "./types.js";

const props = defineProps<{
  state: WorkbenchSaveState;
  message: string;
  canRetry: boolean;
  canOpenConflict: boolean;
}>();

const emit = defineEmits<{
  retry: [];
  openConflict: [];
}>();

const isAlert = computed(() =>
  ["conflict", "offline", "error", "unavailable"].includes(props.state),
);
const showRetry = computed(
  () => props.canRetry && (props.state === "offline" || props.state === "error"),
);
const showConflictRecovery = computed(() => props.canOpenConflict && props.state === "conflict");
</script>
