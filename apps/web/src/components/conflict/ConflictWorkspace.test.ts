import { flushPromises, mount } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ConflictWorkspace from "./ConflictWorkspace.vue";
import { NoteApiError, NoteConflictError } from "../../api/NoteClient.js";
import type { ConflictNoteClient } from "./ConflictWorkspace.vue";
import type { DraftKey, DraftRecord, DraftStore } from "../../persistence/DraftStore.js";
import type { NoteConflict, NoteResult, SaveNoteInput } from "@glyphquire/api-contract";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const WORKSPACE_ID = "33333333-3333-4333-8333-333333333333";
const NOTE_ID = "44444444-4444-4444-8444-444444444444";

const LOCAL_MARKDOWN = "---\nglyphquire-spec: 1\n---\n\n# Local title\n\nMy unsent edit.";
const SERVER_MARKDOWN = "---\nglyphquire-spec: 1\n---\n\n# Server title\n\nSomeone else's edit.";

function conflict(overrides: Partial<NoteConflict> = {}): NoteConflict {
  return {
    code: "REVISION_CONFLICT",
    noteId: NOTE_ID,
    serverRevision: 5,
    serverMarkdown: SERVER_MARKDOWN,
    serverUpdatedAt: "2026-08-20T10:00:00.000Z",
    lastEditedBy: { userId: "22222222-2222-4222-8222-222222222222", displayName: "Ada" },
    requestId: "req-1",
    ...overrides,
  };
}

/** In-memory stand-in for {@link DraftStore}, scoped to one test's records. */
class MemoryDraftStore implements DraftStore {
  private readonly records = new Map<string, DraftRecord>();

  async put(record: DraftRecord): Promise<void> {
    this.records.set(this.key(record), { ...record });
  }

  async get(key: DraftKey): Promise<DraftRecord | undefined> {
    const found = this.records.get(this.key(key));
    return found ? { ...found } : undefined;
  }

  async delete(key: DraftKey): Promise<void> {
    this.records.delete(this.key(key));
  }

  async clearForUser(userId: string): Promise<void> {
    for (const [key, value] of this.records) {
      if (value.userId === userId) this.records.delete(key);
    }
  }

  private key(key: DraftKey): string {
    return `${key.userId}:${key.workspaceId}:${key.noteId}`;
  }
}

function fakeNoteClient(
  impl?: Partial<ConflictNoteClient>,
): ConflictNoteClient & { save: ReturnType<typeof vi.fn> } {
  return {
    save: vi.fn(async (): Promise<NoteResult> => {
      throw new Error("save() was not stubbed for this test");
    }),
    ...impl,
  } as ConflictNoteClient & { save: ReturnType<typeof vi.fn> };
}

function noteResult(overrides: Partial<NoteResult> = {}): NoteResult {
  return {
    id: NOTE_ID,
    workspaceId: WORKSPACE_ID,
    title: "Merged",
    revision: 6,
    visibility: "private",
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-20T10:05:00.000Z",
    deletedAt: null,
    contentMarkdown: LOCAL_MARKDOWN,
    schemaVersion: 1,
    ...overrides,
  };
}

function mountWorkspace(
  overrides: {
    noteClient?: ConflictNoteClient;
    draftStore?: DraftStore;
    conflict?: NoteConflict;
    localMarkdown?: string;
    attachTo?: HTMLElement;
  } = {},
) {
  return mount(ConflictWorkspace, {
    props: {
      noteId: NOTE_ID,
      userId: USER_ID,
      workspaceId: WORKSPACE_ID,
      conflict: overrides.conflict ?? conflict(),
      localMarkdown: overrides.localMarkdown ?? LOCAL_MARKDOWN,
      noteClient: overrides.noteClient ?? fakeNoteClient(),
      draftStore: overrides.draftStore ?? new MemoryDraftStore(),
    },
    attachTo: overrides.attachTo,
  });
}

beforeEach(() => {
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText: vi.fn(async () => undefined) },
    configurable: true,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("ConflictWorkspace — complete 409 flow", () => {
  it("renders the local edit and the server version from the conflict payload", async () => {
    const wrapper = mountWorkspace();
    await flushPromises();

    const local = wrapper.get<HTMLTextAreaElement>('[data-testid="local-pane"]');
    expect(local.element.value).toBe(LOCAL_MARKDOWN);
    expect(wrapper.get('[data-testid="server-pane"]').text()).toContain("Server title");
    expect(wrapper.get('[data-testid="server-pane"]').text()).toContain("Someone else's edit.");

    wrapper.unmount();
  });

  it("highlights differences using CSS classes only, never HTML injection", async () => {
    const wrapper = mountWorkspace();
    await flushPromises();

    const diffView = wrapper.get('[data-testid="diff-view"]');
    // Every diff line is a plain text node under a classed <div> — no raw
    // markup from note content could ever end up parsed as an element here.
    expect(diffView.html()).not.toContain("<script");
    expect(diffView.findAll("div").length).toBeGreaterThan(0);
    expect(diffView.text()).toContain("Local title");
    expect(diffView.text()).toContain("Server title");

    wrapper.unmount();
  });
});

describe("ConflictWorkspace — server pane is strictly read-only", () => {
  it("never renders an editable control for server content", async () => {
    const wrapper = mountWorkspace();
    await flushPromises();

    const serverPane = wrapper.get('[data-testid="server-pane"]');
    expect(serverPane.element.tagName).toBe("PRE");
    expect(serverPane.attributes("contenteditable")).toBeUndefined();
    expect(serverPane.attributes("aria-readonly")).toBe("true");
    expect(serverPane.find("textarea").exists()).toBe(false);
    expect(serverPane.find("input").exists()).toBe(false);
    expect(serverPane.find('[contenteditable="true"]').exists()).toBe(false);

    wrapper.unmount();
  });
});

describe("ConflictWorkspace — copy actions", () => {
  it("copies the local and server text and shows transient feedback", async () => {
    const wrapper = mountWorkspace();
    await flushPromises();

    const writeText = navigator.clipboard.writeText as ReturnType<typeof vi.fn>;

    const [copyLocal, copyServer] = wrapper.findAll("button").filter((b) => b.text() === "Copy");
    await copyLocal.trigger("click");
    await flushPromises();
    expect(writeText).toHaveBeenCalledWith(LOCAL_MARKDOWN);
    expect(wrapper.text()).toContain("Your version copied to clipboard.");

    await copyServer.trigger("click");
    await flushPromises();
    expect(writeText).toHaveBeenCalledWith(SERVER_MARKDOWN);
    expect(wrapper.text()).toContain("Server version copied to clipboard.");

    wrapper.unmount();
  });
});

describe("ConflictWorkspace — resubmit uses the displayed server revision and a new operation id", () => {
  it("sends the currently shown serverRevision as baseRevision, ignoring any stale prior id", async () => {
    const save = vi.fn(async (_noteId: string, input: SaveNoteInput) =>
      noteResult({ revision: input.baseRevision + 1, contentMarkdown: input.contentMarkdown }),
    );
    const wrapper = mountWorkspace({ noteClient: fakeNoteClient({ save }) });
    await flushPromises();

    const local = wrapper.get<HTMLTextAreaElement>('[data-testid="local-pane"]');
    await local.setValue("merged content");

    await wrapper.get('[data-testid="resubmit-button"]').trigger("click");
    await flushPromises();

    expect(save).toHaveBeenCalledTimes(1);
    const [noteId, input] = save.mock.calls[0] as [string, SaveNoteInput];
    expect(noteId).toBe(NOTE_ID);
    expect(input.baseRevision).toBe(5); // the conflict's serverRevision, not any earlier local revision
    expect(input.contentMarkdown).toBe("merged content");
    expect(input.operationId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );

    expect(wrapper.emitted("resolved")).toBeTruthy();
    const [resolved] = wrapper.emitted("resolved")![0] as [NoteResult];
    expect(resolved.revision).toBe(6);

    wrapper.unmount();
  });

  it("mints a fresh operation id on every resubmit attempt", async () => {
    const seenOperationIds: string[] = [];
    const save = vi.fn(async (_noteId: string, input: SaveNoteInput) => {
      seenOperationIds.push(input.operationId);
      if (seenOperationIds.length === 1) {
        throw new NoteConflictError(
          conflict({ serverRevision: 6, serverMarkdown: "server moved again" }),
        );
      }
      return noteResult({ revision: input.baseRevision + 1 });
    });
    const wrapper = mountWorkspace({ noteClient: fakeNoteClient({ save }) });
    await flushPromises();

    await wrapper.get('[data-testid="resubmit-button"]').trigger("click");
    await flushPromises();
    await wrapper.get('[data-testid="resubmit-button"]').trigger("click");
    await flushPromises();

    expect(seenOperationIds).toHaveLength(2);
    expect(seenOperationIds[0]).not.toBe(seenOperationIds[1]);
    expect(save.mock.calls[1][1].baseRevision).toBe(6);

    wrapper.unmount();
  });
});

describe("ConflictWorkspace — a second conflict is shown, never silently resolved", () => {
  it("updates the displayed server pane and does not auto-retry the save", async () => {
    const save = vi.fn(async () => {
      throw new NoteConflictError(
        conflict({
          serverRevision: 9,
          serverMarkdown: "even newer server content",
          requestId: "req-2",
        }),
      );
    });
    const wrapper = mountWorkspace({ noteClient: fakeNoteClient({ save }) });
    await flushPromises();

    await wrapper.get('[data-testid="resubmit-button"]').trigger("click");
    await flushPromises();

    expect(save).toHaveBeenCalledTimes(1); // no automatic retry
    expect(wrapper.get('[data-testid="server-pane"]').text()).toContain(
      "even newer server content",
    );
    expect(wrapper.get('[data-testid="conflict-status-badge"]').text()).toContain(
      "Needs attention",
    );
    expect(wrapper.emitted("resolved")).toBeFalsy();

    wrapper.unmount();
  });

  it("surfaces a non-conflict save failure without discarding local edits", async () => {
    const save = vi.fn(async () => {
      throw new NoteApiError("SERVICE_UNAVAILABLE", 503, "req-3");
    });
    const wrapper = mountWorkspace({ noteClient: fakeNoteClient({ save }) });
    await flushPromises();

    const local = wrapper.get<HTMLTextAreaElement>('[data-testid="local-pane"]');
    await local.setValue("do not lose this");

    await wrapper.get('[data-testid="resubmit-button"]').trigger("click");
    await flushPromises();

    expect(wrapper.emitted("resolved")).toBeFalsy();
    expect(local.element.value).toBe("do not lose this");
    expect(wrapper.text()).toContain("SERVICE_UNAVAILABLE");

    wrapper.unmount();
  });
});

describe("ConflictWorkspace — no last-write-wins path exists", () => {
  it("never calls noteClient.save from typing alone or from dismissing", async () => {
    const save = vi.fn(async () => noteResult());
    const wrapper = mountWorkspace({ noteClient: fakeNoteClient({ save }) });
    await flushPromises();

    const local = wrapper.get<HTMLTextAreaElement>('[data-testid="local-pane"]');
    await local.setValue("changed but not resubmitted");
    await local.setValue("changed again, still not resubmitted");
    await flushPromises();

    const dismissButton = wrapper
      .findAll("button")
      .find((b) => b.text() === "Keep working elsewhere");
    expect(dismissButton).toBeTruthy();
    await dismissButton!.trigger("click");
    expect(wrapper.emitted("dismiss")).toBeTruthy();

    expect(save).not.toHaveBeenCalled();

    wrapper.unmount();
  });

  it("always sends the displayed server revision, never a caller-supplied stale one", async () => {
    // Even though the original local edit predates this conflict by several
    // revisions, resubmit must bind to the server revision actually shown —
    // there is no parameter or code path that lets it use anything older.
    const save = vi.fn(async (_noteId: string, input: SaveNoteInput) =>
      noteResult({ revision: input.baseRevision + 1 }),
    );
    const wrapper = mountWorkspace({
      noteClient: fakeNoteClient({ save }),
      conflict: conflict({ serverRevision: 42 }),
    });
    await flushPromises();

    await wrapper.get('[data-testid="resubmit-button"]').trigger("click");
    await flushPromises();

    expect(save.mock.calls[0][1].baseRevision).toBe(42);

    wrapper.unmount();
  });
});

describe("ConflictWorkspace — draft durability across reload", () => {
  it("recovers the merged draft from the same draft store after the component remounts", async () => {
    const sharedDraftStore = new MemoryDraftStore();
    const first = mountWorkspace({ draftStore: sharedDraftStore });
    await flushPromises();

    const firstLocal = first.get<HTMLTextAreaElement>('[data-testid="local-pane"]');
    await firstLocal.setValue("merged content that must survive a reload");

    // Wait past the debounce so the edit is durably written before "reload".
    await new Promise((resolve) => setTimeout(resolve, 500));
    first.unmount();

    // A fresh mount against the same store simulates the page reloading:
    // this is a brand-new component instance with no in-memory state.
    const second = mountWorkspace({
      draftStore: sharedDraftStore,
      localMarkdown: LOCAL_MARKDOWN, // what the caller would pass again after reload
    });
    await flushPromises();

    const secondLocal = second.get<HTMLTextAreaElement>('[data-testid="local-pane"]');
    expect(secondLocal.element.value).toBe("merged content that must survive a reload");

    second.unmount();
  });

  it("clears the persisted draft once the conflict is resolved", async () => {
    const sharedDraftStore = new MemoryDraftStore();
    const save = vi.fn(async () => noteResult());
    const wrapper = mountWorkspace({
      draftStore: sharedDraftStore,
      noteClient: fakeNoteClient({ save }),
    });
    await flushPromises();

    await wrapper
      .get<HTMLTextAreaElement>('[data-testid="local-pane"]')
      .setValue("about to resolve");
    await new Promise((resolve) => setTimeout(resolve, 500));

    await wrapper.get('[data-testid="resubmit-button"]').trigger("click");
    await flushPromises();

    const remaining = await sharedDraftStore.get({
      userId: USER_ID,
      workspaceId: WORKSPACE_ID,
      noteId: NOTE_ID,
    });
    expect(remaining).toBeUndefined();

    wrapper.unmount();
  });
});

describe("ConflictWorkspace — accessibility", () => {
  it("traps focus inside the workspace and returns it to the trigger element on close", async () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const trigger = document.createElement("button");
    trigger.textContent = "Open recovery";
    document.body.appendChild(trigger);
    trigger.focus();
    expect(document.activeElement).toBe(trigger);

    const wrapper = mountWorkspace({ attachTo: host });
    await flushPromises();

    expect(document.activeElement).toBe(wrapper.get('[data-testid="local-pane"]').element);
    expect(document.activeElement === trigger).toBe(false);

    wrapper.unmount();
    expect(document.activeElement).toBe(trigger);

    host.remove();
    trigger.remove();
  });

  it("exposes a labeled dialog with a live save-status region", async () => {
    const wrapper = mountWorkspace();
    await flushPromises();

    const dialog = wrapper.get('[role="dialog"]');
    expect(dialog.attributes("aria-modal")).toBe("true");
    expect(dialog.attributes("aria-label")).toBeTruthy();
    expect(wrapper.find('[role="status"][aria-live="polite"]').exists()).toBe(true);

    wrapper.unmount();
  });
});
