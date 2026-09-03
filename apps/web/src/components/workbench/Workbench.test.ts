import { config, flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { StateEffect } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { defineComponent, h, nextTick } from "vue";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NoteConflict } from "@glyphquire/api-contract";
import Workbench from "./Workbench.vue";
import EditorTabs from "./EditorTabs.vue";
import StatusBar from "./StatusBar.vue";
import TopBar from "./TopBar.vue";
import type {
  EditorModeAdapters,
  EditorSession,
  EditorSessionState,
} from "../../editors/editor-session.types.js";
import type { WorkbenchModeAdapterShim } from "../../editors/WorkbenchModeAdapterShim.js";
import type { NoteResult } from "@glyphquire/api-contract";

const NOTE_ID = "44444444-4444-4444-8444-444444444444";
const OTHER_NOTE_ID = "55555555-5555-4555-8555-555555555555";
const USER_ID = "11111111-1111-4111-8111-111111111111";
const WORKSPACE_ID = "22222222-2222-4222-8222-222222222222";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function state(overrides: Partial<EditorSessionState> = {}): EditorSessionState {
  return {
    noteId: NOTE_ID,
    markdown: "# server markdown",
    baseRevision: 1,
    dirty: false,
    saveStatus: "clean",
    conflict: null,
    mode: "source",
    activePane: "source",
    diagnostics: [],
    readOnly: false,
    isReadOnly: false,
    draftDurability: "persisted",
    draftDurabilityError: null,
    autosave: {
      status: "clean",
      revision: 1,
      lastSavedAt: null,
      lastError: null,
      conflict: null,
      pending: null,
    },
    ...overrides,
  };
}

function fakeSession(initialState = state(), attachModeAdapters = vi.fn(async () => () => {})) {
  let current = initialState;
  const listeners = new Set<(next: EditorSessionState) => void>();
  const edit = vi.fn((markdown: string) => {
    current = { ...current, markdown, dirty: true, saveStatus: "dirty" };
    for (const listener of listeners) listener(current);
  });
  const session: EditorSession = {
    snapshot: () => current,
    edit,
    switchMode: vi.fn(async () => ({ success: true, mode: "source" as const })),
    attachModeAdapters,
    saveNow: vi.fn(async () => undefined),
    requestTakeover: vi.fn(async () => false),
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispose: vi.fn(async () => undefined),
  };
  return {
    session,
    edit,
    emit(next: EditorSessionState): void {
      current = next;
      for (const listener of listeners) listener(next);
    },
  };
}

function noteResult(overrides: Partial<NoteResult> = {}): NoteResult {
  return {
    id: NOTE_ID,
    workspaceId: "33333333-3333-4333-8333-333333333333",
    title: "Authorized",
    revision: 2,
    visibility: "private",
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
    deletedAt: null,
    contentMarkdown: "# Restored",
    schemaVersion: 1,
    ...overrides,
  };
}

function conflictFixture(): NoteConflict {
  return {
    code: "REVISION_CONFLICT",
    noteId: NOTE_ID,
    serverRevision: 2,
    serverMarkdown: "# Server version",
    serverUpdatedAt: "2026-08-01T00:00:00.000Z",
    lastEditedBy: null,
    requestId: "task4-conflict",
  };
}

const SourceEditorStub = defineComponent({
  name: "SourceEditor",
  props: {
    markdown: { type: String, required: true },
    readOnly: { type: Boolean, default: false },
  },
  emits: ["update:markdown"],
  setup(props, { emit }) {
    return () =>
      h(
        "div",
        {
          "data-testid": "session-source",
          contenteditable: String(!props.readOnly),
          onInput: (event: Event) =>
            emit("update:markdown", (event.target as HTMLElement).textContent ?? ""),
        },
        props.markdown,
      );
  },
});

const VisualEditorStub = defineComponent({
  name: "VisualEditor",
  props: {
    markdown: { type: String, required: true },
    readOnly: { type: Boolean, default: false },
  },
  emits: ["update:markdown"],
  setup(props, { emit }) {
    return () =>
      h(
        "div",
        {
          "data-testid": "session-visual",
          contenteditable: String(!props.readOnly),
          onInput: (event: Event) =>
            emit("update:markdown", (event.target as HTMLElement).textContent ?? ""),
        },
        props.markdown,
      );
  },
});

const notes = [{ id: NOTE_ID, title: "Authorized", markdown: "untrusted seed" }];

describe("Workbench EditorSession composition", () => {
  beforeEach(() => {
    const pinia = createPinia();
    setActivePinia(pinia);
    config.global.plugins = [pinia];
  });

  it("marks active navigation mode, tab, and status surfaces with semantic hooks", () => {
    const topBar = mount(TopBar, {
      props: { noteTitle: "Field notes", mode: "source" },
    });
    expect(topBar.get("header").classes()).toContain("gq-topbar");
    expect(topBar.get('[role="radio"][aria-checked="true"]').attributes("data-active")).toBe(
      "true",
    );

    const tabs = mount(EditorTabs, {
      props: {
        tabs: [{ id: NOTE_ID, title: "Field notes", markdown: "# Notes" }],
        activeTabId: NOTE_ID,
      },
    });
    expect(tabs.get('[role="tab"][aria-selected="true"]').attributes("data-active")).toBe("true");

    const status = mount(StatusBar, {
      props: {
        noteTitle: "Field notes",
        mode: "source",
        wordCount: 2,
        saveState: "saved",
      },
    });
    expect(status.get("footer").classes()).toContain("gq-statusbar");
  });

  it("surfaces save failures, retries the active session, and leaves conflicts read-only without identity", async () => {
    const authority = fakeSession();
    const sessionFactory = vi.fn(async () => authority.session);
    const wrapper = mount(Workbench, {
      props: { initialNotes: notes, sessionFactory },
      global: { stubs: { SourceEditor: SourceEditorStub } },
    });
    await flushPromises();

    authority.emit(state({ dirty: true, saveStatus: "error" }));
    await nextTick();

    const errorBanner = wrapper.get('[data-save-state="error"]');
    expect(errorBanner.attributes("role")).toBe("alert");
    expect(errorBanner.text()).toContain("couldn't save");
    await errorBanner.get('button[aria-label="Retry save"]').trigger("click");
    expect(authority.session.saveNow).toHaveBeenCalledOnce();

    authority.emit(state({ saveStatus: "conflict", conflict: conflictFixture() }));
    await nextTick();

    const conflictBanner = wrapper.get('[data-save-state="conflict"]');
    expect(conflictBanner.text()).toContain("Another version was saved");
    expect(conflictBanner.find('button[aria-label="Open conflict recovery"]').exists()).toBe(false);
    expect(conflictBanner.find('button[aria-label="Retry save"]').exists()).toBe(false);
    wrapper.unmount();
  });

  it("marks the active tab dirty in EditorTabs when the save state is dirty", async () => {
    const authority = fakeSession();
    const sessionFactory = vi.fn(async () => authority.session);
    const wrapper = mount(Workbench, {
      props: { initialNotes: notes, sessionFactory },
      global: { stubs: { SourceEditor: SourceEditorStub } },
    });
    await flushPromises();

    expect(wrapper.find(".gq-editor-tabs__dirty-dot").exists()).toBe(false);

    authority.emit(state({ dirty: true, saveStatus: "dirty" }));
    await nextTick();

    const activeTab = wrapper.get('.gq-editor-tabs [role="tab"][aria-selected="true"]');
    expect(activeTab.get(".gq-editor-tabs__dirty-dot").attributes("aria-label")).toBe(
      "unsaved changes",
    );

    authority.emit(state({ saveStatus: "clean" }));
    await nextTick();
    expect(wrapper.find(".gq-editor-tabs__dirty-dot").exists()).toBe(false);

    wrapper.unmount();
  });

  it("emits conflict recovery with identity from a validated session handle", async () => {
    const authority = fakeSession(state({ saveStatus: "conflict", conflict: conflictFixture() }));
    const sessionFactory = vi.fn(async () => ({
      session: authority.session,
      context: { userId: USER_ID, workspaceId: WORKSPACE_ID },
    }));
    const wrapper = mount(Workbench, {
      props: { initialNotes: notes, sessionFactory },
      global: { stubs: { SourceEditor: SourceEditorStub } },
    });
    await flushPromises();

    await wrapper.get('button[aria-label="Open conflict recovery"]').trigger("click");

    expect(wrapper.emitted("request-conflict-recovery")?.[0]?.[0]).toMatchObject({
      userId: USER_ID,
      workspaceId: WORKSPACE_ID,
      noteId: NOTE_ID,
      localMarkdown: "# server markdown",
      localBaseRevision: 1,
    });
    wrapper.unmount();
  });
  it("keeps reachable source content non-editable when no live session factory grants authority", async () => {
    const wrapper = mount(Workbench, {
      props: { initialNotes: notes },
      global: { stubs: { SourceEditor: SourceEditorStub } },
    });
    await flushPromises();

    expect(wrapper.get('[data-testid="session-source"]').attributes("contenteditable")).toBe(
      "false",
    );

    wrapper.unmount();
  });

  it("projects owner state and routes every source change through session.edit", async () => {
    const authority = fakeSession();
    const sessionFactory = vi.fn(async () => authority.session);
    const wrapper = mount(Workbench, {
      props: { initialNotes: notes, sessionFactory },
      global: { stubs: { SourceEditor: SourceEditorStub } },
    });
    await flushPromises();

    const source = wrapper.get('[data-testid="session-source"]');
    expect(sessionFactory).toHaveBeenCalledOnce();
    expect(source.attributes("contenteditable")).toBe("true");
    source.element.textContent = "routed through authority";
    await source.trigger("input");

    expect(authority.edit).toHaveBeenCalledOnce();
    expect(authority.edit).toHaveBeenCalledWith("routed through authority");
    expect(source.text()).toBe("routed through authority");

    wrapper.unmount();
  });

  it("projects canonical session Markdown before the real CodeMirror surface becomes writable", async () => {
    const authority = fakeSession(state({ markdown: "SERVER-AUTHORITATIVE" }));
    const activation = deferred<EditorSession>();
    const wrapper = mount(Workbench, {
      props: {
        initialNotes: [{ id: NOTE_ID, title: "Authorized", markdown: "UNTRUSTED-SEED" }],
        sessionFactory: () => activation.promise,
      },
    });
    await nextTick();

    expect(wrapper.get(".cm-content").attributes("contenteditable")).toBe("false");
    expect(wrapper.get(".cm-content").text()).toBe("UNTRUSTED-SEED");

    activation.resolve(authority.session);
    await flushPromises();

    const content = wrapper.get(".cm-content");
    expect(content.attributes("contenteditable")).toBe("true");
    expect(content.text()).toBe("SERVER-AUTHORITATIVE");

    const view = EditorView.findFromDOM(wrapper.get(".cm-editor").element as HTMLElement);
    expect(view).not.toBeNull();
    view?.dispatch({
      changes: { from: view.state.doc.length, insert: "+USER-EDIT" },
    });

    expect(authority.edit).toHaveBeenCalledOnce();
    expect(authority.edit).toHaveBeenCalledWith("SERVER-AUTHORITATIVE+USER-EDIT");
    wrapper.unmount();
  });

  it("opens block command discovery for an empty source paragraph and replaces only the slash", async () => {
    const authority = fakeSession(state({ markdown: "before\n\nnext" }));
    const wrapper = mount(Workbench, {
      props: {
        initialNotes: [{ id: NOTE_ID, title: "Authorized", markdown: "seed" }],
        sessionFactory: async () => authority.session,
      },
    });
    await flushPromises();

    const view = EditorView.findFromDOM(wrapper.get(".cm-editor").element as HTMLElement);
    expect(view).not.toBeNull();
    view?.dispatch({ changes: { from: 7, insert: "/" } });
    await nextTick();

    expect(wrapper.get('[role="dialog"]').text()).toContain("Code block");
    expect(wrapper.get('[role="dialog"]').text()).not.toContain("Switch to Visual mode");
    await wrapper.get('[role="option"]:last-child').trigger("click");

    expect(authority.edit).toHaveBeenCalledWith("before\n```\n\n```\nnext");
    expect(authority.edit).toHaveBeenCalledTimes(2);
    expect(wrapper.find('[role="dialog"]').exists()).toBe(false);
    wrapper.unmount();
  });

  it("projects takeover or expiry revocation to read-only immediately", async () => {
    const authority = fakeSession();
    const wrapper = mount(Workbench, {
      props: { initialNotes: notes, sessionFactory: async () => authority.session },
      global: { stubs: { SourceEditor: SourceEditorStub } },
    });
    await flushPromises();
    expect(wrapper.get('[data-testid="session-source"]').attributes("contenteditable")).toBe(
      "true",
    );

    authority.emit(state({ readOnly: true, isReadOnly: true }));
    await nextTick();

    expect(wrapper.get('[data-testid="session-source"]').attributes("contenteditable")).toBe(
      "false",
    );
    wrapper.unmount();
  });

  it("locks the real CodeMirror surface before projecting a revoked-session scrub", async () => {
    const authority = fakeSession(state({ markdown: "PRIVATE-AUTHORIZED" }));
    const wrapper = mount(Workbench, {
      props: { initialNotes: notes, sessionFactory: async () => authority.session },
    });
    await flushPromises();

    const view = EditorView.findFromDOM(wrapper.get(".cm-editor").element as HTMLElement);
    expect(view).not.toBeNull();
    const editableDuringProjection: string[] = [];
    view?.dispatch({
      effects: StateEffect.appendConfig.of(
        EditorView.updateListener.of((update) => {
          if (update.docChanged) {
            editableDuringProjection.push(update.view.contentDOM.contentEditable);
          }
        }),
      ),
    });
    authority.edit.mockClear();

    authority.emit(state({ markdown: "", readOnly: true, isReadOnly: true }));
    await nextTick();

    expect(editableDuringProjection).toEqual(["false"]);
    expect(wrapper.get(".cm-content").attributes("contenteditable")).toBe("false");
    expect(view?.state.doc.toString()).toBe("");
    expect(wrapper.get(".cm-content").text()).not.toContain("PRIVATE-AUTHORIZED");
    view?.dispatch({ changes: { from: 0, insert: "FORGED-AFTER-REVOCATION" } });
    expect(view?.state.doc.toString()).toBe("");
    expect(authority.edit).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it("disposes a stale activation without replacing the newer real CodeMirror session", async () => {
    const staleActivation = deferred<EditorSession>();
    const currentActivation = deferred<EditorSession>();
    const staleAuthority = fakeSession(
      state({ noteId: NOTE_ID, markdown: "STALE-SERVER-AUTHORITY" }),
    );
    const currentAuthority = fakeSession(
      state({ noteId: OTHER_NOTE_ID, markdown: "CURRENT-SERVER-AUTHORITY" }),
    );
    const sessionFactory = vi.fn((note: { id: string }) =>
      note.id === NOTE_ID ? staleActivation.promise : currentActivation.promise,
    );
    const wrapper = mount(Workbench, {
      props: {
        initialNotes: [
          { id: NOTE_ID, title: "Stale", markdown: "STALE-UNTRUSTED-SEED" },
          { id: OTHER_NOTE_ID, title: "Current", markdown: "CURRENT-UNTRUSTED-SEED" },
        ],
        sessionFactory,
      },
    });
    await nextTick();

    await wrapper.findAll('nav[aria-label="Notes explorer"] button')[1]?.trigger("click");
    await nextTick();
    currentActivation.resolve(currentAuthority.session);
    await flushPromises();
    expect(wrapper.get(".cm-content").text()).toBe("CURRENT-SERVER-AUTHORITY");
    expect(wrapper.get(".cm-content").attributes("contenteditable")).toBe("true");

    staleActivation.resolve(staleAuthority.session);
    await flushPromises();

    expect(staleAuthority.session.dispose).toHaveBeenCalledOnce();
    expect(currentAuthority.session.dispose).not.toHaveBeenCalled();
    expect(wrapper.get(".cm-content").text()).toBe("CURRENT-SERVER-AUTHORITY");
    const view = EditorView.findFromDOM(wrapper.get(".cm-editor").element as HTMLElement);
    view?.dispatch({ changes: { from: view.state.doc.length, insert: "+CURRENT-USER" } });
    expect(currentAuthority.edit).toHaveBeenCalledWith("CURRENT-SERVER-AUTHORITY+CURRENT-USER");
    expect(staleAuthority.edit).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it("adopts a validated restored session as the next autosave base revision", async () => {
    const current = fakeSession(state({ baseRevision: 1, markdown: "# Current" }));
    const replacement = fakeSession(state({ baseRevision: 2, markdown: "# Restored" }));
    const sessionFactory = vi
      .fn()
      .mockResolvedValueOnce(current.session)
      .mockResolvedValueOnce({
        session: replacement.session,
        context: {
          userId: "11111111-1111-4111-8111-111111111111",
          workspaceId: "33333333-3333-4333-8333-333333333333",
        },
      });
    const VersionHistoryStub = defineComponent({
      props: { noteId: { type: String, required: true }, currentRevision: { type: Number } },
      emits: ["restored"],
      setup(_, { emit }) {
        return () => h("button", { onClick: () => emit("restored", noteResult()) }, "restore");
      },
    });
    const wrapper = mount(Workbench, {
      props: {
        initialNotes: [{ id: NOTE_ID, title: "Authorized", markdown: "# Current" }],
        workspaceId: "33333333-3333-4333-8333-333333333333",
        noteId: NOTE_ID,
        sessionFactory,
      },
      global: {
        stubs: { SourceEditor: SourceEditorStub, VersionHistory: VersionHistoryStub },
      },
    });
    await flushPromises();

    await wrapper.get('button[aria-label="Open context tools"]').trigger("click");
    await wrapper.get('button[aria-label="Open version history"]').trigger("click");
    await wrapper
      .findAll("button")
      .find((button) => button.text() === "restore")!
      .trigger("click");
    await flushPromises();

    expect(replacement.session.snapshot().baseRevision).toBe(2);
    expect(current.session.dispose).toHaveBeenCalledOnce();
    expect(replacement.session.dispose).not.toHaveBeenCalled();

    const source = wrapper.get('[data-testid="session-source"]');
    source.element.textContent = "# Restored\nnext";
    await source.trigger("input");
    expect(replacement.edit).toHaveBeenCalledWith("# Restored\nnext");

    wrapper.unmount();
  });

  it("keeps the old session usable when restored session validation fails", async () => {
    const current = fakeSession(state({ baseRevision: 1, markdown: "# Current" }));
    const replacement = fakeSession(state({ baseRevision: 99, markdown: "# Wrong" }));
    const sessionFactory = vi
      .fn()
      .mockResolvedValueOnce(current.session)
      .mockResolvedValueOnce(replacement.session);
    const VersionHistoryStub = defineComponent({
      props: { noteId: { type: String, required: true }, currentRevision: { type: Number } },
      emits: ["restored"],
      setup(_, { emit }) {
        return () => h("button", { onClick: () => emit("restored", noteResult()) }, "restore");
      },
    });
    const wrapper = mount(Workbench, {
      props: {
        initialNotes: [{ id: NOTE_ID, title: "Authorized", markdown: "# Current" }],
        workspaceId: "33333333-3333-4333-8333-333333333333",
        noteId: NOTE_ID,
        sessionFactory,
      },
      global: {
        stubs: { SourceEditor: SourceEditorStub, VersionHistory: VersionHistoryStub },
      },
    });
    await flushPromises();

    await wrapper.get('button[aria-label="Open context tools"]').trigger("click");
    await wrapper.get('button[aria-label="Open version history"]').trigger("click");
    await wrapper
      .findAll("button")
      .find((button) => button.text() === "restore")!
      .trigger("click");
    await flushPromises();

    expect(replacement.session.dispose).toHaveBeenCalledOnce();
    expect(current.session.dispose).not.toHaveBeenCalled();
    current.edit.mockClear();
    const source = wrapper.get('[data-testid="session-source"]');
    source.element.textContent = "# Still current";
    await source.trigger("input");
    expect(current.edit).toHaveBeenCalledWith("# Still current");

    wrapper.unmount();
  });

  it("rejects a delayed restore after switching to another note", async () => {
    const current = fakeSession(state({ noteId: NOTE_ID, markdown: "# Current" }));
    const nextNote = fakeSession(state({ noteId: OTHER_NOTE_ID, markdown: "# Other current" }));
    const staleReplacement = fakeSession(
      state({ noteId: NOTE_ID, baseRevision: 2, markdown: "# Restored" }),
    );
    const delayedRestore = deferred<EditorSession>();
    let noteFactoryCalls = 0;
    const sessionFactory = vi.fn((note: { id: string }) => {
      if (note.id === NOTE_ID) {
        noteFactoryCalls += 1;
        return noteFactoryCalls === 1 ? Promise.resolve(current.session) : delayedRestore.promise;
      }
      return Promise.resolve(nextNote.session);
    });
    const VersionHistoryStub = defineComponent({
      props: { noteId: { type: String, required: true }, currentRevision: { type: Number } },
      emits: ["restored"],
      setup(_, { emit }) {
        return () => h("button", { onClick: () => emit("restored", noteResult()) }, "restore");
      },
    });
    const wrapper = mount(Workbench, {
      props: {
        initialNotes: [
          { id: NOTE_ID, title: "Current", markdown: "# Current" },
          { id: OTHER_NOTE_ID, title: "Other", markdown: "# Other seed" },
        ],
        workspaceId: "33333333-3333-4333-8333-333333333333",
        noteId: NOTE_ID,
        sessionFactory,
      },
      global: {
        stubs: { SourceEditor: SourceEditorStub, VersionHistory: VersionHistoryStub },
      },
    });
    await flushPromises();

    await wrapper.get('button[aria-label="Open context tools"]').trigger("click");
    await wrapper.get('button[aria-label="Open version history"]').trigger("click");
    await wrapper
      .findAll("button")
      .find((button) => button.text() === "restore")!
      .trigger("click");
    await nextTick();
    expect(sessionFactory).toHaveBeenCalledTimes(2);

    await wrapper.findAll('nav[aria-label="Notes explorer"] button')[1]!.trigger("click");
    await flushPromises();
    expect(wrapper.get('[data-testid="session-source"]').text()).toBe("# Other current");

    delayedRestore.resolve(staleReplacement.session);
    await flushPromises();

    expect(staleReplacement.session.dispose).toHaveBeenCalledOnce();
    expect(nextNote.session.dispose).not.toHaveBeenCalled();
    expect(wrapper.get('[data-testid="session-source"]').text()).toBe("# Other current");
    const source = wrapper.get('[data-testid="session-source"]');
    source.element.textContent = "# Other edit";
    await source.trigger("input");
    expect(nextNote.edit).toHaveBeenCalledWith("# Other edit");
    expect(staleReplacement.edit).not.toHaveBeenCalled();

    wrapper.unmount();
  });

  it("rejects a restore when the note switches during replacement attachment", async () => {
    const current = fakeSession(state({ noteId: NOTE_ID, markdown: "# Current" }));
    const nextNote = fakeSession(state({ noteId: OTHER_NOTE_ID, markdown: "# Other current" }));
    const attachment = deferred<() => void>();
    const staleReplacement = fakeSession(
      state({ noteId: NOTE_ID, baseRevision: 2, markdown: "# Restored" }),
      vi.fn(() => attachment.promise),
    );
    const delayedRestore = deferred<EditorSession>();
    let noteFactoryCalls = 0;
    const sessionFactory = vi.fn((note: { id: string }) => {
      if (note.id === NOTE_ID) {
        noteFactoryCalls += 1;
        return noteFactoryCalls === 1 ? Promise.resolve(current.session) : delayedRestore.promise;
      }
      return Promise.resolve(nextNote.session);
    });
    const VersionHistoryStub = defineComponent({
      props: { noteId: { type: String, required: true }, currentRevision: { type: Number } },
      emits: ["restored"],
      setup(_, { emit }) {
        return () => h("button", { onClick: () => emit("restored", noteResult()) }, "restore");
      },
    });
    const wrapper = mount(Workbench, {
      props: {
        initialNotes: [
          { id: NOTE_ID, title: "Current", markdown: "# Current" },
          { id: OTHER_NOTE_ID, title: "Other", markdown: "# Other seed" },
        ],
        workspaceId: "33333333-3333-4333-8333-333333333333",
        noteId: NOTE_ID,
        sessionFactory,
      },
      global: {
        stubs: { SourceEditor: SourceEditorStub, VersionHistory: VersionHistoryStub },
      },
    });
    await flushPromises();

    await wrapper.get('button[aria-label="Open context tools"]').trigger("click");
    await wrapper.get('button[aria-label="Open version history"]').trigger("click");
    await wrapper
      .findAll("button")
      .find((button) => button.text() === "restore")!
      .trigger("click");
    await nextTick();
    delayedRestore.resolve(staleReplacement.session);
    await nextTick();
    expect(staleReplacement.session.attachModeAdapters).toHaveBeenCalledOnce();

    await wrapper.findAll('nav[aria-label="Notes explorer"] button')[1]!.trigger("click");
    await flushPromises();
    expect(wrapper.get('[data-testid="session-source"]').text()).toBe("# Other current");

    attachment.resolve(() => {});
    await flushPromises();
    expect(staleReplacement.session.dispose).toHaveBeenCalledOnce();
    expect(nextNote.session.dispose).not.toHaveBeenCalled();
    expect(wrapper.get('[data-testid="session-source"]').text()).toBe("# Other current");
    const source = wrapper.get('[data-testid="session-source"]');
    source.element.textContent = "# Other edit";
    await source.trigger("input");
    expect(nextNote.edit).toHaveBeenCalledWith("# Other edit");
    expect(staleReplacement.edit).not.toHaveBeenCalled();

    wrapper.unmount();
  });

  it("lets the newest overlapping restore win", async () => {
    const current = fakeSession(state({ baseRevision: 1, markdown: "# Current" }));
    const olderAttachment = deferred<() => void>();
    const olderReplacement = fakeSession(
      state({ baseRevision: 2, markdown: "# Older restore" }),
      vi.fn(() => olderAttachment.promise),
    );
    const newerReplacement = fakeSession(state({ baseRevision: 2, markdown: "# Newer restore" }));
    const olderRestore = deferred<EditorSession>();
    const newerRestore = deferred<EditorSession>();
    let noteFactoryCalls = 0;
    const sessionFactory = vi.fn(() => {
      noteFactoryCalls += 1;
      if (noteFactoryCalls === 1) return Promise.resolve(current.session);
      return noteFactoryCalls === 2 ? olderRestore.promise : newerRestore.promise;
    });
    const restoredResults = [
      noteResult({ contentMarkdown: "# Older restore" }),
      noteResult({ contentMarkdown: "# Newer restore" }),
    ];
    let restoreCount = 0;
    const VersionHistoryStub = defineComponent({
      props: { noteId: { type: String, required: true }, currentRevision: { type: Number } },
      emits: ["restored"],
      setup(_, { emit }) {
        return () =>
          h(
            "button",
            { onClick: () => emit("restored", restoredResults[restoreCount++]!) },
            "restore",
          );
      },
    });
    const wrapper = mount(Workbench, {
      props: {
        initialNotes: [{ id: NOTE_ID, title: "Current", markdown: "# Current" }],
        workspaceId: "33333333-3333-4333-8333-333333333333",
        noteId: NOTE_ID,
        sessionFactory,
      },
      global: {
        stubs: { SourceEditor: SourceEditorStub, VersionHistory: VersionHistoryStub },
      },
    });
    await flushPromises();

    await wrapper.get('button[aria-label="Open context tools"]').trigger("click");
    await wrapper.get('button[aria-label="Open version history"]').trigger("click");
    const restoreButton = () =>
      wrapper.findAll("button").find((button) => button.text() === "restore")!;
    await restoreButton().trigger("click");
    await nextTick();
    expect(sessionFactory).toHaveBeenCalledTimes(2);
    olderRestore.resolve(olderReplacement.session);
    await nextTick();
    expect(olderReplacement.session.attachModeAdapters).toHaveBeenCalledOnce();

    await restoreButton().trigger("click");
    await nextTick();
    expect(sessionFactory).toHaveBeenCalledTimes(3);

    newerRestore.resolve(newerReplacement.session);
    await flushPromises();
    expect(wrapper.get('[data-testid="session-source"]').text()).toBe("# Newer restore");
    expect(current.session.dispose).toHaveBeenCalledOnce();
    expect(newerReplacement.session.dispose).not.toHaveBeenCalled();

    olderAttachment.resolve(() => {});
    await flushPromises();
    expect(olderReplacement.session.dispose).toHaveBeenCalledOnce();
    expect(newerReplacement.session.dispose).not.toHaveBeenCalled();
    expect(wrapper.get('[data-testid="session-source"]').text()).toBe("# Newer restore");
    const source = wrapper.get('[data-testid="session-source"]');
    source.element.textContent = "# Newer edit";
    await source.trigger("input");
    expect(newerReplacement.edit).toHaveBeenCalledWith("# Newer edit");
    expect(olderReplacement.edit).not.toHaveBeenCalled();

    wrapper.unmount();
  });

  it("does not route pending replacement edits through the current session", async () => {
    const current = fakeSession(
      state({ baseRevision: 1, markdown: "# Current", mode: "visual", activePane: "visual" }),
    );
    const attachment = deferred<() => void>();
    let pendingAdapters: EditorModeAdapters | undefined;
    let pendingReplacementSession: EditorSession;
    const attachPendingReplacement = vi.fn(async (adapters: EditorModeAdapters) => {
      pendingAdapters = adapters;
      adapters.visual.setReadOnly(false);
      const unsubscribe = adapters.visual.onChange((markdown) => {
        pendingReplacementSession.edit(markdown);
      });
      const detach = await attachment.promise;
      return () => {
        unsubscribe();
        detach();
      };
    });
    const pendingReplacement = fakeSession(
      state({
        baseRevision: 2,
        markdown: "# Restored",
        mode: "visual",
        activePane: "visual",
      }),
      attachPendingReplacement,
    );
    pendingReplacementSession = pendingReplacement.session;
    const sessionFactory = vi
      .fn()
      .mockResolvedValueOnce(current.session)
      .mockResolvedValueOnce(pendingReplacement.session);
    const VersionHistoryStub = defineComponent({
      props: { noteId: { type: String, required: true }, currentRevision: { type: Number } },
      emits: ["restored"],
      setup(_, { emit }) {
        return () => h("button", { onClick: () => emit("restored", noteResult()) }, "restore");
      },
    });
    const wrapper = mount(Workbench, {
      props: {
        initialNotes: [{ id: NOTE_ID, title: "Current", markdown: "# Current" }],
        workspaceId: "33333333-3333-4333-8333-333333333333",
        noteId: NOTE_ID,
        sessionFactory,
      },
      global: {
        stubs: {
          SourceEditor: SourceEditorStub,
          VisualEditor: VisualEditorStub,
          VersionHistory: VersionHistoryStub,
        },
      },
    });
    await flushPromises();

    await wrapper.get('button[aria-label="Open context tools"]').trigger("click");
    await wrapper.get('button[aria-label="Open version history"]').trigger("click");
    await wrapper
      .findAll("button")
      .find((button) => button.text() === "restore")!
      .trigger("click");
    await nextTick();
    expect(attachPendingReplacement).toHaveBeenCalledOnce();
    expect(pendingAdapters).toBeDefined();
    expect(wrapper.get('[data-testid="session-visual"]').text()).toBe("# Current");

    current.edit.mockClear();
    const pendingVisualAdapter = pendingAdapters!.visual as WorkbenchModeAdapterShim;
    pendingVisualAdapter.syncFromUi("# Pending replacement edit", true);
    expect(current.edit).not.toHaveBeenCalled();
    expect(pendingReplacement.edit).toHaveBeenCalledWith("# Pending replacement edit");
    expect(wrapper.get('[data-testid="session-visual"]').text()).toBe("# Current");

    attachment.resolve(() => {});
    await flushPromises();
    expect(pendingReplacement.session.snapshot().noteId).toBe(NOTE_ID);
    expect(pendingReplacement.session.snapshot().baseRevision).toBe(2);
    expect(current.session.dispose).toHaveBeenCalledOnce();
    expect(pendingReplacement.session.dispose).not.toHaveBeenCalled();
    const visual = wrapper.get('[data-testid="session-visual"]');
    visual.element.textContent = "# Active replacement edit";
    await visual.trigger("input");
    expect(pendingReplacement.edit).toHaveBeenLastCalledWith("# Active replacement edit");
    expect(current.edit).not.toHaveBeenCalled();

    wrapper.unmount();
  });
});
