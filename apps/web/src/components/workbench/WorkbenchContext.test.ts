import { defineComponent, h } from "vue";
import { flushPromises, mount } from "@vue/test-utils";
import { describe, expect, it, vi } from "vitest";
import type { EditorSession, EditorSessionState } from "../../editors/editor-session.types.js";
import {
  createWorkbenchContext,
  parseWorkbenchRoute,
  provideWorkbenchHostContext,
  useWorkbenchHostContext,
  type WorkbenchHostContext,
} from "./WorkbenchContext.js";
import type { WorkbenchNote, WorkbenchSessionHandle } from "./types.js";

const Probe = defineComponent({
  setup() {
    const context = useWorkbenchHostContext();
    return () => h("output", { "data-context": JSON.stringify(context) });
  },
});

describe("WorkbenchContext", () => {
  it("keeps the default context empty", () => {
    const wrapper = mount(Probe);

    expect(JSON.parse(wrapper.get("output").attributes("data-context") ?? "null")).toEqual({});
  });

  it("provides the host context unchanged", () => {
    const context: WorkbenchHostContext = {
      workspaceId: "33333333-3333-4333-8333-333333333333",
      workspaceName: "Research",
      accountLabel: "AL",
    };
    const Host = defineComponent({
      setup() {
        provideWorkbenchHostContext(context);
        return () => h(Probe);
      },
    });

    const wrapper = mount(Host);

    expect(JSON.parse(wrapper.get("output").attributes("data-context") ?? "null")).toEqual(context);
  });

  it("parses only canonical workspace and note route identities", () => {
    expect(
      parseWorkbenchRoute({
        pathname: "/workspace/22222222-2222-4222-8222-222222222222/",
        search: "?noteId=44444444-4444-4444-8444-444444444444",
      }),
    ).toEqual({
      workspaceId: "22222222-2222-4222-8222-222222222222",
      noteId: "44444444-4444-4444-8444-444444444444",
    });
    expect(
      parseWorkbenchRoute({ pathname: "/workspace/not-a-uuid", search: "?noteId=bad" }),
    ).toEqual({ workspaceId: null, noteId: null });
  });

  it("owns note, panel, mode, and session lifecycle behind one seam", async () => {
    const firstNote: WorkbenchNote = { id: "first", title: "First", markdown: "# First" };
    const secondNote: WorkbenchNote = { id: "second", title: "Second", markdown: "# Second" };
    const firstSession = createSession("first", "# Authoritative first");
    const secondSession = createSession("second", "# Authoritative second");
    const sessionFactory = vi.fn(async (note: Readonly<WorkbenchNote>) => {
      const handle: WorkbenchSessionHandle =
        note.id === "first" ? { session: firstSession } : { session: secondSession };
      return handle;
    });
    const context = createWorkbenchContext({
      initialNotes: [firstNote, secondNote],
      sessionFactory,
      workspaceId: "22222222-2222-4222-8222-222222222222",
    });

    await flushPromises();
    expect(context.snapshot().activeNoteId).toBe("first");
    expect(context.snapshot().sessionState?.markdown).toBe("# Authoritative first");

    context.openNote("second");
    await flushPromises();
    expect(context.snapshot().openTabs.map((note) => note.id)).toEqual(["first", "second"]);
    expect(context.snapshot().activeNoteId).toBe("second");
    expect(context.snapshot().sessionState?.noteId).toBe("second");
    expect(firstSession.dispose).toHaveBeenCalledOnce();

    context.setPanel("search");
    expect(context.snapshot().toolPanel).toBe("search");
    context.setPanel("history");
    expect(context.snapshot().toolPanel).toBe("search");
    context.setPanel("context");
    expect(context.snapshot().contextRailOpen).toBe(true);
    context.setPanel("assets");
    expect(context.snapshot().toolPanel).toBe("assets");
    expect(context.snapshot().contextRailOpen).toBe(false);

    await context.setMode("visual");
    expect(secondSession.switchMode).toHaveBeenCalledWith("visual");

    context.closeNote("second");
    await flushPromises();
    expect(context.snapshot().activeNoteId).toBe("first");
    expect(secondSession.dispose).toHaveBeenCalledOnce();

    await context.dispose();
    expect(firstSession.dispose).toHaveBeenCalledTimes(2);
    context.openNote("second");
    expect(context.snapshot().activeNoteId).toBe("first");
  });
});

function createSession(noteId: string, markdown: string): EditorSession {
  let current: EditorSessionState = {
    noteId,
    markdown,
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
  };
  const listeners = new Set<(state: EditorSessionState) => void>();
  const notify = () => listeners.forEach((listener) => listener(current));
  const session: EditorSession = {
    snapshot: () => current,
    edit: vi.fn(),
    switchMode: vi.fn(async (mode) => {
      current = { ...current, mode, activePane: mode === "visual" ? "visual" : "source" };
      notify();
      return { success: true, mode };
    }),
    attachModeAdapters: vi.fn(async () => () => undefined),
    saveNow: vi.fn(async () => undefined),
    requestTakeover: vi.fn(async () => false),
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispose: vi.fn(async () => undefined),
  };
  return session;
}
