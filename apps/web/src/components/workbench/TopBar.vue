<template>
  <header class="gq-topbar gq-top-bar flex items-center justify-between">
    <div class="flex items-center gap-3">
      <span class="gq-topbar__brand text-sm font-semibold">GlyphQuire</span>
      <span class="gq-topbar__separator text-sm" aria-hidden="true">/</span>
      <span v-if="workspaceName" class="gq-topbar__workspace text-sm">{{ workspaceName }}</span>
      <span v-if="workspaceName" class="gq-topbar__separator text-sm" aria-hidden="true">/</span>
      <span class="gq-topbar__note text-sm">{{ noteTitle ?? "No note open" }}</span>
    </div>

    <div class="flex items-center gap-2">
      <div
        class="gq-topbar__modes flex items-center rounded-md border p-0.5"
        role="radiogroup"
        aria-label="Editor mode"
      >
        <button
          type="button"
          role="radio"
          :aria-checked="mode === 'source'"
          class="gq-topbar__mode rounded px-2 py-1 text-xs font-medium"
          :class="{ 'gq-topbar__mode--active': mode === 'source' }"
          :data-active="mode === 'source' ? 'true' : undefined"
          @click="emit('update:mode', 'source')"
        >
          Source
        </button>
        <button
          type="button"
          role="radio"
          :aria-checked="mode === 'visual'"
          class="gq-topbar__mode rounded px-2 py-1 text-xs font-medium"
          :class="{ 'gq-topbar__mode--active': mode === 'visual' }"
          :data-active="mode === 'visual' ? 'true' : undefined"
          @click="emit('update:mode', 'visual')"
        >
          Visual
        </button>
        <button
          type="button"
          role="radio"
          :aria-checked="mode === 'split'"
          class="gq-topbar__mode rounded px-2 py-1 text-xs font-medium"
          :class="{ 'gq-topbar__mode--active': mode === 'split' }"
          :data-active="mode === 'split' ? 'true' : undefined"
          @click="emit('update:mode', 'split')"
        >
          Split
        </button>
      </div>

      <button
        type="button"
        class="gq-topbar__action rounded-md border px-3 py-1 text-xs font-medium"
        aria-label="Open theme editor"
        @click="emit('open-theme-editor')"
      >
        Theme
      </button>

      <button
        type="button"
        class="gq-topbar__action rounded-md border px-3 py-1 text-xs font-medium"
        aria-label="Open command palette"
        @click="emit('open-palette')"
      >
        Commands
        <kbd class="gq-topbar__key ml-1 rounded px-1 text-[10px]">⌘K</kbd>
      </button>

      <div v-if="accountLabel" class="relative">
        <button
          type="button"
          class="gq-topbar__action rounded-md border px-2 py-1 text-xs font-medium"
          aria-label="Open account menu"
          :aria-expanded="accountMenuOpen"
          aria-haspopup="menu"
          ref="accountButtonRef"
          @click="toggleAccountMenu"
        >
          {{ accountLabel }}
        </button>
        <div
          v-if="accountMenuOpen"
          role="menu"
          aria-label="Account menu"
          class="gq-topbar__menu absolute right-0 z-20 mt-2 grid min-w-36 gap-1 rounded-md border p-1 shadow-lg"
          @keydown.esc="closeAccountMenu"
        >
          <button
            ref="firstAccountMenuItemRef"
            type="button"
            role="menuitem"
            aria-label="Theme"
            class="gq-topbar__menu-item rounded px-2 py-1.5 text-left text-sm"
            @click="onAccountAction('theme')"
          >
            Theme
          </button>
          <button
            type="button"
            role="menuitem"
            aria-label="Sign out"
            class="gq-topbar__menu-item rounded px-2 py-1.5 text-left text-sm"
            @click="onAccountAction('sign-out')"
          >
            Sign out
          </button>
          <button
            type="button"
            role="menuitem"
            aria-label="Close menu"
            class="gq-topbar__menu-item rounded px-2 py-1.5 text-left text-sm"
            @click="closeAccountMenu"
          >
            Close menu
          </button>
        </div>
      </div>
    </div>
  </header>
</template>

<script setup lang="ts">
import { nextTick, ref } from "vue";
import type { ToolbarAction, WorkbenchAccountAction, WorkbenchEditorMode } from "./types.js";

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
  "toolbar-action": [action: ToolbarAction];
}>();

const accountMenuOpen = ref(false);
const accountButtonRef = ref<HTMLButtonElement | null>(null);
const firstAccountMenuItemRef = ref<HTMLButtonElement | null>(null);

function toggleAccountMenu(): void {
  accountMenuOpen.value = !accountMenuOpen.value;
  void nextTick(() => {
    if (accountMenuOpen.value) {
      firstAccountMenuItemRef.value?.focus();
    } else {
      accountButtonRef.value?.focus();
    }
  });
}

function closeAccountMenu(): void {
  accountMenuOpen.value = false;
  void nextTick(() => accountButtonRef.value?.focus());
}

function onAccountAction(action: WorkbenchAccountAction): void {
  accountMenuOpen.value = false;
  emit("account-action", action);
  void nextTick(() => accountButtonRef.value?.focus());
}
</script>
