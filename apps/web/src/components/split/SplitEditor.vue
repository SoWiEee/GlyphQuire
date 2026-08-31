<template>
  <div class="flex h-full min-h-0 w-full" data-testid="split-editor">
    <div
      class="min-w-0 flex-1 overflow-auto border-r border-gray-200"
      role="group"
      aria-label="Source pane"
    >
      <SourceEditor
        ref="sourceEditorRef"
        :markdown="sourceMarkdown"
        :read-only="sourceReadOnly"
        :outline-active="!sourceReadOnly"
        @update:markdown="emit('update:sourceMarkdown', $event)"
        @slash-command="onSlashCommand"
      />
    </div>
    <div class="min-w-0 flex-1 overflow-auto" role="group" aria-label="Visual pane">
      <VisualEditor
        ref="visualEditorRef"
        :markdown="visualMarkdown"
        :read-only="visualReadOnly"
        :outline-active="!visualReadOnly"
        @update:markdown="emit('update:visualMarkdown', $event)"
        @slash-command="onSlashCommand"
      />
    </div>
  </div>
</template>

<script setup lang="ts">
import SourceEditor from "../source/SourceEditor.vue";
import VisualEditor from "../visual/VisualEditor.vue";
import { ref } from "vue";
import type { ToolbarAction, WorkbenchEditorHandle } from "../workbench/types.js";

// A split projection of the same authoritative note: Source and Visual side
// by side. EditorSession, not this component, decides which single pane is
// writable at a time (whichever pane was already active when split mode was
// entered keeps the pen; the other pane is a read-only projection) — this
// component only renders whatever readOnly/markdown it is handed and forwards
// edits upward untouched.
const props = defineProps<{
  sourceMarkdown: string;
  sourceReadOnly: boolean;
  visualMarkdown: string;
  visualReadOnly: boolean;
}>();

const emit = defineEmits<{
  "update:sourceMarkdown": [markdown: string];
  "update:visualMarkdown": [markdown: string];
  "slash-command": [request: { query: string; slashRange: { from: number; to: number } }];
}>();

const sourceEditorRef = ref<WorkbenchEditorHandle | null>(null);
const visualEditorRef = ref<WorkbenchEditorHandle | null>(null);

function onSlashCommand(request: {
  query: string;
  slashRange: { from: number; to: number };
}): void {
  emit("slash-command", request);
}

function writableSurface(): WorkbenchEditorHandle | null {
  if (!props.sourceReadOnly) return sourceEditorRef.value;
  if (!props.visualReadOnly) return visualEditorRef.value;
  return null;
}

defineExpose<WorkbenchEditorHandle>({
  applyToolbarAction(action: ToolbarAction): boolean {
    return writableSurface()?.applyToolbarAction(action) ?? false;
  },
  replaceRange(from: number, to: number, insert: string, cursorOffset = insert.length): boolean {
    return writableSurface()?.replaceRange(from, to, insert, cursorOffset) ?? false;
  },
});
</script>
