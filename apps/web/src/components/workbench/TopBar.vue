<template>
  <header class="gq-topbar gq-top-bar">
    <div class="gq-topbar__identity flex items-center gap-3">
      <span class="gq-topbar__brand text-sm font-semibold">GlyphQuire</span>
      <span class="gq-topbar__separator text-sm" aria-hidden="true">/</span>
      <span v-if="workspaceName" class="gq-topbar__workspace text-sm">{{ workspaceName }}</span>
      <span v-if="workspaceName" class="gq-topbar__separator text-sm" aria-hidden="true">/</span>
      <span class="gq-topbar__note text-sm">{{ noteTitle ?? "No note open" }}</span>
    </div>

    <nav class="gq-topbar__pages" role="tablist" aria-label="Workspace pages">
      <button
        v-for="page in primaryPages"
        :key="page.id"
        type="button"
        role="tab"
        class="gq-topbar__page rounded-md px-2.5 py-1.5 text-xs font-medium"
        :class="{ 'gq-topbar__page--active': activePage === page.id }"
        :aria-label="page.label"
        :aria-selected="activePage === page.id"
        :aria-controls="`workbench-page-${page.id}`"
        :disabled="page.id !== 'editor' && !workspaceAvailable"
        @click="onPageChange(page.id)"
      >
        <GqIcon :name="page.icon" size="sm" />
        <span>{{ page.label }}</span>
      </button>
    </nav>

    <div class="gq-topbar__controls flex items-center gap-2">
      <div
        v-if="activePage === 'editor'"
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

      <div class="relative">
        <button
          ref="toolsButtonRef"
          type="button"
          class="gq-topbar__action flex items-center gap-1 rounded-md border px-3 py-1 text-xs font-medium"
          aria-label="Open tools menu"
          :aria-expanded="toolsMenuOpen"
          aria-haspopup="menu"
          @click="toggleToolsMenu"
        >
          <GqIcon name="settings" size="sm" />
          Tools
        </button>
        <div
          v-if="toolsMenuOpen"
          role="menu"
          aria-label="Tools menu"
          class="gq-topbar__menu absolute right-0 z-20 mt-2 grid min-w-48 gap-1 rounded-md border p-1 shadow-lg"
          @keydown.esc="closeToolsMenu"
        >
          <button
            ref="firstToolsMenuItemRef"
            type="button"
            role="menuitem"
            aria-label="Open version history"
            class="gq-topbar__menu-item flex items-center gap-2 rounded px-2 py-1.5 text-left text-sm"
            :disabled="!workspaceAvailable"
            @click="onToolAction('history')"
          >
            <GqIcon name="rotate-ccw" size="sm" />
            History
          </button>
          <button
            type="button"
            role="menuitem"
            aria-label="Manage assets"
            class="gq-topbar__menu-item flex items-center gap-2 rounded px-2 py-1.5 text-left text-sm"
            :disabled="!workspaceAvailable"
            @click="onToolAction('assets')"
          >
            <GqIcon name="layout-panel-top" size="sm" />
            Assets
          </button>
          <button
            type="button"
            role="menuitem"
            aria-label="Manage custom blocks"
            class="gq-topbar__menu-item flex items-center gap-2 rounded px-2 py-1.5 text-left text-sm"
            :disabled="!workspaceAvailable"
            @click="onToolAction('custom-blocks')"
          >
            <GqIcon name="columns-3" size="sm" />
            Custom Blocks
          </button>
          <button
            type="button"
            role="menuitem"
            aria-label="Open theme editor"
            class="gq-topbar__menu-item flex items-center gap-2 rounded px-2 py-1.5 text-left text-sm"
            @click="onToolAction('theme')"
          >
            <GqIcon name="palette" size="sm" />
            Theme
          </button>
        </div>
      </div>

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
import { computed, nextTick, ref } from "vue";
import GqIcon from "../icons/GqIcon.vue";
import type {
  WorkbenchAccountAction,
  WorkbenchEditorMode,
  WorkbenchPrimaryPage,
  WorkbenchToolAction,
} from "./types.js";

const props = withDefaults(
  defineProps<{
    noteTitle: string | null;
    mode: WorkbenchEditorMode;
    activePage?: WorkbenchPrimaryPage;
    workspaceName?: string;
    accountLabel?: string;
    workspaceAvailable?: boolean;
  }>(),
  { activePage: "editor", workspaceAvailable: true },
);

const emit = defineEmits<{
  "update:mode": [mode: WorkbenchEditorMode];
  "update:page": [page: WorkbenchPrimaryPage];
  "open-palette": [];
  "tool-action": [action: WorkbenchToolAction];
  "account-action": [action: WorkbenchAccountAction];
}>();

const primaryPages: ReadonlyArray<{
  id: WorkbenchPrimaryPage;
  label: string;
  icon: "file-text" | "search" | "link-2" | "upload";
}> = [
  { id: "editor", label: "Editor", icon: "file-text" },
  { id: "search", label: "Search", icon: "search" },
  { id: "shared", label: "Shared", icon: "link-2" },
  { id: "transfer", label: "Transfer", icon: "upload" },
];

const activePage = computed(() => props.activePage);
const accountMenuOpen = ref(false);
const accountButtonRef = ref<HTMLButtonElement | null>(null);
const firstAccountMenuItemRef = ref<HTMLButtonElement | null>(null);
const toolsMenuOpen = ref(false);
const toolsButtonRef = ref<HTMLButtonElement | null>(null);
const firstToolsMenuItemRef = ref<HTMLButtonElement | null>(null);

function toggleToolsMenu(): void {
  toolsMenuOpen.value = !toolsMenuOpen.value;
  void nextTick(() => {
    if (toolsMenuOpen.value) {
      firstToolsMenuItemRef.value?.focus();
    } else {
      toolsButtonRef.value?.focus();
    }
  });
}

function closeToolsMenu(): void {
  toolsMenuOpen.value = false;
  void nextTick(() => toolsButtonRef.value?.focus());
}

function onToolAction(action: WorkbenchToolAction): void {
  toolsMenuOpen.value = false;
  emit("tool-action", action);
}

function onPageChange(page: WorkbenchPrimaryPage): void {
  toolsMenuOpen.value = false;
  emit("update:page", page);
}

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
