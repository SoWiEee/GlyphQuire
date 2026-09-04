<template>
  <div class="gq-split-editor flex h-full min-h-0 w-full" data-testid="split-editor">
    <div
      class="gq-editor-pane gq-editor-pane--source min-w-0 flex-1 overflow-auto border-r"
      :class="{ 'gq-editor-pane--readonly': sourceReadOnly }"
      role="group"
      :aria-label="sourceReadOnly ? '原始碼窗格，唯讀預覽' : '原始碼窗格，編輯中'"
    >
      <div class="gq-editor-pane__header" data-testid="source-pane-header">
        <span class="gq-editor-pane__name">原始碼</span>
        <span
          v-if="!sourceReadOnly"
          class="gq-editor-pane__status gq-editor-pane__status--editing"
          data-testid="source-pane-status"
        >
          <span class="gq-editor-pane__status-dot" aria-hidden="true"></span>
          編輯中
        </span>
        <span
          v-else
          class="gq-editor-pane__status gq-editor-pane__status--readonly"
          data-testid="source-pane-status"
        >
          <GqIcon name="info" size="sm" decorative />
          預覽
        </span>
      </div>
      <SourceEditor
        ref="sourceEditorRef"
        :markdown="sourceMarkdown"
        :read-only="sourceReadOnly"
        :outline-active="!sourceReadOnly"
        @update:markdown="emit('update:sourceMarkdown', $event)"
        @slash-command="onSlashCommand"
      />
    </div>
    <div
      class="gq-editor-pane gq-editor-pane--visual min-w-0 flex-1 overflow-auto"
      :class="{ 'gq-editor-pane--readonly': visualReadOnly }"
      role="group"
      :aria-label="visualReadOnly ? '視覺窗格，唯讀預覽' : '視覺窗格，編輯中'"
    >
      <div class="gq-editor-pane__header" data-testid="visual-pane-header">
        <span class="gq-editor-pane__name">視覺</span>
        <span
          v-if="!visualReadOnly"
          class="gq-editor-pane__status gq-editor-pane__status--editing"
          data-testid="visual-pane-status"
        >
          <span class="gq-editor-pane__status-dot" aria-hidden="true"></span>
          編輯中
        </span>
        <span
          v-else
          class="gq-editor-pane__status gq-editor-pane__status--readonly"
          data-testid="visual-pane-status"
        >
          <GqIcon name="info" size="sm" decorative />
          預覽
        </span>
      </div>
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
import GqIcon from "../icons/GqIcon.vue";
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
