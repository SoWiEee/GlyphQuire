<template>
  <div class="flex h-screen flex-col">
    <TopBar
      ref="topBarRef"
      :note-title="activeNote?.title ?? null"
      :mode="mode"
      @update:mode="onModeChange"
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
            :markdown="activeMarkdown"
            :read-only="sourceReadOnly"
            @update:markdown="onMarkdownChange"
          />
          <VisualEditor
            v-else-if="mode === 'visual' && activeNote"
            :key="activeNote.id"
            :markdown="visualMarkdown"
            :read-only="visualReadOnly"
            @update:markdown="onVisualMarkdownChange"
          />
          <SplitEditor
            v-else-if="mode === 'split' && activeNote"
            :key="activeNote.id"
            :source-markdown="activeMarkdown"
            :source-read-only="sourceReadOnly"
            :visual-markdown="visualMarkdown"
            :visual-read-only="visualReadOnly"
            @update:source-markdown="onMarkdownChange"
            @update:visual-markdown="onVisualMarkdownChange"
          />
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
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from "vue";
import CommandPalette from "./CommandPalette.vue";
import EditorTabs from "./EditorTabs.vue";
import ExplorerPane from "./ExplorerPane.vue";
import StatusBar from "./StatusBar.vue";
import TopBar from "./TopBar.vue";
import SourceEditor from "../source/SourceEditor.vue";
import VisualEditor from "../visual/VisualEditor.vue";
import SplitEditor from "../split/SplitEditor.vue";
import {
  createBookkeepingModeAdapter,
  createLiveModeAdapter,
  type WorkbenchModeAdapterShim,
} from "../../editors/WorkbenchModeAdapterShim.js";
import type { EditorSession, EditorSessionState } from "../../editors/editor-session.types.js";
import type {
  WorkbenchCommand,
  WorkbenchEditorMode,
  WorkbenchNote,
  WorkbenchSessionFactory,
} from "./types.js";

const DEFAULT_NOTES: WorkbenchNote[] = [
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
];

const props = defineProps<{
  initialNotes?: readonly WorkbenchNote[];
  sessionFactory?: WorkbenchSessionFactory;
}>();

const notes = ref<WorkbenchNote[]>(
  (props.initialNotes ?? DEFAULT_NOTES).map((note) => ({ ...note })),
);

// Tab-shaped state: an ordered list of open note ids, plus which one is active.
const initialNoteId = notes.value[0]?.id ?? null;
const openTabIds = ref<string[]>(initialNoteId ? [initialNoteId] : []);
const activeNoteId = ref<string | null>(initialNoteId);
const paletteOpen = ref(false);
const topBarRef = ref<InstanceType<typeof TopBar> | null>(null);
const activeSession = shallowRef<EditorSession>();
const sessionState = shallowRef<EditorSessionState>();
let unsubscribeSession: (() => void) | undefined;
let sessionGeneration = 0;

// Visual's pane has no other display or edit-routing path of its own (unlike
// Source, which stays on the EditorSessionState-driven props/session.edit()
// composition below), so it is driven directly by a live mode-adapter shim
// bound to attachModeAdapters().
const visualMarkdown = ref("");
const visualEditorReadOnly = ref(true);
let sourceModeAdapter: WorkbenchModeAdapterShim | undefined;
let visualModeAdapter: WorkbenchModeAdapterShim | undefined;
let detachModeAdapters: (() => void) | undefined;

const openTabs = computed<WorkbenchNote[]>(() =>
  openTabIds.value
    .map((id) => notes.value.find((note) => note.id === id))
    .filter((note): note is WorkbenchNote => note !== undefined),
);

const activeNote = computed<WorkbenchNote | null>(
  () => notes.value.find((note) => note.id === activeNoteId.value) ?? null,
);

const activeMarkdown = computed(
  () => sessionState.value?.markdown ?? activeNote.value?.markdown ?? "",
);
// Source's own pane is writable only while it is also the session's active
// pane — in "source" mode that is always true, so this is exactly the prior
// behavior; in "split" mode it correctly yields to whichever pane was active
// before split was entered.
const sourceReadOnly = computed(
  () =>
    !sessionState.value ||
    sessionState.value.readOnly ||
    sessionState.value.activePane !== "source",
);
const visualReadOnly = computed(() => visualEditorReadOnly.value);
const mode = computed<WorkbenchEditorMode>(() => {
  const sessionMode = sessionState.value?.mode;
  return sessionMode === "visual" || sessionMode === "split" ? sessionMode : "source";
});

const wordCount = computed(() => {
  const text = activeMarkdown.value.trim();
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
  const session = activeSession.value;
  if (!session || sourceReadOnly.value) return;
  // Bookkeeping only: this shim never routes edits on its own (see
  // WorkbenchModeAdapterShim), so session.edit() below remains the single
  // path that actually applies a Source edit.
  sourceModeAdapter?.syncFromUi(markdown, false);
  session.edit(markdown);
  sessionState.value = session.snapshot();
}

function onVisualMarkdownChange(markdown: string): void {
  if (visualEditorReadOnly.value) return;
  // Notifying routes this through EditorSession's own onAdapterChange
  // listener, which calls session.edit() for us — Visual has no separate
  // display path, so this is the only place that edit can originate.
  visualModeAdapter?.syncFromUi(markdown, true);
}

function toggleMode(): void {
  onModeChange(mode.value === "source" ? "visual" : "source");
}

function onModeChange(nextMode: WorkbenchEditorMode): void {
  const session = activeSession.value;
  if (!session) return;
  void session.switchMode(nextMode).then(() => {
    if (activeSession.value === session) sessionState.value = session.snapshot();
  });
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

function detachActiveModeAdapters(): void {
  detachModeAdapters?.();
  detachModeAdapters = undefined;
  sourceModeAdapter = undefined;
  visualModeAdapter = undefined;
  visualMarkdown.value = "";
  visualEditorReadOnly.value = true;
}

async function activateSession(note: WorkbenchNote | null): Promise<void> {
  const generation = ++sessionGeneration;
  const previous = activeSession.value;
  unsubscribeSession?.();
  unsubscribeSession = undefined;
  detachActiveModeAdapters();
  activeSession.value = undefined;
  sessionState.value = undefined;
  if (previous) await previous.dispose();
  if (generation !== sessionGeneration || !note || !props.sessionFactory) return;

  let next: EditorSession;
  try {
    next = await props.sessionFactory(note);
  } catch {
    return;
  }
  if (generation !== sessionGeneration) {
    await next.dispose();
    return;
  }

  activeSession.value = next;
  sessionState.value = next.snapshot();
  unsubscribeSession = next.subscribe((state) => {
    if (activeSession.value === next) sessionState.value = state;
  });

  const initialMarkdown = next.snapshot().markdown;
  visualMarkdown.value = initialMarkdown;
  visualEditorReadOnly.value = true;
  sourceModeAdapter = createBookkeepingModeAdapter(initialMarkdown);
  visualModeAdapter = createLiveModeAdapter(visualMarkdown, visualEditorReadOnly);
  try {
    const detach = await next.attachModeAdapters({
      source: sourceModeAdapter,
      visual: visualModeAdapter,
    });
    if (generation !== sessionGeneration || activeSession.value !== next) {
      detach();
      return;
    }
    detachModeAdapters = detach;
  } catch {
    // Visual/Split stay unavailable for this session (switchMode reports
    // "unsupported"); Source keeps working through its existing
    // session.edit()-based path above.
    sourceModeAdapter = undefined;
    visualModeAdapter = undefined;
  }
}

watch(activeNote, (note) => void activateSession(note), { immediate: true });

onMounted(() => window.addEventListener("keydown", onGlobalKeydown, true));
onBeforeUnmount(() => {
  window.removeEventListener("keydown", onGlobalKeydown, true);
  sessionGeneration += 1;
  unsubscribeSession?.();
  unsubscribeSession = undefined;
  detachActiveModeAdapters();
  const session = activeSession.value;
  activeSession.value = undefined;
  sessionState.value = undefined;
  if (session) void session.dispose();
});
</script>
