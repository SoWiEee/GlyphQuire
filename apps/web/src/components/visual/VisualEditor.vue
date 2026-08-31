<template>
  <div
    ref="hostRef"
    class="gq-editor-surface gq-visual-editor"
    :data-read-only="readOnly ? 'true' : 'false'"
    data-testid="visual-editor-host"
  />
</template>

<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from "vue";

import { MilkdownVisualAdapter } from "../../editors/visual/MilkdownVisualAdapter.js";
import type { EditorAdapter } from "../../editors/types.js";
import type { ToolbarAction } from "../workbench/types.js";

const props = withDefaults(
  defineProps<{
    markdown: string;
    readOnly?: boolean;
    outlineActive?: boolean;
  }>(),
  { readOnly: true, outlineActive: true },
);

const emit = defineEmits<{
  "update:markdown": [markdown: string];
  "slash-command": [request: { query: string; slashRange: { from: number; to: number } }];
}>();

const hostRef = ref<HTMLElement | null>(null);
let adapter: EditorAdapter | undefined;
let concreteAdapter: MilkdownVisualAdapter | undefined;
let unsubscribe: (() => void) | undefined;
let unsubscribeSlash: (() => void) | undefined;
let generation = 0;

function outlineIds(markdown: string): string[] {
  const seen = new Map<string, number>();
  const ids: string[] = [];
  for (const line of markdown.split("\n")) {
    const match = /^(#{1,3})\s+(.+)$/u.exec(line);
    if (!match) continue;
    const label = match[2].trim();
    if (!label) continue;
    const base =
      label
        .normalize("NFKD")
        .replace(/[\u0300-\u036f]/gu, "")
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s-]/gu, "")
        .trim()
        .replace(/[\s-]+/gu, "-") || "heading";
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    ids.push(count === 0 ? base : `${base}-${count}`);
  }
  return ids;
}

function syncOutlineAnchors(markdown: string): void {
  const root = hostRef.value?.querySelector<HTMLElement>(".ProseMirror");
  if (!root) return;
  const headings = root.querySelectorAll<HTMLElement>("h1, h2, h3");
  headings.forEach((heading) => heading.removeAttribute("data-editor-outline-id"));
  if (!props.outlineActive) return;
  const ids = outlineIds(markdown);
  headings.forEach((heading, index) => {
    const id = ids[index];
    if (id) heading.setAttribute("data-editor-outline-id", id);
  });
}

function failClosed(instance: MilkdownVisualAdapter): void {
  try {
    instance.setReadOnly(true);
  } finally {
    unsubscribe?.();
    unsubscribe = undefined;
    unsubscribeSlash?.();
    unsubscribeSlash = undefined;
    instance.destroy();
    if (adapter === instance) adapter = undefined;
    if (concreteAdapter === instance) concreteAdapter = undefined;
  }
}

function project(instance: MilkdownVisualAdapter): void {
  try {
    instance.setReadOnly(true);
    instance.setMarkdown(props.markdown);
    if (!props.readOnly) instance.setReadOnly(false);
  } catch {
    failClosed(instance);
  }
}

onMounted(() => {
  const host = hostRef.value;
  if (!host) return;

  const instance = new MilkdownVisualAdapter();
  const mountGeneration = ++generation;
  instance.mount(host);
  instance.setReadOnly(true);
  adapter = instance;
  concreteAdapter = instance;
  unsubscribe = instance.onChange((markdown) => emit("update:markdown", markdown));
  unsubscribeSlash = instance.onSlashCommand((request) => emit("slash-command", request));

  try {
    instance.setMarkdown(props.markdown);
    syncOutlineAnchors(props.markdown);
  } catch {
    failClosed(instance);
    return;
  }

  void instance.whenReady().then(
    () => {
      if (mountGeneration !== generation || concreteAdapter !== instance) return;
      project(instance);
      syncOutlineAnchors(props.markdown);
    },
    () => {
      if (mountGeneration === generation && concreteAdapter === instance) {
        failClosed(instance);
      }
    },
  );
});

watch([() => props.markdown, () => props.readOnly, () => props.outlineActive], () => {
  const instance = concreteAdapter;
  if (instance) {
    project(instance);
    syncOutlineAnchors(props.markdown);
  }
});

onBeforeUnmount(() => {
  generation += 1;
  unsubscribe?.();
  unsubscribeSlash?.();
  adapter?.destroy();
  adapter = undefined;
  concreteAdapter = undefined;
  unsubscribe = undefined;
});

defineExpose({
  focus: () => adapter?.focus(),
  applyToolbarAction: (action: ToolbarAction) => {
    const instance = concreteAdapter;
    if (!instance || props.readOnly) return false;
    return instance.applyVisualToolbarAction(action);
  },
  replaceRange: (from: number, to: number, insert: string, cursorOffset = insert.length) => {
    const instance = concreteAdapter;
    if (!instance || props.readOnly) return false;
    return instance.replaceRange(from, to, insert, cursorOffset);
  },
});
</script>
