<template>
  <fieldset class="space-y-2">
    <legend class="text-xs font-semibold uppercase tracking-wide text-gray-500">Radius</legend>
    <div v-for="key in radiusKeys" :key="key" class="flex items-center gap-2">
      <label :for="`radius-${key}`" class="w-24 text-xs text-gray-600">{{ key }}</label>
      <input
        :id="`radius-${key}`"
        type="range"
        min="0"
        max="2"
        step="0.125"
        :value="parseFloat(radius[key])"
        :aria-valuemin="0"
        :aria-valuemax="2"
        :aria-valuenow="parseFloat(radius[key])"
        class="flex-1"
        @input="emit('update:radius', key, ($event.target as HTMLInputElement).value + 'rem')"
      />
      <span class="w-14 text-right text-xs text-gray-500">{{ radius[key] }}</span>
    </div>
  </fieldset>
</template>

<script setup lang="ts">
import type { ThemeTokens } from "@glyphquire/theme-engine";

defineProps<{
  radius: ThemeTokens["radius"];
}>();

const emit = defineEmits<{
  "update:radius": [key: keyof ThemeTokens["radius"], value: string];
}>();

const radiusKeys: (keyof ThemeTokens["radius"])[] = ["sm", "md", "lg"];
</script>
