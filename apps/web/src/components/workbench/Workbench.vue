<template>
  <div class="gq-workbench-shell flex h-screen flex-col">
    <div class="flex items-center border-b border-gray-200 bg-white">
      <TopBar
        ref="topBarRef"
        class="min-w-0 flex-1 border-b-0"
        :note-title="activeNote?.title ?? null"
        :mode="mode"
        :workspace-name="effectiveWorkspaceName"
        :account-label="effectiveAccountLabel"
        @update:mode="onModeChange"
        @open-palette="openPalette"
        @open-theme-editor="themeStore.openEditor()"
        @account-action="onAccountAction"
        @toolbar-action="onToolbarAction"
      />
      <StatusIndicator
        class="mr-4 text-gray-600"
        :state="saveState"
        :detail="saveStateDetail"
        compact
      />
    </div>

    <EditorToolbar
      :disabled="toolbarDisabled"
      :mode="mode"
      @action="onToolbarAction"
      @open-palette="openPalette"
    />

    <div class="gq-workbench-body flex min-h-0 flex-1">
      <div
        id="gq-explorer-pane"
        class="gq-explorer-slot"
        :class="{ 'gq-explorer-slot--open': explorerOpen }"
      >
        <ExplorerPane
          :notes="notes"
          :active-note-id="activeNoteId"
          :workspace-available="workspaceAvailable"
          @select="openNote"
          @search="() => openPhase5Panel('search')"
          @shared-links="onSharedLinks"
        />
      </div>

      <div class="gq-editor-column flex min-w-0 flex-1 flex-col">
        <div
          class="gq-workbench-panel-toggles flex items-center gap-2 border-b border-gray-200 px-3 py-2"
        >
          <button
            type="button"
            class="gq-workbench-panel-toggle rounded border border-gray-300 px-2 py-1 text-xs text-gray-700"
            aria-label="Open explorer"
            aria-controls="gq-explorer-pane"
            :aria-expanded="explorerOpen"
            @click="explorerOpen = !explorerOpen"
          >
            Explorer
          </button>
          <button
            type="button"
            class="gq-workbench-panel-toggle rounded border border-gray-300 px-2 py-1 text-xs text-gray-700"
            aria-label="Open context tools"
            aria-controls="context-rail"
            :aria-expanded="contextRailOpen"
            @click="contextRailOpen = true"
          >
            Context
          </button>
        </div>
        <EditorTabs
          :tabs="openTabs"
          :active-tab-id="activeNoteId"
          @select="setActiveNote"
          @close="closeTab"
        />

        <SaveStateBanner
          v-if="showSaveStateBanner"
          :state="saveState"
          :message="saveStateMessage"
          :can-retry="canRetrySave"
          :can-open-conflict="canOpenConflict"
          @retry="retrySave"
          @open-conflict="openConflict"
        />

        <div
          class="min-h-0 flex-1"
          role="tabpanel"
          :aria-label="activeNote ? `${activeNote.title} editor` : 'Editor'"
        >
          <SourceEditor
            v-if="mode === 'source' && activeNote"
            ref="sourceEditorRef"
            :key="activeNote.id"
            :markdown="activeMarkdown"
            :read-only="sourceReadOnly"
            @update:markdown="onMarkdownChange"
            @slash-command="onSlashCommand"
          />
          <VisualEditor
            v-else-if="mode === 'visual' && activeNote"
            ref="visualEditorRef"
            :key="activeNote.id"
            :markdown="visualMarkdown"
            :read-only="visualReadOnly"
            @update:markdown="onVisualMarkdownChange"
            @slash-command="onSlashCommand"
          />
          <SplitEditor
            v-else-if="mode === 'split' && activeNote"
            ref="splitEditorRef"
            :key="activeNote.id"
            :source-markdown="activeMarkdown"
            :source-read-only="sourceReadOnly"
            :visual-markdown="visualMarkdown"
            :visual-read-only="visualReadOnly"
            @update:source-markdown="onMarkdownChange"
            @update:visual-markdown="onVisualMarkdownChange"
            @slash-command="onSlashCommand"
          />
          <div v-else class="flex h-full items-center justify-center text-sm text-gray-400">
            Open a note from the Explorer to start editing.
          </div>
        </div>
      </div>

      <ContextRail
        :open="contextRailOpen"
        :compact="compactScreen"
        :note-title="activeNote?.title ?? null"
        :workspace-available="workspaceAvailable"
        :note-available="Boolean(activeNote)"
        :outline="outline"
        :current-revision="phase5BaseRevision"
        :read-only="sessionState?.readOnly ?? true"
        @close="contextRailOpen = false"
        @action="onContextAction"
        @select-outline="onSelectOutline"
      />
    </div>

    <StatusBar
      :note-title="activeNote?.title ?? null"
      :mode="mode"
      :word-count="wordCount"
      :save-state="saveState"
      :save-detail="saveStateDetail"
    />

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
        <VersionHistory
          v-else-if="phase5Panel === 'history' && phase5NoteId"
          :note-id="phase5NoteId"
          :current-revision="phase5BaseRevision"
          @restored="onHistoryRestored"
        />
        <SharedLinksPanel
          v-else-if="phase5Panel === 'shared-links'"
          :links="phase5Store.shareLinks"
          @open="onSharedLinkOpen"
          @revoke="onSharedLinkRevoke"
        />
      </div>
    </div>

    <CommandPalette
      v-if="paletteOpen"
      :commands="paletteCommands"
      :initial-query="paletteInitialQuery"
      :category-filter="paletteCategoryFilter"
      @close="closePalette"
    />

    <ThemeEditorPanel v-if="themeStore.editorOpen" @close="themeStore.closeEditor()" />
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from "vue";
import { canonicalUuidSchema } from "@glyphquire/api-contract";
import CommandPalette from "./CommandPalette.vue";
import ContextRail from "./ContextRail.vue";
import EditorToolbar from "./EditorToolbar.vue";
import EditorTabs from "./EditorTabs.vue";
import ExplorerPane from "./ExplorerPane.vue";
import SaveStateBanner from "./SaveStateBanner.vue";
import StatusBar from "./StatusBar.vue";
import StatusIndicator from "./StatusIndicator.vue";
import TopBar from "./TopBar.vue";
import SourceEditor from "../source/SourceEditor.vue";
import VisualEditor from "../visual/VisualEditor.vue";
import SplitEditor from "../split/SplitEditor.vue";
import ThemeEditorPanel from "../theme-editor/ThemeEditorPanel.vue";
import AssetManager from "../assets/AssetManager.vue";
import SearchPalette from "../search/SearchPalette.vue";
import TransferDialog from "../transfer/TransferDialog.vue";
import ShareLinkDialog from "../share/ShareLinkDialog.vue";
import SharedLinksPanel from "../share/SharedLinksPanel.vue";
import VersionHistory from "../history/VersionHistory.vue";
import { useThemeStore } from "../../stores/theme.js";
import { usePhase5Store } from "../../stores/phase5.js";
import {
  createBookkeepingModeAdapter,
  createLiveModeAdapter,
  type WorkbenchModeAdapterShim,
} from "../../editors/WorkbenchModeAdapterShim.js";
import type { EditorSession, EditorSessionState } from "../../editors/editor-session.types.js";
import type { NoteResult } from "@glyphquire/api-contract";
import type {
  WorkbenchCommand,
  ContextAction,
  OutlineEntry,
  WorkbenchAccountAction,
  WorkbenchEditorMode,
  WorkbenchNote,
  WorkbenchSessionFactory,
  WorkbenchSessionHandle,
  WorkbenchConflictContext,
  WorkbenchConflictRecovery,
  WorkbenchSaveState,
  ToolbarAction,
  WorkbenchEditorHandle,
  SlashCommandRequest,
} from "./types.js";
import {
  BLOCK_COMMANDS,
  materializeBlockCommand,
  type BlockCommandDefinition,
} from "./markdown-format.js";
import {
  createAssetResolver,
  registerVisualAssetResolver,
} from "../../editors/visual/asset-resolver.js";

const themeStore = useThemeStore();
const phase5Store = usePhase5Store();

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
  workspaceName?: string;
  accountLabel?: string;
}>();

const emit = defineEmits<{
  "account-action": [action: WorkbenchAccountAction];
  "request-conflict-recovery": [entry: WorkbenchConflictRecovery];
}>();

type Phase5Panel = "assets" | "search" | "transfer" | "share" | "history" | "shared-links";

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
const activeSessionContext = shallowRef<WorkbenchSessionHandle["context"]>();
function firstCanonicalUuid(...candidates: Array<string | null | undefined>): string | null {
  for (const candidate of candidates) {
    const parsed = canonicalUuidSchema.safeParse(candidate);
    if (parsed.success) return parsed.data;
  }
  return null;
}
const phase5WorkspaceId = computed(() => {
  return firstCanonicalUuid(
    props.phase5WorkspaceId,
    activeSessionContext.value?.workspaceId,
    props.sessionFactory ? routeContext.workspaceId : null,
  );
});
const phase5NoteId = computed(() => {
  return firstCanonicalUuid(props.phase5NoteId, activeNoteId.value, routeContext.noteId);
});
const phase5BaseRevision = computed(() => {
  const revision = sessionState.value?.baseRevision;
  return Number.isInteger(revision) && (revision ?? 0) > 0 ? revision : null;
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
    case "history":
      return "Version history";
    case "shared-links":
      return "Shared links";
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
const paletteInitialQuery = ref<string | undefined>();
const paletteCategoryFilter = ref<WorkbenchCommand["category"]>();
const explorerOpen = ref(true);
const contextRailOpen = ref(false);
const compactScreen = ref(false);
const topBarRef = ref<InstanceType<typeof TopBar> | null>(null);
const sourceEditorRef = ref<WorkbenchEditorHandle | null>(null);
const visualEditorRef = ref<WorkbenchEditorHandle | null>(null);
const splitEditorRef = ref<WorkbenchEditorHandle | null>(null);
const activeSession = shallowRef<EditorSession>();
const sessionState = shallowRef<EditorSessionState>();
let unsubscribeSession: (() => void) | undefined;
let sessionGeneration = 0;
let historyRestoreToken = 0;

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

const activeSurfaceRef = computed<WorkbenchEditorHandle | null>(() => {
  if (mode.value === "visual") return visualEditorRef.value;
  if (mode.value === "split") return splitEditorRef.value;
  return sourceEditorRef.value;
});
const toolbarDisabled = computed(
  () => !activeNote.value || !activeSession.value || sessionState.value?.readOnly !== false,
);
const slashRequest = shallowRef<
  (SlashCommandRequest & { readonly surface: WorkbenchEditorHandle }) | null
>(null);

const workspaceAvailable = computed(() => phase5WorkspaceId.value !== null);
const effectiveWorkspaceName = computed(
  () => activeSessionContext.value?.workspaceName ?? props.workspaceName,
);
const effectiveAccountLabel = computed(
  () => activeSessionContext.value?.accountLabel ?? props.accountLabel,
);

const activeConflictContext = computed<WorkbenchConflictContext | undefined>(() => {
  const context = activeSessionContext.value;
  if (!context) return undefined;
  const userId = canonicalUuidSchema.safeParse(context.userId);
  const workspaceId = canonicalUuidSchema.safeParse(context.workspaceId);
  if (!userId.success || !workspaceId.success) return undefined;
  return { userId: userId.data, workspaceId: workspaceId.data };
});

function saveStateFromSession(state: EditorSessionState | undefined): WorkbenchSaveState {
  if (!state) return "unavailable";
  if (state.readOnly || state.isReadOnly) return "read-only";
  if (state.conflict || state.saveStatus === "conflict") return "conflict";
  if (state.saveStatus === "offline") return "offline";
  if (state.saveStatus === "error") return "error";
  if (state.saveStatus === "saving") return "saving";
  if (state.saveStatus === "dirty") return "dirty";
  return "saved";
}

const saveState = computed<WorkbenchSaveState>(() => saveStateFromSession(sessionState.value));
const saveStateDetail = computed<string | undefined>(() => {
  switch (saveState.value) {
    case "saving":
      return "Syncing now";
    case "dirty":
      return "Waiting to save";
    case "read-only":
      return "Editing disabled";
    default:
      return undefined;
  }
});
const saveStateMessage = computed(() => {
  switch (saveState.value) {
    case "offline":
      return "Changes are queued locally. We'll retry when the connection returns.";
    case "error":
      return "We couldn't save your changes. Try again.";
    case "conflict":
      return "Another version was saved. Review the conflicting edits to continue.";
    case "unavailable":
      return "This note is unavailable for editing right now.";
    default:
      return "";
  }
});
const showSaveStateBanner = computed(() =>
  ["offline", "error", "conflict", "unavailable"].includes(saveState.value),
);
const canRetrySave = computed(
  () =>
    Boolean(activeSession.value) && (saveState.value === "offline" || saveState.value === "error"),
);
const canOpenConflict = computed(
  () =>
    saveState.value === "conflict" &&
    Boolean(activeConflictContext.value) &&
    Boolean(sessionState.value?.conflict),
);

function extractOutline(markdown: string): OutlineEntry[] {
  const seen = new Map<string, number>();
  const entries: OutlineEntry[] = [];
  for (const line of markdown.split("\n")) {
    const match = /^(#{1,3})\s+(.+)$/.exec(line);
    if (!match) continue;
    const depth = match[1].length as 1 | 2 | 3;
    const label = match[2].trim();
    if (!label) continue;
    const base =
      label
        .normalize("NFKD")
        .replace(/[\u0300-\u036f]/gu, "")
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s-]/gu, "")
        .trim()
        .replace(/[\s-]+/gu, "-") || "heading";
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    entries.push({ id: count === 0 ? base : `${base}-${count}`, depth, label });
  }
  return entries;
}

const outline = computed<OutlineEntry[]>(() => extractOutline(activeMarkdown.value));

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

async function retrySave(): Promise<void> {
  const session = activeSession.value;
  if (!session || !canRetrySave.value) return;
  try {
    await session.saveNow();
  } catch {
    // EditorSession publishes the resulting state; provider errors stay out of
    // the plain-language workbench status copy.
  }
}

function openConflict(): void {
  const state = sessionState.value;
  const context = activeConflictContext.value;
  const note = activeNote.value;
  if (!context || !state?.conflict || !note || !canOpenConflict.value) return;

  emit("request-conflict-recovery", {
    userId: context.userId,
    workspaceId: context.workspaceId,
    noteId: state.noteId,
    conflict: state.conflict,
    localMarkdown: state.markdown,
    localBaseRevision: isValidRevision(state.baseRevision) ? state.baseRevision : null,
  });
}

function onToolbarAction(action: ToolbarAction): void {
  const session = activeSession.value;
  if (!session || session.snapshot().readOnly) return;
  const surface = activeSurfaceRef.value;
  if (!surface?.applyToolbarAction(action)) return;
  sessionState.value = session.snapshot();
}

function onSlashCommand(request: SlashCommandRequest): void {
  const session = activeSession.value;
  const surface = activeSurfaceRef.value;
  if (!session || session.snapshot().readOnly || !surface) return;
  slashRequest.value = { ...request, surface };
  paletteInitialQuery.value = "";
  paletteCategoryFilter.value = "block";
  paletteOpen.value = true;
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

function onAccountAction(action: WorkbenchAccountAction): void {
  emit("account-action", action);
}

function onContextAction(action: Exclude<ContextAction, "outline">): void {
  if (action === "history") {
    if (!phase5NoteId.value || phase5BaseRevision.value === null) return;
    phase5Panel.value = "history";
    void nextTick(() => phase5CloseRef.value?.focus());
  } else {
    openPhase5Panel(action);
  }
  contextRailOpen.value = false;
}

function onSharedLinks(): void {
  if (!phase5WorkspaceId.value) return;
  openPhase5Panel("shared-links");
}

function onSharedLinkOpen(noteId: string): void {
  if (notes.value.some((note) => note.id === noteId)) openNote(noteId);
  closePhase5Panel();
}

async function onSharedLinkRevoke(linkId: string): Promise<void> {
  try {
    await phase5Store.revokeShareLink(linkId);
  } catch {
    // The store owns the user-facing error projection for failed revocations.
  }
}

function onSelectOutline(id: string): void {
  const escapedId =
    typeof CSS !== "undefined" && typeof CSS.escape === "function"
      ? CSS.escape(id)
      : id.replace(/[^a-zA-Z0-9_-]/gu, "\\$&");
  document
    .querySelector<HTMLElement>(`[data-editor-outline-id="${escapedId}"]`)
    ?.scrollIntoView({ block: "center" });
}

function openPalette(): void {
  slashRequest.value = null;
  paletteInitialQuery.value = undefined;
  paletteCategoryFilter.value = undefined;
  paletteOpen.value = true;
}

function closePalette(): void {
  paletteOpen.value = false;
  slashRequest.value = null;
  paletteInitialQuery.value = undefined;
  paletteCategoryFilter.value = undefined;
  topBarRef.value?.$el
    ?.querySelector<HTMLButtonElement>('[aria-label="Open command palette"]')
    ?.focus();
}

function onBlockCommand(definition: BlockCommandDefinition): void {
  const request = slashRequest.value;
  const session = activeSession.value;
  if (!request || !session || session.snapshot().readOnly) return;
  if (
    request.surface.replaceRange(
      request.slashRange.from,
      request.slashRange.to,
      definition.markdown,
      definition.cursorOffset,
    )
  ) {
    sessionState.value = session.snapshot();
  }
  closePalette();
}

function openPhase5Panel(panel: Phase5Panel): void {
  if (!phase5WorkspaceId.value) return;
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

function normalizeSessionHandle(
  value: EditorSession | WorkbenchSessionHandle,
): WorkbenchSessionHandle {
  return "session" in value ? value : { session: value };
}

function createStagedLiveModeAdapter(initialMarkdown: string): {
  adapter: WorkbenchModeAdapterShim;
  commit: () => void;
} {
  let markdown = initialMarkdown;
  let readOnly = true;
  let target:
    | { markdown: typeof visualMarkdown; readOnly: typeof visualEditorReadOnly }
    | undefined;
  const listeners = new Set<(nextMarkdown: string) => void>();

  const syncFromUi = (nextMarkdown: string, notify: boolean): void => {
    markdown = nextMarkdown;
    if (target) target.markdown.value = nextMarkdown;
    if (notify) {
      for (const listener of listeners) listener(nextMarkdown);
    }
  };

  return {
    adapter: {
      setMarkdown(nextMarkdown: string): void {
        syncFromUi(nextMarkdown, false);
      },
      getMarkdown(): string {
        return target?.markdown.value ?? markdown;
      },
      setReadOnly(nextReadOnly: boolean): void {
        readOnly = nextReadOnly;
        if (target) target.readOnly.value = nextReadOnly;
      },
      onChange(listener: (nextMarkdown: string) => void): () => void {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      syncFromUi,
    },
    commit(): void {
      target = { markdown: visualMarkdown, readOnly: visualEditorReadOnly };
      target.markdown.value = markdown;
      target.readOnly.value = readOnly;
    },
  };
}

function isCurrentHistoryRestore(
  token: number,
  generation: number,
  noteId: string,
  session: EditorSession,
): boolean {
  return (
    historyRestoreToken === token &&
    sessionGeneration === generation &&
    activeNoteId.value === noteId &&
    activeNote.value?.id === noteId &&
    activeSession.value === session
  );
}

async function onHistoryRestored(result: NoteResult): Promise<void> {
  const currentNote = activeNote.value;
  const expectedNoteId = phase5NoteId.value;
  if (
    !currentNote ||
    !expectedNoteId ||
    result.id !== expectedNoteId ||
    result.id !== currentNote.id ||
    result.workspaceId !== phase5WorkspaceId.value
  )
    return;
  if (!props.sessionFactory) return;
  const expectedMarkdown = result.contentMarkdown;
  const expectedRevision = result.revision;
  if (!isValidRevision(expectedRevision)) return;

  const note: WorkbenchNote = { ...currentNote, markdown: expectedMarkdown };
  const previous = activeSession.value;
  if (!previous) return;
  const expectedGeneration = sessionGeneration;
  const expectedActiveNoteId = activeNoteId.value;
  const restoreToken = ++historyRestoreToken;
  const previousUnsubscribe = unsubscribeSession;
  const previousDetach = detachModeAdapters;
  let replacement: WorkbenchSessionHandle | undefined;
  let nextUnsubscribe: (() => void) | undefined;
  let nextDetach: (() => void) | undefined;
  let committed = false;

  const disposeReplacement = async (): Promise<void> => {
    nextUnsubscribe?.();
    nextDetach?.();
    if (replacement && replacement.session !== activeSession.value) {
      await replacement.session.dispose();
    }
  };

  try {
    replacement = normalizeSessionHandle(await props.sessionFactory(note));
    if (
      !isCurrentHistoryRestore(restoreToken, expectedGeneration, expectedActiveNoteId, previous)
    ) {
      await disposeReplacement();
      return;
    }

    const nextSnapshot = replacement.session.snapshot();
    if (nextSnapshot.noteId !== expectedNoteId) throw new Error("Restored note mismatch");
    if (nextSnapshot.baseRevision !== expectedRevision)
      throw new Error("Invalid restored revision");
    if (nextSnapshot.markdown !== expectedMarkdown) throw new Error("Restored content mismatch");

    const nextSourceModeAdapter = createBookkeepingModeAdapter(nextSnapshot.markdown);
    const nextVisualModeAdapter = createStagedLiveModeAdapter(nextSnapshot.markdown);
    nextUnsubscribe = replacement.session.subscribe((state) => {
      if (historyRestoreToken === restoreToken && activeSession.value === replacement?.session) {
        sessionState.value = state;
      }
    });

    try {
      nextDetach = await replacement.session.attachModeAdapters({
        source: nextSourceModeAdapter,
        visual: nextVisualModeAdapter.adapter,
      });
    } catch {
      // Visual/Split stay unavailable when the replacement cannot attach its
      // adapters; Source still remains authoritative through session.edit().
      nextDetach = undefined;
    }

    if (
      !isCurrentHistoryRestore(restoreToken, expectedGeneration, expectedActiveNoteId, previous)
    ) {
      await disposeReplacement();
      return;
    }

    // Keep the old adapter pair and authority untouched until the replacement
    // has passed every async boundary above. The commit below is synchronous,
    // so a newer restore or note activation cannot interleave with the swap.
    previousDetach?.();
    nextVisualModeAdapter.commit();
    sourceModeAdapter = nextSourceModeAdapter;
    visualModeAdapter = nextVisualModeAdapter.adapter;
    activeSession.value = replacement.session;
    activeSessionContext.value = replacement.context;
    sessionState.value = nextSnapshot;
    unsubscribeSession = nextUnsubscribe;
    detachModeAdapters = nextDetach;
    committed = true;
    const noteToUpdate = notes.value.find((existing) => existing.id === note.id);
    if (noteToUpdate) noteToUpdate.markdown = expectedMarkdown;

    previousUnsubscribe?.();
    await previous.dispose();
  } catch {
    if (committed) return;
    await disposeReplacement();
    return;
  }
}

function isValidRevision(value: number): boolean {
  return Number.isInteger(value) && value > 0;
}

const commands = computed<WorkbenchCommand[]>(() => [
  {
    id: "toggle-mode",
    label: mode.value === "source" ? "Switch to Visual mode" : "Switch to Source mode",
    hint: "Mode",
    category: "format",
    run: toggleMode,
  },
  ...notes.value.map((note) => ({
    id: `open-${note.id}`,
    label: `Open "${note.title}"`,
    hint: "Note",
    category: "note",
    run: () => openNote(note.id),
  })),
  ...(activeNoteId.value
    ? [
        {
          id: "close-active-tab",
          label: `Close "${activeNote.value?.title ?? ""}"`,
          hint: "Tab",
          category: "note",
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
          category: "workspace",
          run: () => openPhase5Panel("assets"),
        },
        {
          id: "phase5-search",
          label: "Search notes",
          hint: "Workspace",
          category: "workspace",
          run: () => openPhase5Panel("search"),
        },
        {
          id: "phase5-transfer",
          label: "Import or export",
          hint: "Workspace",
          category: "workspace",
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
          category: "note",
          run: () => openPhase5Panel("share"),
        },
      ]
    : []),
]);

const blockCommands = computed<WorkbenchCommand[]>(() =>
  paletteOpen.value && slashRequest.value
    ? BLOCK_COMMANDS.map((definition) => materializeBlockCommand(definition, onBlockCommand))
    : [],
);
const paletteCommands = computed<WorkbenchCommand[]>(() =>
  slashRequest.value ? blockCommands.value : commands.value,
);

function onGlobalKeydown(event: KeyboardEvent): void {
  const isPaletteShortcut = (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k";
  if (isPaletteShortcut) {
    event.preventDefault();
    event.stopPropagation();
    paletteOpen.value ? closePalette() : openPalette();
  }
}

let compactMediaQuery: MediaQueryList | undefined;

function updateCompactScreen(): void {
  compactScreen.value = compactMediaQuery ? !compactMediaQuery.matches : false;
}

function onCompactScreenChange(): void {
  updateCompactScreen();
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
  activeSessionContext.value = undefined;
  sessionState.value = undefined;
  if (previous) await previous.dispose();
  if (generation !== sessionGeneration || !note || !props.sessionFactory) return;

  let nextValue: EditorSession | WorkbenchSessionHandle;
  try {
    nextValue = await props.sessionFactory(note);
  } catch {
    return;
  }
  const next = normalizeSessionHandle(nextValue);
  if (generation !== sessionGeneration) {
    await next.session.dispose();
    return;
  }

  activeSession.value = next.session;
  activeSessionContext.value = next.context;
  sessionState.value = next.session.snapshot();
  unsubscribeSession = next.session.subscribe((state) => {
    if (activeSession.value === next.session) sessionState.value = state;
  });

  const initialMarkdown = next.session.snapshot().markdown;
  visualMarkdown.value = initialMarkdown;
  visualEditorReadOnly.value = true;
  sourceModeAdapter = createBookkeepingModeAdapter(initialMarkdown);
  visualModeAdapter = createLiveModeAdapter(visualMarkdown, visualEditorReadOnly);
  try {
    const detach = await next.session.attachModeAdapters({
      source: sourceModeAdapter,
      visual: visualModeAdapter,
    });
    if (generation !== sessionGeneration || activeSession.value !== next.session) {
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

onMounted(() => {
  window.addEventListener("keydown", onGlobalKeydown, true);
  if (typeof window.matchMedia === "function") {
    compactMediaQuery = window.matchMedia("(min-width: 48rem)");
    updateCompactScreen();
    if (typeof compactMediaQuery.addEventListener === "function") {
      compactMediaQuery.addEventListener("change", onCompactScreenChange);
    } else {
      compactMediaQuery.addListener(onCompactScreenChange);
    }
  }
});
onBeforeUnmount(() => {
  window.removeEventListener("keydown", onGlobalKeydown, true);
  if (compactMediaQuery) {
    if (typeof compactMediaQuery.removeEventListener === "function") {
      compactMediaQuery.removeEventListener("change", onCompactScreenChange);
    } else {
      compactMediaQuery.removeListener(onCompactScreenChange);
    }
    compactMediaQuery = undefined;
  }
  sessionGeneration += 1;
  unsubscribeSession?.();
  unsubscribeSession = undefined;
  detachActiveModeAdapters();
  const session = activeSession.value;
  activeSession.value = undefined;
  activeSessionContext.value = undefined;
  sessionState.value = undefined;
  if (session) void session.dispose();
  releaseVisualAssetResolver?.();
  releaseVisualAssetResolver = undefined;
});
</script>

<style scoped>
.gq-workbench-body {
  position: relative;
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  background: var(--gq-canvas);
}

.gq-explorer-slot {
  min-width: 14rem;
  overflow: hidden;
}

.gq-editor-column {
  min-width: 0;
  background: var(--gq-canvas);
}

.gq-workbench-panel-toggles {
  display: none;
}

@media (max-width: 47.999rem) {
  .gq-workbench-body {
    display: block;
  }

  .gq-explorer-slot {
    position: absolute;
    inset-block: 0;
    left: 0;
    z-index: 30;
    width: min(88vw, 20rem);
    min-width: 0;
    background: var(--gq-surface);
    box-shadow: var(--gq-shadow-panel-left);
    transform: translateX(-105%);
    transition: transform 150ms var(--gq-easing-standard);
  }

  .gq-explorer-slot--open {
    transform: translateX(0);
  }

  .gq-workbench-panel-toggles {
    display: flex;
  }

  .gq-workbench-panel-toggle {
    min-height: 2rem;
  }
}

@media (prefers-reduced-motion: reduce) {
  .gq-explorer-slot {
    transition: none;
  }
}
</style>
