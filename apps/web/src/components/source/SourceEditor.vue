<template>
  <div ref="hostRef" class="h-full w-full overflow-auto text-sm" data-testid="source-editor-host" />
</template>

<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from "vue";
import { CodeMirrorSourceAdapter } from "../../editors/source/CodeMirrorSourceAdapter.js";
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

// The workbench, and every ancestor of this component, only ever sees the
// EditorAdapter seam. CodeMirrorSourceAdapter is instantiated once, here,
// and never imported anywhere else in the shell.
let adapter: EditorAdapter | undefined;
let unsubscribe: (() => void) | undefined;
let unsubscribeSlash: (() => void) | undefined;
let projectedReadOnly = false;

interface HeadingAnchor {
  readonly line: number;
  readonly id: string;
}

function headingAnchors(markdown: string): HeadingAnchor[] {
  const seen = new Map<string, number>();
  const anchors: HeadingAnchor[] = [];
  markdown.split("\n").forEach((line, index) => {
    const match = /^(#{1,3})\s+(.+)$/u.exec(line);
    if (!match) return;
    const label = match[2].trim();
    if (!label) return;
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
    anchors.push({ line: index, id: count === 0 ? base : `${base}-${count}` });
  });
  return anchors;
}

function syncOutlineAnchors(markdown: string): void {
  const lines = hostRef.value?.querySelectorAll<HTMLElement>(".cm-line");
  if (!lines) return;
  for (const line of lines) line.removeAttribute("data-editor-outline-id");
  if (!props.outlineActive) return;
  for (const anchor of headingAnchors(markdown)) {
    lines[anchor.line]?.setAttribute("data-editor-outline-id", anchor.id);
  }
}

function failClosed(instance: EditorAdapter): void {
  try {
    instance.setReadOnly(true);
    projectedReadOnly = true;
  } catch {
    unsubscribe?.();
    unsubscribe = undefined;
    unsubscribeSlash?.();
    unsubscribeSlash = undefined;
    instance.destroy();
    if (adapter === instance) adapter = undefined;
  }
}

/** Locks first, projects canonical Markdown, verifies it, then grants writes. */
function projectEditorState(instance: EditorAdapter, markdown: string, readOnly: boolean): void {
  try {
    if (projectedReadOnly === readOnly && instance.getMarkdown() === markdown) return;
    instance.setReadOnly(true);
    projectedReadOnly = true;
    if (instance.getMarkdown() !== markdown) instance.setMarkdown(markdown);
    if (instance.getMarkdown() !== markdown) throw new Error("Editor projection failed");
    syncOutlineAnchors(markdown);
    if (!readOnly) {
      instance.setReadOnly(false);
      projectedReadOnly = false;
    }
  } catch {
    failClosed(instance);
  }
}

onMounted(() => {
  if (!hostRef.value) return;

  const instance = new CodeMirrorSourceAdapter();
  instance.mount(hostRef.value);
  adapter = instance;
  projectEditorState(instance, props.markdown, props.readOnly);
  if (adapter === instance) {
    unsubscribe = instance.onChange((markdown) => emit("update:markdown", markdown));
    unsubscribeSlash = instance.onSlashCommand((request) => emit("slash-command", request));
    syncOutlineAnchors(props.markdown);
  }
});

watch(
  [() => props.markdown, () => props.readOnly, () => props.outlineActive],
  ([markdown, readOnly]) => {
    const instance = adapter;
    if (instance) {
      projectEditorState(instance, markdown, readOnly);
      syncOutlineAnchors(markdown);
    }
  },
);

onBeforeUnmount(() => {
  unsubscribe?.();
  unsubscribeSlash?.();
  adapter?.destroy();
  adapter = undefined;
  projectedReadOnly = false;
});

defineExpose({
  focus: () => adapter?.focus(),
  applyToolbarAction: (action: ToolbarAction) => {
    const instance = adapter;
    if (!instance || projectedReadOnly) return false;
    const toolbarAdapter = instance as EditorAdapter & {
      applyToolbarAction?: (toolbarAction: ToolbarAction) => boolean;
    };
    return toolbarAdapter.applyToolbarAction?.(action) ?? false;
  },
  replaceRange: (from: number, to: number, insert: string, cursorOffset = insert.length) => {
    const instance = adapter;
    if (!instance || projectedReadOnly || !instance.replaceRange) return false;
    instance.replaceRange(from, to, insert);
    instance.setSelection?.({
      anchor: Math.min(from, to) + cursorOffset,
      head: Math.min(from, to) + cursorOffset,
    });
    return true;
  },
});
</script>
