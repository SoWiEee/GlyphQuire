<template>
  <div class="flex h-full min-h-0 w-full" data-testid="split-editor">
    <div
      class="min-w-0 flex-1 overflow-auto border-r border-gray-200"
      role="group"
      aria-label="Source pane"
    >
      <SourceEditor
        :markdown="sourceMarkdown"
        :read-only="sourceReadOnly"
        @update:markdown="emit('update:sourceMarkdown', $event)"
      />
    </div>
    <div class="min-w-0 flex-1 overflow-auto" role="group" aria-label="Visual pane">
      <VisualEditor
        :markdown="visualMarkdown"
        :read-only="visualReadOnly"
        @update:markdown="emit('update:visualMarkdown', $event)"
      />
    </div>
  </div>
</template>

<script setup lang="ts">
import SourceEditor from "../source/SourceEditor.vue";
import VisualEditor from "../visual/VisualEditor.vue";

// A split projection of the same authoritative note: Source and Visual side
// by side. EditorSession, not this component, decides which single pane is
// writable at a time (whichever pane was already active when split mode was
// entered keeps the pen; the other pane is a read-only projection) — this
// component only renders whatever readOnly/markdown it is handed and forwards
// edits upward untouched.
defineProps<{
  sourceMarkdown: string;
  sourceReadOnly: boolean;
  visualMarkdown: string;
  visualReadOnly: boolean;
}>();

const emit = defineEmits<{
  "update:sourceMarkdown": [markdown: string];
  "update:visualMarkdown": [markdown: string];
}>();
</script>
