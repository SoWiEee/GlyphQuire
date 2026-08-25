<template>
  <div class="flex items-center gap-2 border-t border-gray-200 pt-3">
    <button
      type="button"
      class="rounded-md bg-gray-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-gray-800 disabled:opacity-50"
      :disabled="!hasChanges"
      @click="emit('save')"
    >
      Save
    </button>
    <button
      type="button"
      class="rounded-md border border-gray-300 px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
      :disabled="!hasChanges"
      @click="emit('reset')"
    >
      Reset
    </button>
    <div class="flex-1" />
    <label class="flex items-center gap-1.5 text-xs text-gray-600">
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
