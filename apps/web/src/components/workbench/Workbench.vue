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
          @search="() => openToolPanel('search')"
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
            @click="workbenchContext.setPanel('explorer')"
          >
            Explorer
          </button>
          <button
            type="button"
            class="gq-workbench-panel-toggle rounded border border-gray-300 px-2 py-1 text-xs text-gray-700"
            aria-label="Open context tools"
            aria-controls="context-rail"
            :aria-expanded="contextRailOpen"
            @click="workbenchContext.setPanel('context')"
          >
            Context
          </button>
        </div>
        <EditorTabs
          :tabs="openTabs"
          :active-tab-id="activeNoteId"
          @select="openNote"
          @close="workbenchContext.closeNote"
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
        :current-revision="baseRevision"
        :read-only="sessionState?.readOnly ?? true"
        @close="workbenchContext.setPanel(null)"
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
      v-if="toolPanel && currentWorkspaceId"
      class="fixed inset-0 z-40 flex items-start justify-center bg-black/30 p-8 pt-20"
      @click.self="closeToolPanel"
      @keydown.escape="closeToolPanel"
    >
      <div
        ref="toolPanelRef"
        role="dialog"
        aria-modal="true"
        :aria-label="toolPanelLabel"
        class="max-h-[80vh] w-full max-w-2xl overflow-auto rounded-lg bg-white p-4 shadow-xl"
      >
        <button
          ref="toolPanelCloseRef"
          type="button"
          class="mb-3 rounded border border-gray-300 px-2 py-1 text-sm"
          aria-label="Close tools"
          @click="closeToolPanel"
        >
          Close tools
        </button>
        <AssetManager
          v-if="toolPanel === 'assets'"
          :workspace-id="currentWorkspaceId"
          @reference="insertAssetReference"
        />
        <SearchPalette
          v-else-if="toolPanel === 'search'"
          :workspace-id="currentWorkspaceId"
          @select-note="selectSearchResult"
        />
        <TransferDialog
          v-else-if="toolPanel === 'transfer'"
          :workspace-id="currentWorkspaceId"
          :note-id="currentNoteId ?? undefined"
          :base-revision="baseRevision ?? undefined"
        />
        <ShareLinkDialog
          v-else-if="toolPanel === 'share' && currentNoteId"
          :note-id="currentNoteId"
        />
        <VersionHistory
          v-else-if="toolPanel === 'history' && currentNoteId"
          :note-id="currentNoteId"
          :current-revision="baseRevision"
          @restored="onHistoryRestored"
        />
        <SharedLinksPanel
          v-else-if="toolPanel === 'shared-links'"
          :links="workspaceToolsStore.shareLinks"
          @open="onSharedLinkOpen"
          @revoke="onSharedLinkRevoke"
        />
        <CustomBlocksPanel
          v-else-if="toolPanel === 'custom-blocks'"
          :workspace-id="currentWorkspaceId"
          @close="closeToolPanel"
          @insert="insertCustomBlock"
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

    <ThemeEditorPanel
      v-if="themeStore.editorOpen"
      :workspace-id="currentWorkspaceId ?? undefined"
      @close="themeStore.closeEditor()"
    />
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
import TopBar from "./TopBar.vue";
import SourceEditor from "../source/SourceEditor.vue";
import VisualEditor from "../visual/VisualEditor.vue";
import SplitEditor from "../split/SplitEditor.vue";
import ThemeEditorPanel from "../theme-editor/ThemeEditorPanel.vue";
import CustomBlocksPanel from "../custom-blocks/CustomBlocksPanel.vue";
import AssetManager from "../assets/AssetManager.vue";
import SearchPalette from "../search/SearchPalette.vue";
import TransferDialog from "../transfer/TransferDialog.vue";
import ShareLinkDialog from "../share/ShareLinkDialog.vue";
import SharedLinksPanel from "../share/SharedLinksPanel.vue";
import VersionHistory from "../history/VersionHistory.vue";
import { useThemeStore } from "../../stores/theme.js";
import { useCustomBlocksStore } from "../../stores/custom-blocks.js";
import { useWorkspaceToolsStore } from "../../stores/workspace-tools.js";
import type { NoteResult } from "@glyphquire/api-contract";
import type { EditorSessionState } from "../../editors/editor-session.types.js";
import type {
  WorkbenchCommand,
  ContextAction,
  OutlineEntry,
  WorkbenchAccountAction,
  WorkbenchEditorMode,
  WorkbenchNote,
  WorkbenchToolPanel,
  WorkbenchSessionFactory,
  WorkbenchConflictContext,
  WorkbenchConflictRecovery,
  WorkbenchSaveState,
  ToolbarAction,
  WorkbenchEditorHandle,
  SlashCommandRequest,
} from "./types.js";
import { createWorkbenchContext } from "./WorkbenchContext.js";
import {
  BLOCK_COMMANDS,
  materializeBlockCommand,
  type BlockCommandDefinition,
} from "./markdown-format.js";
import {
  createAssetResolver,
  registerVisualAssetResolver,
} from "../../editors/visual/asset-resolver.js";
import { trapFocus, type FocusTrapHandle } from "../../lib/focusTrap.js";

const themeStore = useThemeStore();
const customBlocksStore = useCustomBlocksStore();
const workspaceToolsStore = useWorkspaceToolsStore();

const props = defineProps<{
  initialNotes?: readonly WorkbenchNote[];
  sessionFactory?: WorkbenchSessionFactory;
  workspaceId?: string;
  noteId?: string;
  workspaceName?: string;
  accountLabel?: string;
}>();

const emit = defineEmits<{
  "account-action": [action: WorkbenchAccountAction];
  "request-conflict-recovery": [entry: WorkbenchConflictRecovery];
}>();

const workbenchContext = createWorkbenchContext({
  initialNotes: props.initialNotes,
  sessionFactory: props.sessionFactory,
  workspaceId: props.workspaceId,
  noteId: props.noteId,
  workspaceName: props.workspaceName,
  accountLabel: props.accountLabel,
});
const workbenchState = workbenchContext.snapshot();

const notes = computed(() => workbenchState.notes);
const openTabs = computed<WorkbenchNote[]>(() =>
  workbenchState.openTabs.map((tab) => ({ ...tab })),
);
const activeNote = computed(() => workbenchState.activeNote);
const activeNoteId = computed(() => workbenchState.activeNoteId);
const currentWorkspaceId = computed(() => workbenchState.workspaceId);
const currentNoteId = computed(() => workbenchState.noteId);
const baseRevision = computed<number | null>(() => {
  const revision = workbenchState.sessionState?.baseRevision;
  return Number.isInteger(revision) && (revision ?? 0) > 0 ? revision! : null;
});
const toolPanel = computed(() => workbenchState.toolPanel);
const toolPanelRef = ref<HTMLElement | null>(null);
const toolPanelCloseRef = ref<HTMLButtonElement | null>(null);
let toolPanelTrap: FocusTrapHandle | undefined;
const toolPanelLabel = computed(() => {
  switch (toolPanel.value) {
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
    case "custom-blocks":
      return "Custom Blocks";
    default:
      return "Tools";
  }
});
let releaseVisualAssetResolver: (() => void) | undefined;
if (currentWorkspaceId.value) {
  releaseVisualAssetResolver = registerVisualAssetResolver(
    createAssetResolver({ workspaceId: currentWorkspaceId.value }),
  );
}

const paletteOpen = ref(false);
const paletteInitialQuery = ref<string | undefined>();
const paletteCategoryFilter = ref<WorkbenchCommand["category"]>();
const explorerOpen = computed(() => workbenchState.explorerOpen);
const contextRailOpen = computed(() => workbenchState.contextRailOpen);
const compactScreen = ref(false);
const topBarRef = ref<InstanceType<typeof TopBar> | null>(null);
const sourceEditorRef = ref<WorkbenchEditorHandle | null>(null);
const visualEditorRef = ref<WorkbenchEditorHandle | null>(null);
const splitEditorRef = ref<WorkbenchEditorHandle | null>(null);
const activeSession = computed(() => workbenchState.session);
const sessionState = computed(() => workbenchState.sessionState);
const visualMarkdown = computed(() => workbenchState.visualMarkdown);
const sourceModeAdapter = computed(() => workbenchState.sourceModeAdapter);
const visualModeAdapter = computed(() => workbenchState.visualModeAdapter);

const activeMarkdown = computed(
  () => sessionState.value?.markdown ?? activeNote.value?.markdown ?? "",
);
// Source's own pane is writable only while it is also the session's active
// pane — in "source" mode that is always true, so this is exactly the prior
// behavior; in "split" mode it correctly yields to whichever pane was active
// before split was entered.
const sourceReadOnly = computed(() => workbenchState.sourceReadOnly);
const visualReadOnly = computed(() => workbenchState.visualReadOnly);
const mode = computed<WorkbenchEditorMode>(() => workbenchState.mode);

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

const workspaceAvailable = computed(() => currentWorkspaceId.value !== null);
const effectiveWorkspaceName = computed(() => workbenchState.workspaceName ?? props.workspaceName);
const effectiveAccountLabel = computed(() => workbenchState.accountLabel ?? props.accountLabel);

const activeConflictContext = computed<WorkbenchConflictContext | undefined>(() => {
  const context = workbenchState.sessionContext;
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
    const marker = match[1];
    const rawLabel = match[2];
    if (!marker || rawLabel === undefined) continue;
    const depth = marker.length as 1 | 2 | 3;
    const label = rawLabel.trim();
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
  workbenchContext.openNote(noteId);
}

function onMarkdownChange(markdown: string): void {
  const session = activeSession.value;
  if (!session || sourceReadOnly.value) return;
  // Bookkeeping only: this shim never routes edits on its own (see
  // WorkbenchModeAdapterShim), so session.edit() below remains the single
  // path that actually applies a Source edit.
  sourceModeAdapter.value?.syncFromUi(markdown, false);
  session.edit(markdown);
}

function onVisualMarkdownChange(markdown: string): void {
  if (visualReadOnly.value) return;
  // Notifying routes this through EditorSession's own onAdapterChange
  // listener, which calls session.edit() for us — Visual has no separate
  // display path, so this is the only place that edit can originate.
  visualModeAdapter.value?.syncFromUi(markdown, true);
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
  void workbenchContext.setMode(nextMode);
}

function onAccountAction(action: WorkbenchAccountAction): void {
  emit("account-action", action);
}

function onContextAction(action: Exclude<ContextAction, "outline">): void {
  workbenchContext.setPanel(action);
}

function onSharedLinks(): void {
  openToolPanel("shared-links");
}

function onSharedLinkOpen(noteId: string): void {
  if (notes.value.some((note) => note.id === noteId)) openNote(noteId);
  closeToolPanel();
}

async function onSharedLinkRevoke(linkId: string): Promise<void> {
  try {
    await workspaceToolsStore.revokeShareLink(linkId);
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
  const toolPanelWasOpened = workbenchState.toolPanel !== null;
  paletteOpen.value = false;
  slashRequest.value = null;
  paletteInitialQuery.value = undefined;
  paletteCategoryFilter.value = undefined;
  if (toolPanelWasOpened) {
    void nextTick(() => {
      void nextTick(() => toolPanelCloseRef.value?.focus());
    });
    return;
  }
  const paletteButton = topBarRef.value?.$el?.querySelector('[aria-label="Open command palette"]');
  if (paletteButton instanceof HTMLElement) paletteButton.focus();
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
    // The session publishes this edit through WorkbenchContext.
  }
  closePalette();
}

function serializeCustomBlock(
  record: import("@glyphquire/api-contract").CustomBlockRecord,
): string {
  const attributes = Object.entries(record.definition.propsSchema)
    .filter(([, descriptor]) => descriptor.default !== undefined)
    .map(
      ([name, descriptor]) =>
        `${name}="${String(descriptor.default).replace(/[\\"]/gu, (character) => `\\${character}`)}"`,
    );
  const opening = `:::${record.name}{version="${record.version}"${attributes.length ? ` ${attributes.join(" ")}` : ""}}`;
  return record.definition.contentPolicy === "none" ? `${opening}\n:::` : `${opening}\n\n:::`;
}

function openToolPanel(panel: WorkbenchToolPanel): void {
  workbenchContext.setPanel(panel);
}

function closeToolPanel(): void {
  toolPanelTrap?.release();
  toolPanelTrap = undefined;
  workbenchContext.setPanel(null);
}

function insertAssetReference(reference: string): void {
  const session = activeSession.value;
  if (!session || session.snapshot().readOnly) return;
  const markdown = session.snapshot().markdown;
  const separator = markdown.endsWith("\n") || markdown.length === 0 ? "" : "\n";
  session.edit(`${markdown}${separator}\n![Asset](${reference})\n`);
  closeToolPanel();
}

function insertCustomBlock(markdown: string): void {
  const session = activeSession.value;
  if (!session || session.snapshot().readOnly) return;
  const current = session.snapshot().markdown;
  const separator = current.endsWith("\n") || current.length === 0 ? "" : "\n";
  session.edit(`${current}${separator}\n${markdown}\n`);
  closeToolPanel();
}

function selectSearchResult(noteId: string): void {
  if (notes.value.some((note) => note.id === noteId)) openNote(noteId);
  closeToolPanel();
}

async function onHistoryRestored(result: NoteResult): Promise<void> {
  const currentNote = activeNote.value;
  const expectedNoteId = currentNoteId.value;
  if (
    !currentNote ||
    !expectedNoteId ||
    result.id !== expectedNoteId ||
    result.id !== currentNote.id ||
    result.workspaceId !== currentWorkspaceId.value
  )
    return;
  const expectedMarkdown = result.contentMarkdown;
  const expectedRevision = result.revision;
  if (!isValidRevision(expectedRevision) || !currentWorkspaceId.value) return;
  workbenchContext.openNote(result.id, {
    markdown: expectedMarkdown,
    baseRevision: expectedRevision,
    workspaceId: currentWorkspaceId.value,
  });
}

function isValidRevision(value: number): boolean {
  return Number.isInteger(value) && value > 0;
}

const commands = computed<WorkbenchCommand[]>(() => {
  const result: WorkbenchCommand[] = [
    {
      id: "toggle-mode",
      label: mode.value === "source" ? "Switch to Visual mode" : "Switch to Source mode",
      hint: "Mode",
      category: "format",
      run: toggleMode,
    },
    ...notes.value.map((note): WorkbenchCommand => ({
      id: `open-${note.id}`,
      label: `Open "${note.title}"`,
      hint: "Note",
      category: "note",
      run: () => openNote(note.id),
    })),
  ];
  if (activeNoteId.value) {
    result.push({
      id: "close-active-tab",
      label: `Close "${activeNote.value?.title ?? ""}"`,
      hint: "Tab",
      category: "note",
      run: () => workbenchContext.closeNote(activeNoteId.value as string),
    });
  }
  if (currentWorkspaceId.value) {
    result.push(
      {
        id: "tools-assets",
        label: "Manage assets",
        hint: "Workspace",
        category: "workspace",
        run: () => openToolPanel("assets"),
      },
      {
        id: "tools-custom-blocks",
        label: "Manage Custom Blocks",
        hint: "Workspace",
        category: "workspace",
        run: () => openToolPanel("custom-blocks"),
      },
      {
        id: "tools-search",
        label: "Search notes",
        hint: "Workspace",
        category: "workspace",
        run: () => openToolPanel("search"),
      },
      {
        id: "tools-transfer",
        label: "Import or export",
        hint: "Workspace",
        category: "workspace",
        run: () => openToolPanel("transfer"),
      },
    );
  }
  if (currentWorkspaceId.value && currentNoteId.value) {
    result.push({
      id: "tools-share",
      label: "Create read-only share link",
      hint: "Note",
      category: "note",
      run: () => openToolPanel("share"),
    });
  }
  return result;
});

const blockCommands = computed<WorkbenchCommand[]>(() =>
  paletteOpen.value && slashRequest.value
    ? [
        ...BLOCK_COMMANDS,
        ...customBlocksStore.definitions
          .filter((record) => record.status === "published")
          .map((record) => ({
            id: `custom-block-${record.id}`,
            label: record.name,
            category: "block" as const,
            markdown: serializeCustomBlock(record),
            cursorOffset: 0,
          })),
      ].map((definition) => materializeBlockCommand(definition, onBlockCommand))
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

function syncToolPanelTrap(): void {
  toolPanelTrap?.release();
  toolPanelTrap = undefined;
  if (!toolPanel.value) return;
  void nextTick(() => {
    if (toolPanel.value && toolPanelRef.value) {
      toolPanelTrap = trapFocus(toolPanelRef.value, toolPanelCloseRef.value);
    }
  });
}

watch(toolPanel, syncToolPanelTrap, { flush: "post" });
watch(
  currentWorkspaceId,
  (workspaceId) => {
    if (workspaceId) void customBlocksStore.load(workspaceId).catch(() => undefined);
  },
  { immediate: true },
);

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
  toolPanelTrap?.release();
  toolPanelTrap = undefined;
  window.removeEventListener("keydown", onGlobalKeydown, true);
  if (compactMediaQuery) {
    if (typeof compactMediaQuery.removeEventListener === "function") {
      compactMediaQuery.removeEventListener("change", onCompactScreenChange);
    } else {
      compactMediaQuery.removeListener(onCompactScreenChange);
    }
    compactMediaQuery = undefined;
  }
  void workbenchContext.dispose();
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
