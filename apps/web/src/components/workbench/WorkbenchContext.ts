import { canonicalUuidSchema } from "@glyphquire/api-contract";
import { inject, provide, shallowReactive, toRef, type InjectionKey } from "vue";
import type { EditorSession, EditorSessionState } from "../../editors/editor-session.types.js";
import {
  createBookkeepingModeAdapter,
  createLiveModeAdapter,
  type WorkbenchModeAdapterShim,
} from "../../editors/WorkbenchModeAdapterShim.js";
import type {
  WorkbenchAccountAction,
  WorkbenchSessionFactory,
  WorkbenchSessionHandle,
  WorkbenchNote,
  WorkbenchEditorMode,
  WorkbenchPanel,
  WorkbenchToolPanel,
} from "./types.js";

export type { WorkbenchAccountAction } from "./types.js";

export interface WorkbenchHostContext {
  readonly sessionFactory?: WorkbenchSessionFactory;
  readonly workspaceId?: string;
  readonly workspaceName?: string;
  readonly accountLabel?: string;
  readonly onAccountAction?: (action: WorkbenchAccountAction) => void;
}

export const WORKBENCH_HOST_CONTEXT: InjectionKey<WorkbenchHostContext> =
  Symbol("gq-workbench-host");

const EMPTY_WORKBENCH_HOST_CONTEXT: WorkbenchHostContext = Object.freeze({});

export function provideWorkbenchHostContext(context: WorkbenchHostContext): void {
  provide(WORKBENCH_HOST_CONTEXT, context);
}

export function useWorkbenchHostContext(): WorkbenchHostContext {
  return inject(WORKBENCH_HOST_CONTEXT, EMPTY_WORKBENCH_HOST_CONTEXT);
}

export interface WorkbenchRouteLocation {
  readonly pathname: string;
  readonly search: string;
}

interface WorkbenchRouteContext {
  readonly workspaceId: string | null;
  readonly noteId: string | null;
}

export interface WorkbenchContextOptions {
  readonly initialNotes?: readonly WorkbenchNote[];
  readonly sessionFactory?: WorkbenchSessionFactory;
  readonly phase5WorkspaceId?: string;
  readonly phase5NoteId?: string;
  readonly workspaceName?: string;
  readonly accountLabel?: string;
  readonly route?: WorkbenchRouteLocation;
}

export interface WorkbenchOpenNoteOptions {
  readonly markdown?: string;
  readonly baseRevision?: number;
  readonly workspaceId?: string;
}

export interface WorkbenchContextSnapshot {
  readonly notes: readonly WorkbenchNote[];
  readonly openTabs: readonly WorkbenchNote[];
  readonly activeNote: WorkbenchNote | null;
  readonly activeNoteId: string | null;
  readonly workspaceId: string | null;
  readonly noteId: string | null;
  readonly workspaceName?: string;
  readonly accountLabel?: string;
  readonly phase5Panel: WorkbenchToolPanel | null;
  readonly explorerOpen: boolean;
  readonly contextRailOpen: boolean;
  readonly panel: WorkbenchPanel;
  readonly session?: EditorSession;
  readonly sessionState?: EditorSessionState;
  readonly sessionContext?: WorkbenchSessionHandle["context"];
  readonly mode: WorkbenchEditorMode;
  readonly sourceReadOnly: boolean;
  readonly visualMarkdown: string;
  readonly visualReadOnly: boolean;
  readonly sourceModeAdapter?: WorkbenchModeAdapterShim;
  readonly visualModeAdapter?: WorkbenchModeAdapterShim;
}

export interface WorkbenchContext {
  openNote(noteId: string, options?: WorkbenchOpenNoteOptions): void;
  closeNote(noteId: string): void;
  setPanel(panel: WorkbenchPanel): void;
  setMode(mode: WorkbenchEditorMode): Promise<void>;
  snapshot(): WorkbenchContextSnapshot;
  dispose(): Promise<void>;
}

/** Extracts only canonical identities from the current workbench route. */
export function parseWorkbenchRoute(locationLike?: WorkbenchRouteLocation): WorkbenchRouteContext {
  const source =
    locationLike ??
    (typeof window === "undefined"
      ? undefined
      : { pathname: window.location.pathname, search: window.location.search });
  if (!source) return { workspaceId: null, noteId: null };

  const workspaceMatch = /^\/workspace\/([^/]+)\/?$/u.exec(source.pathname);
  const workspaceCandidate = workspaceMatch?.[1];
  const noteCandidate = new URLSearchParams(source.search).get("noteId");
  return {
    workspaceId: canonicalUuidSchema.safeParse(workspaceCandidate).success
      ? workspaceCandidate!
      : null,
    noteId: canonicalUuidSchema.safeParse(noteCandidate).success ? noteCandidate : null,
  };
}

interface MutableWorkbenchContextSnapshot {
  notes: WorkbenchNote[];
  openTabs: WorkbenchNote[];
  activeNote: WorkbenchNote | null;
  activeNoteId: string | null;
  workspaceId: string | null;
  noteId: string | null;
  workspaceName?: string;
  accountLabel?: string;
  phase5Panel: WorkbenchToolPanel | null;
  explorerOpen: boolean;
  contextRailOpen: boolean;
  panel: WorkbenchPanel;
  session?: EditorSession;
  sessionState?: EditorSessionState;
  sessionContext?: WorkbenchSessionHandle["context"];
  mode: WorkbenchEditorMode;
  sourceReadOnly: boolean;
  visualMarkdown: string;
  visualReadOnly: boolean;
  sourceModeAdapter?: WorkbenchModeAdapterShim;
  visualModeAdapter?: WorkbenchModeAdapterShim;
}

const DEFAULT_NOTES: readonly WorkbenchNote[] = [
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
  { id: "scratch", title: "Scratch", markdown: "" },
];

function firstCanonicalUuid(...candidates: Array<string | null | undefined>): string | null {
  for (const candidate of candidates) {
    const parsed = canonicalUuidSchema.safeParse(candidate);
    if (parsed.success) return parsed.data;
  }
  return null;
}

function validRevision(value: number | undefined): boolean {
  return Number.isInteger(value) && (value ?? 0) > 0;
}

function normalizeSessionHandle(
  value: EditorSession | WorkbenchSessionHandle,
): WorkbenchSessionHandle {
  if (!("session" in value)) return { session: value };
  if (!value || !value.session) throw new Error("Workbench session factory returned no session");
  return value;
}

/**
 * Creates the one stateful workbench coordinator. The returned snapshot is a
 * stable reactive object so rendering code can project it without owning any
 * policy or lifecycle state.
 */
export function createWorkbenchContext(options: WorkbenchContextOptions = {}): WorkbenchContext {
  const route = parseWorkbenchRoute(options.route);
  const initialNotes = (options.initialNotes ?? DEFAULT_NOTES).map((note) => ({ ...note }));
  const initialNoteId = initialNotes[0]?.id ?? null;
  const initialNote = initialNoteId
    ? (initialNotes.find((note) => note.id === initialNoteId) ?? null)
    : null;
  const state = shallowReactive<MutableWorkbenchContextSnapshot>({
    notes: initialNotes,
    openTabs: initialNote ? [initialNote] : [],
    activeNote: initialNote,
    activeNoteId: initialNoteId,
    workspaceId: firstCanonicalUuid(
      options.phase5WorkspaceId,
      options.sessionFactory ? route.workspaceId : null,
    ),
    noteId: firstCanonicalUuid(options.phase5NoteId, initialNoteId, route.noteId),
    workspaceName: options.workspaceName,
    accountLabel: options.accountLabel,
    phase5Panel: null,
    explorerOpen: true,
    contextRailOpen: false,
    panel: null,
    sessionState: undefined,
    mode: "source",
    sourceReadOnly: true,
    visualMarkdown: "",
    visualReadOnly: true,
  });

  const visualMarkdownRef = toRef(state, "visualMarkdown");
  const visualReadOnlyRef = toRef(state, "visualReadOnly");
  let unsubscribeSession: (() => void) | undefined;
  let detachModeAdapters: (() => void) | undefined;
  let sessionGeneration = 0;
  let restoreGeneration = 0;
  let disposed = false;
  let disposePromise: Promise<void> | undefined;

  function activeNoteFor(id: string | null): WorkbenchNote | null {
    return id ? (state.notes.find((note) => note.id === id) ?? null) : null;
  }

  function refreshNoteProjection(): void {
    state.activeNote = activeNoteFor(state.activeNoteId);
    state.openTabs = state.openTabs
      .map((tab) => state.notes.find((note) => note.id === tab.id))
      .filter((note): note is WorkbenchNote => note !== undefined);
    state.noteId = firstCanonicalUuid(options.phase5NoteId, state.activeNoteId, route.noteId);
    if (state.sessionContext?.workspaceId) {
      state.workspaceId =
        firstCanonicalUuid(options.phase5WorkspaceId, state.sessionContext.workspaceId) ??
        state.workspaceId;
    }
  }

  function refreshSessionProjection(session: EditorSession | undefined): void {
    const nextState = session?.snapshot();
    state.sessionState = nextState;
    state.mode =
      nextState?.mode === "visual" || nextState?.mode === "split" ? nextState.mode : "source";
    state.sourceReadOnly = !nextState || nextState.readOnly || nextState.activePane !== "source";
  }

  function detachActiveAdapters(): void {
    detachModeAdapters?.();
    detachModeAdapters = undefined;
    state.sourceModeAdapter = undefined;
    state.visualModeAdapter = undefined;
    state.visualMarkdown = "";
    state.visualReadOnly = true;
  }

  function clearActiveSession(): EditorSession | undefined {
    const previous = state.session;
    unsubscribeSession?.();
    unsubscribeSession = undefined;
    detachActiveAdapters();
    state.session = undefined;
    state.sessionContext = undefined;
    refreshSessionProjection(undefined);
    return previous;
  }

  function updateWorkspaceProjection(context: WorkbenchSessionHandle["context"]): void {
    state.sessionContext = context;
    state.workspaceName = context?.workspaceName ?? options.workspaceName;
    state.accountLabel = context?.accountLabel ?? options.accountLabel;
    state.workspaceId = firstCanonicalUuid(
      options.phase5WorkspaceId,
      context?.workspaceId,
      options.sessionFactory ? route.workspaceId : null,
    );
  }

  async function attachSession(
    session: EditorSession,
    generation: number,
    initialMarkdown: string,
  ): Promise<{
    source: WorkbenchModeAdapterShim;
    visual: WorkbenchModeAdapterShim;
    detach: (() => void) | undefined;
  }> {
    const source = createBookkeepingModeAdapter(initialMarkdown);
    const visual = createLiveModeAdapter(visualMarkdownRef, visualReadOnlyRef);
    try {
      const detach = await session.attachModeAdapters({ source, visual });
      if (disposed || generation !== sessionGeneration) {
        detach();
        await session.dispose();
        throw new Error("Stale workbench session activation");
      }
      return { source, visual, detach };
    } catch (error) {
      if (disposed || generation !== sessionGeneration) throw error;
      return { source, visual, detach: undefined };
    }
  }

  async function activateSession(note: WorkbenchNote | null): Promise<void> {
    const generation = ++sessionGeneration;
    const previous = clearActiveSession();
    if (previous) await previous.dispose();
    if (disposed || generation !== sessionGeneration || !note || !options.sessionFactory) return;

    let next: WorkbenchSessionHandle;
    try {
      next = normalizeSessionHandle(await options.sessionFactory(note));
    } catch {
      return;
    }
    if (disposed || generation !== sessionGeneration) {
      await next.session.dispose();
      return;
    }

    state.session = next.session;
    updateWorkspaceProjection(next.context);
    refreshSessionProjection(next.session);
    unsubscribeSession = next.session.subscribe(() => {
      if (state.session !== next.session || disposed) return;
      refreshSessionProjection(next.session);
    });
    const initialMarkdown = next.session.snapshot().markdown;
    state.visualMarkdown = initialMarkdown;
    state.visualReadOnly = true;
    try {
      const attached = await attachSession(next.session, generation, initialMarkdown);
      if (state.session !== next.session || disposed || generation !== sessionGeneration) {
        attached.detach?.();
        await next.session.dispose();
        return;
      }
      state.sourceModeAdapter = attached.source;
      state.visualModeAdapter = attached.visual;
      detachModeAdapters = attached.detach;
    } catch {
      if (state.session === next.session && !disposed && generation === sessionGeneration) {
        state.sourceModeAdapter = undefined;
        state.visualModeAdapter = undefined;
      }
    }
  }

  async function replaceActiveSession(
    note: WorkbenchNote,
    expectedRevision: number,
    expectedWorkspaceId: string,
  ): Promise<void> {
    const previous = state.session;
    if (!previous || state.activeNoteId !== note.id || state.workspaceId !== expectedWorkspaceId)
      return;
    const generation = sessionGeneration;
    const token = ++restoreGeneration;
    const previousUnsubscribe = unsubscribeSession;
    const previousDetach = detachModeAdapters;
    let replacement: WorkbenchSessionHandle | undefined;
    let nextUnsubscribe: (() => void) | undefined;
    let nextDetach: (() => void) | undefined;
    let committed = false;

    const stale = (): boolean =>
      disposed ||
      restoreGeneration !== token ||
      sessionGeneration !== generation ||
      state.activeNoteId !== note.id ||
      state.session !== previous;

    const disposeReplacement = async (): Promise<void> => {
      nextUnsubscribe?.();
      nextDetach?.();
      const candidate = replacement;
      if (candidate && candidate.session !== state.session) await candidate.session.dispose();
    };

    try {
      if (!options.sessionFactory) return;
      replacement = normalizeSessionHandle(await options.sessionFactory(note));
      if (stale()) {
        await disposeReplacement();
        return;
      }
      const nextSnapshot = replacement.session.snapshot();
      if (
        nextSnapshot.noteId !== note.id ||
        nextSnapshot.baseRevision !== expectedRevision ||
        nextSnapshot.markdown !== note.markdown
      ) {
        throw new Error("Restored session does not match the authoritative note");
      }

      const nextSource = createBookkeepingModeAdapter(nextSnapshot.markdown);
      const stagedVisual = createStagedLiveModeAdapter(
        nextSnapshot.markdown,
        visualMarkdownRef,
        visualReadOnlyRef,
      );
      const replacementSession = replacement.session;
      nextUnsubscribe = replacement.session.subscribe(() => {
        if (state.session === replacementSession && restoreGeneration === token) {
          refreshSessionProjection(replacementSession);
        }
      });
      try {
        nextDetach = await replacement.session.attachModeAdapters({
          source: nextSource,
          visual: stagedVisual.adapter,
        });
      } catch {
        nextDetach = undefined;
      }
      if (stale()) {
        await disposeReplacement();
        return;
      }

      previousDetach?.();
      stagedVisual.commit();
      state.sourceModeAdapter = nextSource;
      state.visualModeAdapter = stagedVisual.adapter;
      state.session = replacement.session;
      updateWorkspaceProjection(replacement.context);
      refreshSessionProjection(replacement.session);
      unsubscribeSession = nextUnsubscribe;
      detachModeAdapters = nextDetach;
      committed = true;
      state.notes = state.notes.map((existing) =>
        existing.id === note.id ? { ...existing, markdown: note.markdown } : existing,
      );
      refreshNoteProjection();
      previousUnsubscribe?.();
      await previous.dispose();
    } catch {
      if (committed) return;
      await disposeReplacement();
    }
  }

  function openNote(noteId: string, openOptions?: WorkbenchOpenNoteOptions): void {
    if (disposed) return;
    const note = activeNoteFor(noteId);
    if (!note) return;
    if (!state.openTabs.some((tab) => tab.id === noteId)) {
      state.openTabs = [...state.openTabs, note];
    }
    if (openOptions?.markdown !== undefined) {
      if (!validRevision(openOptions.baseRevision) || !openOptions.workspaceId) return;
      const workspaceId = firstCanonicalUuid(openOptions.workspaceId);
      if (!workspaceId) return;
      void replaceActiveSession(
        { ...note, markdown: openOptions.markdown },
        openOptions.baseRevision!,
        workspaceId,
      );
      return;
    }
    if (state.activeNoteId === noteId) return;
    state.activeNoteId = noteId;
    refreshNoteProjection();
    void activateSession(state.activeNote);
  }

  function closeNote(noteId: string): void {
    if (disposed || !state.openTabs.some((tab) => tab.id === noteId)) return;
    const remaining = state.openTabs.filter((tab) => tab.id !== noteId);
    state.openTabs = remaining;
    if (state.activeNoteId !== noteId) return;
    state.activeNoteId = remaining.length > 0 ? remaining[remaining.length - 1]!.id : null;
    refreshNoteProjection();
    void activateSession(state.activeNote);
  }

  function setPanel(panel: WorkbenchPanel): void {
    if (disposed) return;
    if (panel === null) {
      state.phase5Panel = null;
      state.contextRailOpen = false;
      state.panel = null;
      return;
    }
    if (panel === "explorer") {
      state.explorerOpen = !state.explorerOpen;
      state.panel = state.explorerOpen ? "explorer" : null;
      return;
    }
    if (panel === "context") {
      state.contextRailOpen = !state.contextRailOpen;
      state.phase5Panel = null;
      state.panel = state.contextRailOpen ? "context" : null;
      return;
    }
    if (!state.workspaceId) return;
    if (panel === "history") {
      const revision = state.sessionState?.baseRevision;
      if (!state.noteId || !validRevision(revision)) return;
    }
    if (panel === "share" && (!state.noteId || state.sessionState?.readOnly)) return;
    state.phase5Panel = panel;
    state.contextRailOpen = false;
    state.panel = panel;
  }

  async function setMode(nextMode: WorkbenchEditorMode): Promise<void> {
    const session = state.session;
    if (!session || disposed) return;
    try {
      await session.switchMode(nextMode);
    } catch {
      return;
    }
    if (state.session === session && !disposed) refreshSessionProjection(session);
  }

  async function dispose(): Promise<void> {
    if (disposePromise) return disposePromise;
    disposed = true;
    sessionGeneration += 1;
    restoreGeneration += 1;
    const session = clearActiveSession();
    disposePromise = session ? session.dispose() : Promise.resolve();
    await disposePromise;
  }

  refreshNoteProjection();
  void activateSession(state.activeNote);

  return {
    openNote,
    closeNote,
    setPanel,
    setMode,
    snapshot(): WorkbenchContextSnapshot {
      return state;
    },
    dispose,
  };
}

function createStagedLiveModeAdapter(
  initialMarkdown: string,
  markdownRef: { value: string },
  readOnlyRef: { value: boolean },
): { adapter: WorkbenchModeAdapterShim; commit: () => void } {
  let markdown = initialMarkdown;
  let readOnly = true;
  let committed = false;
  const listeners = new Set<(nextMarkdown: string) => void>();

  const syncFromUi = (nextMarkdown: string, notify: boolean): void => {
    markdown = nextMarkdown;
    if (committed) markdownRef.value = nextMarkdown;
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
        return committed ? markdownRef.value : markdown;
      },
      setReadOnly(nextReadOnly: boolean): void {
        readOnly = nextReadOnly;
        if (committed) readOnlyRef.value = nextReadOnly;
      },
      onChange(listener: (nextMarkdown: string) => void): () => void {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      syncFromUi,
    },
    commit(): void {
      committed = true;
      markdownRef.value = markdown;
      readOnlyRef.value = readOnly;
    },
  };
}
