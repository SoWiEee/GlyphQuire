<template>
  <div class="space-y-4">
    <details open>
      <summary class="cursor-pointer text-xs font-semibold text-gray-700">Colors</summary>
      <div class="mt-2">
        <ColorTokenGroup :colors="colors" @update:color="(k, v) => emit('update:color', k, v)" />
      </div>
    </details>
    <details>
      <summary class="cursor-pointer text-xs font-semibold text-gray-700">Typography</summary>
      <div class="mt-2">
        <TypographyTokenGroup :typography="typography" @update:typography="(k, v) => emit('update:typography', k, v)" />
      </div>
    </details>
    <details>
      <summary class="cursor-pointer text-xs font-semibold text-gray-700">Radius</summary>
      <div class="mt-2">
        <RadiusTokenGroup :radius="radius" @update:radius="(k, v) => emit('update:radius', k, v)" />
      </div>
    </details>
    <details>
      <summary class="cursor-pointer text-xs font-semibold text-gray-700">Spacing</summary>
      <div class="mt-2">
        <SpacingTokenGroup :spacing="spacing" @update:spacing="(k, v) => emit('update:spacing', k, v)" />
      </div>
    </details>
  </div>
</template>

<script setup lang="ts">
import type { ThemeTokens } from "@glyphquire/theme-engine";
import ColorTokenGroup from "./ColorTokenGroup.vue";
import TypographyTokenGroup from "./TypographyTokenGroup.vue";
import RadiusTokenGroup from "./RadiusTokenGroup.vue";
import SpacingTokenGroup from "./SpacingTokenGroup.vue";

defineProps<{
  colors: ThemeTokens["color"];
  typography: ThemeTokens["typography"];
  radius: ThemeTokens["radius"];
  spacing: ThemeTokens["spacing"];
}>();

const emit = defineEmits<{
  "update:color": [key: keyof ThemeTokens["color"], value: string];
  "update:typography": [key: keyof ThemeTokens["typography"], value: string];
  "update:radius": [key: keyof ThemeTokens["radius"], value: string];
  "update:spacing": [key: string, value: string];
}>();
</script>
