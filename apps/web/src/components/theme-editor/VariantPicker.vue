<template>
  <fieldset class="space-y-2">
    <legend class="text-xs font-semibold uppercase tracking-wide text-gray-500">
      Component Variants
    </legend>
    <ComponentVariantRow
      v-for="entry in entries"
      :key="entry.name"
      :component-name="entry.name"
      :component-label="entry.label"
      :selected-variant="entry.selected"
      :options="entry.options"
      :option-labels="entry.optionLabels"
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

type VariantComponent = "callout" | "quote" | "code" | "toggle" | "tabs" | "stickyNote";

const componentLabels: Record<string, string> = {
  heading: "Headings",
  quote: "Quotes",
  callout: "Callouts",
  code: "Code blocks",
  toggle: "Toggles",
  tabs: "Tabs",
  stickyNote: "Sticky notes",
};

const variantOptions: Record<VariantComponent, string[]> = {
  callout: ["solid", "glass", "outline"],
  quote: ["plain", "sticky", "paper"],
  code: ["plain", "terminal"],
  toggle: ["plain", "card"],
  tabs: ["plain", "pill", "underline"],
  stickyNote: ["plain", "paper", "neon"],
};
const headingOptions = ["none", "sparkle", "line"];

const optionLabels: Record<string, string> = {
  none: "None",
  sparkle: "Dotted accent",
  line: "Bottom rule",
  solid: "Solid",
  glass: "Soft glass",
  outline: "Outline",
  plain: "Plain",
  sticky: "Sticky",
  paper: "Paper",
  terminal: "Terminal",
  card: "Card",
  pill: "Pill",
  underline: "Underline",
  neon: "Neon",
};

function isVariantComponent(name: string): name is VariantComponent {
  return Object.prototype.hasOwnProperty.call(variantOptions, name);
}

const entries = computed(() =>
  Object.entries(props.variants).flatMap(([name, config]) => {
    if (name === "heading") {
      const selected = (config as ThemeComponentVariants["heading"] | undefined)?.decoration;
      return [
        {
          name,
          label: componentLabels[name] ?? name,
          selected: selected ?? headingOptions[0],
          options: headingOptions,
          optionLabels,
        },
      ];
    }
    if (!isVariantComponent(name) || !config || !("variant" in config)) return [];
    const selected = (config as { variant?: string }).variant;
    return [
      {
        name,
        label: componentLabels[name] ?? name,
        selected: selected ?? variantOptions[name][0],
        options: variantOptions[name],
        optionLabels,
      },
    ];
  }),
);
</script>
