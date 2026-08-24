import { flushPromises, mount } from "@vue/test-utils";
import { StateEffect } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { defineComponent, h, nextTick } from "vue";
import { describe, expect, it, vi } from "vitest";
import Workbench from "./Workbench.vue";
import type { EditorSession, EditorSessionState } from "../../editors/editor-session.types.js";

const NOTE_ID = "44444444-4444-4444-8444-444444444444";
const OTHER_NOTE_ID = "55555555-5555-4555-8555-555555555555";

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

function fakeSession(initialState = state()) {
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

const notes = [{ id: NOTE_ID, title: "Authorized", markdown: "untrusted seed" }];

describe("Workbench EditorSession composition", () => {
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
});
