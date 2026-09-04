import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import NoteExplorer from "./NoteExplorer.vue";
import { useNotesStore } from "../../stores/notes.js";
import type { NoteResult } from "@glyphquire/api-contract";

const WORKSPACE_ID = "33333333-3333-4333-8333-333333333333";
const NOTE_ID = "44444444-4444-4444-8444-444444444444";

function note(overrides: Partial<NoteResult> = {}): NoteResult {
  return {
    id: NOTE_ID,
    workspaceId: WORKSPACE_ID,
    title: "First note",
    revision: 1,
    visibility: "private",
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
    deletedAt: null,
    contentMarkdown: "",
    schemaVersion: 1,
    ...overrides,
  };
}

describe("NoteExplorer smoke test", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it("loads, renames, deletes, and restores a note through the store", async () => {
    const store = useNotesStore();
    const listNotes = vi.fn(async () => ({ items: [note()], nextCursor: null }));
    const renameNote = vi.fn(async () => note({ title: "Renamed" }));
    const deleteNote = vi.fn(async () =>
      note({ deletedAt: "2026-08-20T00:00:00.000Z", revision: 2 }),
    );
    const restoreNote = vi.fn(async () => note({ deletedAt: null, revision: 3 }));
    store.configure({
      listNotes,
      createNote: vi.fn(),
      renameNote,
      deleteNote,
      restoreNote,
    });

    const wrapper = mount(NoteExplorer, { props: { workspaceId: WORKSPACE_ID } });
    await flushPromises();
    expect(listNotes).toHaveBeenCalledWith(WORKSPACE_ID, { cursor: undefined, pageSize: 100 });
    expect(wrapper.text()).toContain("First note");

    // Rename.
    await wrapper.get('button[aria-label^="Rename"]').trigger("click");
    await flushPromises();
    await wrapper.get<HTMLInputElement>(`#note-explorer-rename-${NOTE_ID}`).setValue("Renamed");
    await wrapper.get("form").trigger("submit.prevent");
    await flushPromises();
    expect(renameNote).toHaveBeenCalledWith(
      NOTE_ID,
      expect.objectContaining({ title: "Renamed", baseRevision: 1 }),
    );

    // Delete (soft) with confirmation.
    await wrapper.get('button[aria-label^="Delete"]').trigger("click");
    await flushPromises();
    await wrapper.get('[role="alertdialog"] button.bg-danger').trigger("click");
    await flushPromises();
    expect(deleteNote).toHaveBeenCalled();
    expect(store.trashedNotes).toHaveLength(1);
    expect(store.activeNotes).toHaveLength(0);

    // Restore from Trash with confirmation showing the target revision.
    const trashToggle = wrapper.findAll("button").find((b) => b.text().startsWith("Trash"));
    await trashToggle!.trigger("click");
    await flushPromises();
    const restoreTrigger = wrapper.findAll("button").find((b) => b.text() === "Restore");
    await restoreTrigger!.trigger("click");
    await flushPromises();
    expect(wrapper.text()).toContain("revision 2");
    await wrapper.get('[role="alertdialog"] button.bg-accent').trigger("click");
    await flushPromises();
    expect(restoreNote).toHaveBeenCalled();
    expect(store.activeNotes).toHaveLength(1);

    wrapper.unmount();
  });

  it("filters the active notes list by title substring", async () => {
    const store = useNotesStore();
    const listNotes = vi.fn(async () => ({
      items: [
        note({ id: NOTE_ID, title: "Grocery list" }),
        note({ id: "55555555-5555-4555-8555-555555555555", title: "Meeting notes" }),
      ],
      nextCursor: null,
    }));
    store.configure({
      listNotes,
      createNote: vi.fn(),
      renameNote: vi.fn(),
      deleteNote: vi.fn(),
      restoreNote: vi.fn(),
    });
    const wrapper = mount(NoteExplorer, { props: { workspaceId: WORKSPACE_ID } });
    await flushPromises();
    await wrapper.get('input[aria-label="Filter notes"]').setValue("meeting");
    expect(wrapper.text()).toContain("Meeting notes");
    expect(wrapper.text()).not.toContain("Grocery list");
  });

  it("shows the most-recently-updated notes in a Recent section and opens one", async () => {
    const store = useNotesStore();
    const older = note({
      id: "55555555-5555-4555-8555-555555555555",
      title: "Older note",
      updatedAt: "2026-08-01T00:00:00.000Z",
    });
    const newer = note({
      id: "66666666-6666-4666-8666-666666666666",
      title: "Newer note",
      updatedAt: "2026-08-20T00:00:00.000Z",
    });
    store.configure({
      listNotes: vi.fn(async () => ({ items: [older, newer], nextCursor: null })),
      createNote: vi.fn(),
      renameNote: vi.fn(),
      deleteNote: vi.fn(),
      restoreNote: vi.fn(),
    });
    const wrapper = mount(NoteExplorer, { props: { workspaceId: WORKSPACE_ID } });
    await flushPromises();

    const recent = wrapper.get('[aria-label="Recent notes"]');
    const recentTitles = recent.findAll("button").map((button) => button.text());
    // Most-recent first.
    expect(recentTitles[0]).toContain("Newer note");
    expect(recentTitles).toContain("Older note");

    await recent.findAll("button")[0]!.trigger("click");
    expect(wrapper.emitted("open")?.[0]).toEqual(["66666666-6666-4666-8666-666666666666"]);

    // Recent hides while filtering.
    await wrapper.get('input[aria-label="Filter notes"]').setValue("older");
    expect(wrapper.find('[aria-label="Recent notes"]').exists()).toBe(false);
  });
});
