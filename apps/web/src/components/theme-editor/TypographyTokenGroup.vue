<template>
  <fieldset class="space-y-2">
    <legend class="text-xs font-semibold uppercase tracking-wide text-gray-500">Typography</legend>
    <div v-for="key in typographyKeys" :key="key" class="flex items-center gap-2">
      <label :for="`typo-${key}`" class="w-24 text-xs text-gray-600">{{ key }}</label>
      <select
        :id="`typo-${key}`"
        :value="typography[key]"
        class="flex-1 rounded border border-gray-300 px-1.5 py-0.5 text-xs"
        @change="emit('update:typography', key, ($event.target as HTMLSelectElement).value)"
      >
        <option v-for="font in fontOptions" :key="font" :value="font">{{ font }}</option>
      </select>
    </div>
  </fieldset>
</template>

<script setup lang="ts">
import type { ThemeTokens } from "@glyphquire/theme-engine";

defineProps<{
  typography: ThemeTokens["typography"];
}>();

const emit = defineEmits<{
  "update:typography": [key: keyof ThemeTokens["typography"], value: string];
}>();

const typographyKeys: (keyof ThemeTokens["typography"])[] = ["bodyFont", "headingFont", "monoFont"];

const fontOptions = [
  "'Inter', 'Noto Sans TC', system-ui, sans-serif",
  "'Georgia', 'Noto Serif TC', serif",
  "'JetBrains Mono', 'Fira Code', ui-monospace, monospace",
  "system-ui, sans-serif",
];
</script>
