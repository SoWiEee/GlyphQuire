import { flushPromises, mount } from "@vue/test-utils";
import { defineComponent, h, nextTick } from "vue";
import { describe, expect, it, vi } from "vitest";
import Workbench from "./Workbench.vue";
import type { EditorSession, EditorSessionState } from "../../editors/editor-session.types.js";

const NOTE_ID = "44444444-4444-4444-8444-444444444444";

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
});
