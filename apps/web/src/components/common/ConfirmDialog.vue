<template>
  <div
    class="fixed inset-0 z-50 flex items-center justify-center bg-black/30 motion-safe:transition-opacity motion-safe:duration-150"
    @keydown.escape="emit('cancel')"
    @click.self="emit('cancel')"
  >
    <div
      ref="dialogRef"
      role="alertdialog"
      aria-modal="true"
      :aria-labelledby="titleId"
      :aria-describedby="descriptionId"
      class="w-full max-w-sm rounded-lg bg-surface p-4 shadow-xl"
    >
      <h2 :id="titleId" class="text-sm font-semibold text-foreground">{{ title }}</h2>
      <p :id="descriptionId" class="mt-2 text-sm text-muted">
        <slot>{{ description }}</slot>
      </p>
      <div class="mt-4 flex justify-end gap-2">
        <button
          type="button"
          class="rounded-md border border-border px-3 py-1.5 text-xs font-medium text-foreground hover:bg-surface-muted"
          @click="emit('cancel')"
        >
          {{ cancelLabel }}
        </button>
        <button
          ref="confirmRef"
          type="button"
          class="rounded-md px-3 py-1.5 text-xs font-medium text-accent-contrast"
          :class="destructive ? 'bg-danger hover:opacity-90' : 'bg-accent hover:opacity-90'"
          @click="emit('confirm')"
        >
          {{ confirmLabel }}
        </button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from "vue";
import { trapFocus } from "../../lib/focusTrap.js";
import type { FocusTrapHandle } from "../../lib/focusTrap.js";

withDefaults(
  defineProps<{
    title: string;
    description?: string;
    confirmLabel?: string;
    cancelLabel?: string;
    destructive?: boolean;
  }>(),
  {
    description: "",
    confirmLabel: "Confirm",
    cancelLabel: "Cancel",
    destructive: false,
  },
);

const emit = defineEmits<{
  confirm: [];
  cancel: [];
}>();

const dialogRef = ref<HTMLElement | null>(null);
const confirmRef = ref<HTMLButtonElement | null>(null);
const titleId = `confirm-dialog-title-${Math.random().toString(36).slice(2)}`;
const descriptionId = `confirm-dialog-description-${Math.random().toString(36).slice(2)}`;
let trap: FocusTrapHandle | undefined;

onMounted(() => {
  if (dialogRef.value) trap = trapFocus(dialogRef.value, confirmRef.value);
});

onBeforeUnmount(() => {
  trap?.release();
});
</script>
