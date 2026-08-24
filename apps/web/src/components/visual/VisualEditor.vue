<template>
  <div ref="hostRef" class="h-full w-full overflow-auto text-sm" data-testid="visual-editor-host" />
</template>

<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from "vue";

import { MilkdownVisualAdapter } from "../../editors/visual/MilkdownVisualAdapter.js";
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
let adapter: EditorAdapter | undefined;
let concreteAdapter: MilkdownVisualAdapter | undefined;
let unsubscribe: (() => void) | undefined;
let generation = 0;

function failClosed(instance: MilkdownVisualAdapter): void {
  try {
    instance.setReadOnly(true);
  } finally {
    unsubscribe?.();
    unsubscribe = undefined;
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

  try {
    instance.setMarkdown(props.markdown);
  } catch {
    failClosed(instance);
    return;
  }

  void instance.whenReady().then(
    () => {
      if (mountGeneration !== generation || concreteAdapter !== instance) return;
      project(instance);
    },
    () => {
      if (mountGeneration === generation && concreteAdapter === instance) {
        failClosed(instance);
      }
    },
  );
});

watch([() => props.markdown, () => props.readOnly], () => {
  const instance = concreteAdapter;
  if (instance) project(instance);
});

onBeforeUnmount(() => {
  generation += 1;
  unsubscribe?.();
  adapter?.destroy();
  adapter = undefined;
  concreteAdapter = undefined;
  unsubscribe = undefined;
});

defineExpose({
  focus: () => adapter?.focus(),
});
</script>
