<template>
  <div class="space-y-1">
    <label for="theme-select" class="text-xs font-semibold uppercase tracking-wide text-gray-500"
      >Theme</label
    >
    <select
      id="theme-select"
      :value="selectedThemeId"
      class="w-full rounded border border-gray-300 px-2 py-1 text-sm"
      @change="emit('select', ($event.target as HTMLSelectElement).value)"
    >
      <option v-for="theme in themes" :key="theme.id" :value="theme.id">{{ theme.name }}</option>
    </select>
  </div>
</template>

<script setup lang="ts">
import type { ThemeResult } from "@glyphquire/api-contract";

defineProps<{
  themes: ThemeResult[];
  selectedThemeId: string;
}>();

const emit = defineEmits<{
  select: [themeId: string];
}>();
</script>
