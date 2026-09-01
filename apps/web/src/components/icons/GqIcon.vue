<script setup lang="ts">
import {
  Bold,
  Check,
  ChevronDown,
  ChevronsRight,
  CircleAlert,
  Columns3,
  Download,
  FileText,
  Heading2,
  Info,
  Italic,
  LayoutPanelTop,
  Lightbulb,
  Link2,
  List,
  LoaderCircle,
  Palette,
  Play,
  RotateCcw,
  Search,
  Settings,
  Square,
  StickyNote,
  Upload,
  X,
} from "@lucide/vue";
import type { Component } from "vue";
import type { IconName } from "@glyphquire/theme-sdk";

const props = withDefaults(
  defineProps<{
    name: IconName;
    size?: "sm" | "md" | "lg";
    strokeWidth?: number;
    decorative?: boolean;
    label?: string;
  }>(),
  {
    size: "md",
    strokeWidth: 1.75,
    decorative: true,
  },
);

const iconComponents: Record<IconName, Component> = {
  x: X,
  check: Check,
  "loader-circle": LoaderCircle,
  "circle-alert": CircleAlert,
  info: Info,
  lightbulb: Lightbulb,
  "sticky-note": StickyNote,
  "chevron-down": ChevronDown,
  "chevrons-right": ChevronsRight,
  "columns-3": Columns3,
  "layout-panel-top": LayoutPanelTop,
  search: Search,
  upload: Upload,
  download: Download,
  "link-2": Link2,
  settings: Settings,
  palette: Palette,
  play: Play,
  square: Square,
  "rotate-ccw": RotateCcw,
  bold: Bold,
  italic: Italic,
  "heading-2": Heading2,
  list: List,
  "file-text": FileText,
};

const accessibleLabel = props.label?.trim();
if (!props.decorative && !accessibleLabel) {
  throw new Error("GqIcon requires a non-empty label when decorative is false");
}
</script>

<template>
  <component
    :is="iconComponents[props.name]"
    class="gq-icon"
    :class="`gq-icon--${props.size}`"
    :size="props.size === 'sm' ? 14 : props.size === 'lg' ? 20 : 16"
    :stroke-width="props.strokeWidth"
    stroke="currentColor"
    :aria-hidden="props.decorative ? 'true' : undefined"
    :aria-label="props.decorative ? undefined : accessibleLabel"
    aria-live="off"
  />
</template>
