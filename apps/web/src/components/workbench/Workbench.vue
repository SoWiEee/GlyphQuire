<template>
  <div class="flex h-screen flex-col">
    <TopBar
      ref="topBarRef"
      :note-title="activeNote?.title ?? null"
      :mode="mode"
      @update:mode="mode = $event"
      @open-palette="openPalette"
    />

    <div class="flex min-h-0 flex-1">
      <ExplorerPane :notes="notes" :active-note-id="activeNoteId" @select="openNote" />

      <div class="flex min-w-0 flex-1 flex-col">
        <EditorTabs
          :tabs="openTabs"
          :active-tab-id="activeNoteId"
          @select="setActiveNote"
          @close="closeTab"
        />

        <div
          class="min-h-0 flex-1"
          role="tabpanel"
          :aria-label="activeNote ? `${activeNote.title} editor` : 'Editor'"
        >
          <SourceEditor
            v-if="mode === 'source' && activeNote"
            :key="activeNote.id"
            :markdown="activeNote.markdown"
            @update:markdown="onMarkdownChange"
          />
          <div
            v-else-if="mode === 'visual' && activeNote"
            class="flex h-full items-center justify-center text-sm text-gray-400"
          >
            Visual mode is coming in a later task — switch to Source to edit "{{
              activeNote.title
            }}".
          </div>
          <div v-else class="flex h-full items-center justify-center text-sm text-gray-400">
            Open a note from the Explorer to start editing.
          </div>
        </div>
      </div>
    </div>

    <StatusBar :note-title="activeNote?.title ?? null" :mode="mode" :word-count="wordCount" />

    <CommandPalette v-if="paletteOpen" :commands="commands" @close="closePalette" />
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import CommandPalette from "./CommandPalette.vue";
import EditorTabs from "./EditorTabs.vue";
import ExplorerPane from "./ExplorerPane.vue";
import StatusBar from "./StatusBar.vue";
import TopBar from "./TopBar.vue";
import SourceEditor from "@/components/source/SourceEditor.vue";
import type { WorkbenchCommand, WorkbenchEditorMode, WorkbenchNote } from "./types.js";

const notes = ref<WorkbenchNote[]>([
  {
    id: "welcome",
    title: "Welcome",
    markdown: "# Welcome to GlyphQuire\n\nStart writing in **Markdown**.",
  },
  {
    id: "roadmap",
    title: "Roadmap",
    markdown: "# Roadmap\n\n- [ ] Source mode\n- [ ] Visual mode\n- [ ] Version history",
  },
  {
    id: "scratch",
    title: "Scratch",
    markdown: "",
  },
]);

// Tab-shaped state: an ordered list of open note ids, plus which one is active.
const openTabIds = ref<string[]>(["welcome"]);
const activeNoteId = ref<string | null>("welcome");
const mode = ref<WorkbenchEditorMode>("source");
const paletteOpen = ref(false);
const topBarRef = ref<InstanceType<typeof TopBar> | null>(null);

const openTabs = computed<WorkbenchNote[]>(() =>
  openTabIds.value
    .map((id) => notes.value.find((note) => note.id === id))
    .filter((note): note is WorkbenchNote => note !== undefined),
);

const activeNote = computed<WorkbenchNote | null>(
  () => notes.value.find((note) => note.id === activeNoteId.value) ?? null,
);

const wordCount = computed(() => {
  const text = activeNote.value?.markdown.trim() ?? "";
  return text.length === 0 ? 0 : text.split(/\s+/).length;
});

function openNote(noteId: string): void {
  if (!openTabIds.value.includes(noteId)) {
    openTabIds.value = [...openTabIds.value, noteId];
  }
  setActiveNote(noteId);
}

function setActiveNote(noteId: string): void {
  activeNoteId.value = noteId;
}

function closeTab(noteId: string): void {
  const remaining = openTabIds.value.filter((id) => id !== noteId);
  openTabIds.value = remaining;
  if (activeNoteId.value === noteId) {
    activeNoteId.value = remaining.length > 0 ? remaining[remaining.length - 1] : null;
  }
}

function onMarkdownChange(markdown: string): void {
  const note = activeNote.value;
  if (!note) return;
  notes.value = notes.value.map((existing) =>
    existing.id === note.id ? { ...existing, markdown } : existing,
  );
}

function toggleMode(): void {
  mode.value = mode.value === "source" ? "visual" : "source";
}

function openPalette(): void {
  paletteOpen.value = true;
}

function closePalette(): void {
  paletteOpen.value = false;
  topBarRef.value?.$el
    ?.querySelector<HTMLButtonElement>('[aria-label="Open command palette"]')
    ?.focus();
}

const commands = computed<WorkbenchCommand[]>(() => [
  {
    id: "toggle-mode",
    label: mode.value === "source" ? "Switch to Visual mode" : "Switch to Source mode",
    hint: "Mode",
    run: toggleMode,
  },
  ...notes.value.map((note) => ({
    id: `open-${note.id}`,
    label: `Open "${note.title}"`,
    hint: "Note",
    run: () => openNote(note.id),
  })),
  ...(activeNoteId.value
    ? [
        {
          id: "close-active-tab",
          label: `Close "${activeNote.value?.title ?? ""}"`,
          hint: "Tab",
          run: () => closeTab(activeNoteId.value as string),
        },
      ]
    : []),
]);

function onGlobalKeydown(event: KeyboardEvent): void {
  const isPaletteShortcut = (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k";
  if (isPaletteShortcut) {
    event.preventDefault();
    event.stopPropagation();
    paletteOpen.value ? closePalette() : openPalette();
  }
}

onMounted(() => window.addEventListener("keydown", onGlobalKeydown, true));
onBeforeUnmount(() => window.removeEventListener("keydown", onGlobalKeydown, true));
</script>
