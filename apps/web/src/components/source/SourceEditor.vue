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

onMounted(() => {
  if (!hostRef.value) return;

  const instance = new CodeMirrorSourceAdapter();
  instance.mount(hostRef.value);
  instance.setMarkdown(props.markdown);
  instance.setReadOnly(props.readOnly);
  unsubscribe = instance.onChange((markdown) => emit("update:markdown", markdown));
  adapter = instance;
});

watch(
  () => props.markdown,
  (next) => {
    if (adapter && adapter.getMarkdown() !== next) {
      adapter.setMarkdown(next);
    }
  },
);

watch(
  () => props.readOnly,
  (next) => {
    adapter?.setReadOnly(next);
  },
);

onBeforeUnmount(() => {
  unsubscribe?.();
  adapter?.destroy();
  adapter = undefined;
});

defineExpose({
  focus: () => adapter?.focus(),
});
</script>
