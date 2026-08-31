<template>
  <header
    class="gq-top-bar flex items-center justify-between border-b border-gray-200 bg-white px-4 py-2"
  >
    <div class="flex items-center gap-3">
      <span class="text-sm font-semibold text-gray-900">GlyphQuire</span>
      <span class="text-sm text-gray-400" aria-hidden="true">/</span>
      <span v-if="workspaceName" class="text-sm text-gray-500">{{ workspaceName }}</span>
      <span v-if="workspaceName" class="text-sm text-gray-400" aria-hidden="true">/</span>
      <span class="text-sm text-gray-600">{{ noteTitle ?? "No note open" }}</span>
    </div>

    <div class="flex items-center gap-2">
      <div
        class="flex items-center rounded-md border border-gray-300 p-0.5"
        role="radiogroup"
        aria-label="Editor mode"
      >
        <button
          type="button"
          role="radio"
          :aria-checked="mode === 'source'"
          class="rounded px-2 py-1 text-xs font-medium"
          :class="mode === 'source' ? 'bg-gray-900 text-white' : 'text-gray-600 hover:bg-gray-100'"
          @click="emit('update:mode', 'source')"
        >
          Source
        </button>
        <button
          type="button"
          role="radio"
          :aria-checked="mode === 'visual'"
          class="rounded px-2 py-1 text-xs font-medium"
          :class="mode === 'visual' ? 'bg-gray-900 text-white' : 'text-gray-600 hover:bg-gray-100'"
          @click="emit('update:mode', 'visual')"
        >
          Visual
        </button>
        <button
          type="button"
          role="radio"
          :aria-checked="mode === 'split'"
          class="rounded px-2 py-1 text-xs font-medium"
          :class="mode === 'split' ? 'bg-gray-900 text-white' : 'text-gray-600 hover:bg-gray-100'"
          @click="emit('update:mode', 'split')"
        >
          Split
        </button>
      </div>

      <button
        type="button"
        class="rounded-md border border-gray-300 px-3 py-1 text-xs font-medium text-gray-700 hover:bg-gray-50"
        aria-label="Open theme editor"
        @click="emit('open-theme-editor')"
      >
        Theme
      </button>

      <button
        type="button"
        class="rounded-md border border-gray-300 px-3 py-1 text-xs font-medium text-gray-700 hover:bg-gray-50"
        aria-label="Open command palette"
        @click="emit('open-palette')"
      >
        Commands
        <kbd class="ml-1 rounded bg-gray-100 px-1 text-[10px] text-gray-600">⌘K</kbd>
      </button>

      <div v-if="accountLabel" class="relative">
        <button
          type="button"
          class="rounded-md border border-gray-300 px-2 py-1 text-xs font-medium text-gray-700 hover:bg-gray-50"
          aria-label="Open account menu"
          :aria-expanded="accountMenuOpen"
          aria-haspopup="menu"
          @click="accountMenuOpen = !accountMenuOpen"
        >
          {{ accountLabel }}
        </button>
        <div
          v-if="accountMenuOpen"
          role="menu"
          aria-label="Account menu"
          class="absolute right-0 z-20 mt-2 grid min-w-36 gap-1 rounded-md border border-gray-200 bg-white p-1 shadow-lg"
          @keydown.esc="accountMenuOpen = false"
        >
          <button
            type="button"
            role="menuitem"
            aria-label="Theme"
            class="rounded px-2 py-1.5 text-left text-sm text-gray-700 hover:bg-gray-100"
            @click="onAccountAction('theme')"
          >
            Theme
          </button>
          <button
            type="button"
            role="menuitem"
            aria-label="Sign out"
            class="rounded px-2 py-1.5 text-left text-sm text-gray-700 hover:bg-gray-100"
            @click="onAccountAction('sign-out')"
          >
            Sign out
          </button>
          <button
            type="button"
            role="menuitem"
            aria-label="Close menu"
            class="rounded px-2 py-1.5 text-left text-sm text-gray-700 hover:bg-gray-100"
            @click="accountMenuOpen = false"
          >
            Close menu
          </button>
        </div>
      </div>
    </div>
  </header>
</template>

<script setup lang="ts">
import { ref } from "vue";
import type { WorkbenchAccountAction, WorkbenchEditorMode } from "./types.js";

defineProps<{
  noteTitle: string | null;
  mode: WorkbenchEditorMode;
  workspaceName?: string;
  accountLabel?: string;
}>();

const emit = defineEmits<{
  "update:mode": [mode: WorkbenchEditorMode];
  "open-palette": [];
  "open-theme-editor": [];
  "account-action": [action: WorkbenchAccountAction];
}>();

const accountMenuOpen = ref(false);

function onAccountAction(action: WorkbenchAccountAction): void {
  accountMenuOpen.value = false;
  emit("account-action", action);
}
</script>
