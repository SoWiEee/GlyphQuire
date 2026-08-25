<template>
  <fieldset class="space-y-2">
    <legend class="text-xs font-semibold uppercase tracking-wide text-gray-500">
      Component Variants
    </legend>
    <ComponentVariantRow
      v-for="entry in entries"
      :key="entry.name"
      :component-name="entry.name"
      :selected-variant="entry.selected"
      :options="entry.options"
      @update:variant="(v) => emit('update:variant', entry.name, v)"
    />
  </fieldset>
</template>

<script setup lang="ts">
import { computed } from "vue";
import type { ThemeComponentVariants } from "@glyphquire/theme-engine";
import ComponentVariantRow from "./ComponentVariantRow.vue";

const props = defineProps<{
  variants: ThemeComponentVariants;
}>();

const emit = defineEmits<{
  "update:variant": [component: string, variant: string];
}>();

const variantOptions: Record<string, string[]> = {
  callout: ["solid", "outline", "soft"],
  stickyNote: ["plain", "lined", "grid"],
  toggle: ["plain", "bordered"],
  tabs: ["plain", "bordered", "pills"],
  quote: ["plain", "bordered", "accent"],
  code: ["plain", "bordered"],
  columns: ["plain", "divided"],
  divider: ["solid", "dashed", "dotted"],
  image: ["plain", "rounded", "shadow"],
  heading: ["plain", "underlined"],
  paragraph: ["plain"],
  math: ["plain", "boxed"],
};

const entries = computed(() =>
  Object.entries(props.variants).map(([name, config]) => ({
    name,
    selected: (config as { variant?: string }).variant ?? "plain",
    options: variantOptions[name] ?? ["plain"],
  })),
);
</script>
