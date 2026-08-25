<template>
  <fieldset class="space-y-2">
    <legend class="text-xs font-semibold uppercase tracking-wide text-gray-500">Colors</legend>
    <div v-for="key in colorKeys" :key="key" class="flex items-center gap-2">
      <label :for="`color-${key}`" class="w-24 text-xs text-gray-600">{{ key }}</label>
      <input
        :id="`color-${key}`"
        type="color"
        :value="colors[key]"
        class="h-6 w-8 cursor-pointer rounded border border-gray-300"
        @input="emit('update:color', key, ($event.target as HTMLInputElement).value)"
      />
      <input
        type="text"
        :value="colors[key]"
        class="w-20 rounded border border-gray-300 px-1.5 py-0.5 text-xs"
        @change="emit('update:color', key, ($event.target as HTMLInputElement).value)"
      />
    </div>
  </fieldset>
</template>

<script setup lang="ts">
import type { ThemeTokens } from "@glyphquire/theme-engine";

defineProps<{
  colors: ThemeTokens["color"];
}>();

const emit = defineEmits<{
  "update:color": [key: keyof ThemeTokens["color"], value: string];
}>();

const colorKeys: (keyof ThemeTokens["color"])[] = ["background", "foreground", "muted", "accent", "border"];
</script>
