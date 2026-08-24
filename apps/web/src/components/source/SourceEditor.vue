<template>
  <div ref="hostRef" class="h-full w-full overflow-auto text-sm" data-testid="source-editor-host" />
</template>

<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from "vue";
import { CodeMirrorSourceAdapter } from "../../editors/source/CodeMirrorSourceAdapter.js";
import type { EditorAdapter } from "../../editors/types.js";

const props = withDefaults(
  defineProps<{
    markdown: string;
    readOnly?: boolean;
  }>(),
  { readOnly: true },
);

const emit = defineEmits<{
  "update:markdown": [markdown: string];
}>();

const hostRef = ref<HTMLElement | null>(null);

// The workbench, and every ancestor of this component, only ever sees the
// EditorAdapter seam. CodeMirrorSourceAdapter is instantiated once, here,
// and never imported anywhere else in the shell.
let adapter: EditorAdapter | undefined;
let unsubscribe: (() => void) | undefined;
let projectedReadOnly = false;

function failClosed(instance: EditorAdapter): void {
  try {
    instance.setReadOnly(true);
    projectedReadOnly = true;
  } catch {
    unsubscribe?.();
    unsubscribe = undefined;
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
  }
});

watch([() => props.markdown, () => props.readOnly], ([markdown, readOnly]) => {
  const instance = adapter;
  if (instance) projectEditorState(instance, markdown, readOnly);
});

onBeforeUnmount(() => {
  unsubscribe?.();
  adapter?.destroy();
  adapter = undefined;
  projectedReadOnly = false;
});

defineExpose({
  focus: () => adapter?.focus(),
});
</script>
