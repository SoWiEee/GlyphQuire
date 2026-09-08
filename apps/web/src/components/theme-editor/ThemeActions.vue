<template>
  <div class="flex items-center gap-2 border-t border-border pt-3">
    <button
      type="button"
      class="rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-accent-contrast hover:opacity-90 disabled:opacity-50"
      :disabled="!hasChanges"
      @click="emit('save')"
    >
      Save
    </button>
    <button
      type="button"
      class="rounded-md border border-border px-3 py-1.5 text-xs font-medium text-foreground hover:bg-surface-muted disabled:opacity-50"
      :disabled="!hasChanges"
      @click="emit('reset')"
    >
      Reset
    </button>
    <div class="flex-1" />
    <label class="flex items-center gap-1.5 text-xs text-muted">
      <input type="checkbox" :checked="isDark" class="rounded" @change="emit('toggle-dark')" />
      Dark
    </label>
  </div>
</template>

<script setup lang="ts">
defineProps<{
  hasChanges: boolean;
  isDark: boolean;
}>();

const emit = defineEmits<{
  save: [];
  reset: [];
  "toggle-dark": [];
}>();
</script>
