<template>
  <div
    class="fixed inset-0 z-50 flex items-center justify-center bg-black/30 motion-safe:transition-opacity motion-safe:duration-150"
    @keydown.escape="emit('cancel')"
    @click.self="emit('cancel')"
  >
    <div
      ref="dialogRef"
      role="dialog"
      aria-modal="true"
      aria-labelledby="checkpoint-dialog-title"
      class="w-full max-w-sm rounded-lg bg-surface p-4 shadow-xl"
    >
      <h2 id="checkpoint-dialog-title" class="text-sm font-semibold text-foreground">
        Create checkpoint
      </h2>
      <p class="mt-2 text-sm text-muted">
        Saves the note's current content (revision {{ baseRevision }}) as a named point in history
        you can preview or restore later.
      </p>
      <p v-if="error" role="alert" class="mt-2 text-xs text-danger">{{ error }}</p>
      <div class="mt-4 flex justify-end gap-2">
        <button
          type="button"
          class="rounded-md border border-border px-3 py-1.5 text-xs font-medium text-foreground hover:bg-surface-muted"
          :disabled="creating"
          @click="emit('cancel')"
        >
          Cancel
        </button>
        <button
          ref="confirmRef"
          type="button"
          class="rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-accent-contrast hover:opacity-90 disabled:opacity-50"
          :disabled="creating"
          @click="onConfirm"
        >
          {{ creating ? "Creating…" : "Create checkpoint" }}
        </button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from "vue";
import { trapFocus } from "../../lib/focusTrap.js";
import { useNoteVersionsStore } from "../../stores/noteVersions.js";
import type { FocusTrapHandle } from "../../lib/focusTrap.js";
import type { CheckpointNoteResult } from "@glyphquire/api-contract";

const props = defineProps<{
  noteId: string;
  baseRevision: number;
}>();

const emit = defineEmits<{
  created: [result: CheckpointNoteResult];
  cancel: [];
}>();

const store = useNoteVersionsStore();
const dialogRef = ref<HTMLElement | null>(null);
const confirmRef = ref<HTMLButtonElement | null>(null);
const creating = ref(false);
const error = ref<string | null>(null);
let trap: FocusTrapHandle | undefined;

onMounted(() => {
  if (dialogRef.value) trap = trapFocus(dialogRef.value, confirmRef.value);
});

onBeforeUnmount(() => {
  trap?.release();
});

async function onConfirm(): Promise<void> {
  creating.value = true;
  error.value = null;
  try {
    const result = await store.checkpoint(props.noteId, props.baseRevision);
    emit("created", result);
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : "Failed to create checkpoint";
  } finally {
    creating.value = false;
  }
}
</script>
