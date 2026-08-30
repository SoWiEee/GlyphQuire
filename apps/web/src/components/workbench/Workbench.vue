<template>
  <div class="flex h-screen flex-col">
    <TopBar
      ref="topBarRef"
      :note-title="activeNote?.title ?? null"
      :mode="mode"
      @update:mode="onModeChange"
      @open-palette="openPalette"
      @open-theme-editor="themeStore.openEditor()"
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

    <div
      v-if="phase5Panel && phase5WorkspaceId"
      class="fixed inset-0 z-40 flex items-start justify-center bg-black/30 p-8 pt-20"
      @click.self="closePhase5Panel"
      @keydown.escape="closePhase5Panel"
    >
      <div
        role="dialog"
        aria-modal="true"
        :aria-label="phase5PanelLabel"
        class="max-h-[80vh] w-full max-w-2xl overflow-auto rounded-lg bg-white p-4 shadow-xl"
      >
        <button
          ref="phase5CloseRef"
          type="button"
          class="mb-3 rounded border border-gray-300 px-2 py-1 text-sm"
          aria-label="Close Phase 5 tools"
          @click="closePhase5Panel"
        >
          Close
        </button>
        <AssetManager
          v-if="phase5Panel === 'assets'"
          :workspace-id="phase5WorkspaceId"
          @reference="insertAssetReference"
        />
        <SearchPalette
          v-else-if="phase5Panel === 'search'"
          :workspace-id="phase5WorkspaceId"
          @select-note="selectSearchResult"
        />
        <TransferDialog
          v-else-if="phase5Panel === 'transfer'"
          :workspace-id="phase5WorkspaceId"
          :note-id="phase5NoteId ?? undefined"
          :base-revision="phase5BaseRevision"
        />
        <ShareLinkDialog
          v-else-if="phase5Panel === 'share' && phase5NoteId"
          :note-id="phase5NoteId"
        />
      </div>
    </div>

    <CommandPalette v-if="paletteOpen" :commands="commands" @close="closePalette" />

    <ThemeEditorPanel v-if="themeStore.editorOpen" @close="themeStore.closeEditor()" />
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from "vue";
import { canonicalUuidSchema } from "@glyphquire/api-contract";
import CommandPalette from "./CommandPalette.vue";
import EditorTabs from "./EditorTabs.vue";
import ExplorerPane from "./ExplorerPane.vue";
import StatusBar from "./StatusBar.vue";
import TopBar from "./TopBar.vue";
import SourceEditor from "../source/SourceEditor.vue";
import VisualEditor from "../visual/VisualEditor.vue";
import SplitEditor from "../split/SplitEditor.vue";
import ThemeEditorPanel from "../theme-editor/ThemeEditorPanel.vue";
import AssetManager from "../assets/AssetManager.vue";
import SearchPalette from "../search/SearchPalette.vue";
import TransferDialog from "../transfer/TransferDialog.vue";
import ShareLinkDialog from "../share/ShareLinkDialog.vue";
import { useThemeStore } from "../../stores/theme.js";
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
import {
  createAssetResolver,
  registerVisualAssetResolver,
} from "../../editors/visual/asset-resolver.js";

const themeStore = useThemeStore();

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
  phase5WorkspaceId?: string;
  phase5NoteId?: string;
}>();

type Phase5Panel = "assets" | "search" | "transfer" | "share";

function routePhase5Context(): { workspaceId: string | null; noteId: string | null } {
  if (typeof location === "undefined") return { workspaceId: null, noteId: null };
  const workspaceMatch = /^\/workspace\/([^/]+)\/?$/u.exec(location.pathname);
  const workspaceId = workspaceMatch?.[1];
  const noteId = new URLSearchParams(location.search).get("noteId");
  return {
    workspaceId: canonicalUuidSchema.safeParse(workspaceId).success ? workspaceId! : null,
    noteId: canonicalUuidSchema.safeParse(noteId).success ? noteId : null,
  };
}

const routeContext = routePhase5Context();
function firstCanonicalUuid(...candidates: Array<string | null | undefined>): string | null {
  for (const candidate of candidates) {
    const parsed = canonicalUuidSchema.safeParse(candidate);
    if (parsed.success) return parsed.data;
  }
  return null;
}
const phase5WorkspaceId = computed(() => {
  return firstCanonicalUuid(props.phase5WorkspaceId, routeContext.workspaceId);
});
const phase5NoteId = computed(() => {
  return firstCanonicalUuid(props.phase5NoteId, activeNoteId.value, routeContext.noteId);
});
const phase5BaseRevision = computed(() => {
  const revision = sessionState.value?.baseRevision;
  return Number.isInteger(revision) && (revision ?? 0) > 0 ? revision : undefined;
});
const phase5Panel = ref<Phase5Panel | null>(null);
const phase5CloseRef = ref<HTMLButtonElement | null>(null);
const phase5PanelLabel = computed(() => {
  switch (phase5Panel.value) {
    case "assets":
      return "Asset manager";
    case "search":
      return "Search notes";
    case "transfer":
      return "Import and export";
    case "share":
      return "Share link";
    default:
      return "Phase 5 tools";
  }
});
let releaseVisualAssetResolver: (() => void) | undefined;
if (phase5WorkspaceId.value) {
  releaseVisualAssetResolver = registerVisualAssetResolver(
    createAssetResolver({ workspaceId: phase5WorkspaceId.value }),
  );
}

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

function openPhase5Panel(panel: Phase5Panel): void {
  phase5Panel.value = panel;
  void nextTick(() => phase5CloseRef.value?.focus());
}

function closePhase5Panel(): void {
  phase5Panel.value = null;
  topBarRef.value?.$el
    ?.querySelector<HTMLButtonElement>('[aria-label="Open command palette"]')
    ?.focus();
}

function insertAssetReference(reference: string): void {
  const session = activeSession.value;
  if (!session || session.snapshot().readOnly) return;
  const markdown = session.snapshot().markdown;
  const separator = markdown.endsWith("\n") || markdown.length === 0 ? "" : "\n";
  session.edit(`${markdown}${separator}\n![Asset](${reference})\n`);
  sessionState.value = session.snapshot();
  closePhase5Panel();
}

function selectSearchResult(noteId: string): void {
  if (notes.value.some((note) => note.id === noteId)) openNote(noteId);
  closePhase5Panel();
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
  ...(phase5WorkspaceId.value
    ? [
        {
          id: "phase5-assets",
          label: "Manage assets",
          hint: "Workspace",
          run: () => openPhase5Panel("assets"),
        },
        {
          id: "phase5-search",
          label: "Search notes",
          hint: "Workspace",
          run: () => openPhase5Panel("search"),
        },
        {
          id: "phase5-transfer",
          label: "Import or export",
          hint: "Workspace",
          run: () => openPhase5Panel("transfer"),
        },
      ]
    : []),
  ...(phase5WorkspaceId.value && phase5NoteId.value
    ? [
        {
          id: "phase5-share",
          label: "Create read-only share link",
          hint: "Note",
          run: () => openPhase5Panel("share"),
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
  releaseVisualAssetResolver?.();
  releaseVisualAssetResolver = undefined;
});
</script>
