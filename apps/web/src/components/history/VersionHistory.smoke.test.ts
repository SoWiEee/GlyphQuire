import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import VersionHistory from "./VersionHistory.vue";
import { useNoteVersionsStore } from "../../stores/noteVersions.js";
import type { CheckpointNoteResult, NoteResult, NoteVersionResult } from "@glyphquire/api-contract";

const NOTE_ID = "44444444-4444-4444-8444-444444444444";
const VERSION_ID = "66666666-6666-4666-8666-666666666666";

function versionResult(overrides: Partial<NoteVersionResult> = {}): NoteVersionResult {
  return {
    id: VERSION_ID,
    noteId: NOTE_ID,
    revision: 3,
    reason: "checkpoint",
    createdBy: { displayName: "Ada" },
    createdAt: "2026-08-19T12:00:00.000Z",
    contentMarkdown: "# Snapshot body",
    schemaVersion: 1,
    ...overrides,
  };
}

describe("VersionHistory smoke test", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it("lists versions, previews one read-only, creates a checkpoint, and restores a version", async () => {
    const store = useNoteVersionsStore();
    const listNoteVersions = vi.fn(async () => ({
      items: [
        {
          id: VERSION_ID,
          noteId: NOTE_ID,
          revision: 3,
          reason: "checkpoint" as const,
          createdBy: { displayName: "Ada" },
          createdAt: "2026-08-19T12:00:00.000Z",
        },
      ],
      nextCursor: null,
    }));
    const getNoteVersion = vi.fn(async () => versionResult());
    const checkpointNote = vi.fn(async (): Promise<CheckpointNoteResult> => ({
      note: {
        id: NOTE_ID,
        workspaceId: "33333333-3333-4333-8333-333333333333",
        title: "Note",
        revision: 4,
        visibility: "private",
        createdAt: "2026-08-01T00:00:00.000Z",
        updatedAt: "2026-08-20T00:00:00.000Z",
        deletedAt: null,
        contentMarkdown: "current",
        schemaVersion: 1,
      },
      version: versionResult({ id: "77777777-7777-4777-8777-777777777777", revision: 4 }),
    }));
    const restoreNoteVersion = vi.fn(async (): Promise<NoteResult> => ({
      id: NOTE_ID,
      workspaceId: "33333333-3333-4333-8333-333333333333",
      title: "Note",
      revision: 5,
      visibility: "private",
      createdAt: "2026-08-01T00:00:00.000Z",
      updatedAt: "2026-08-20T00:10:00.000Z",
      deletedAt: null,
      contentMarkdown: "# Snapshot body",
      schemaVersion: 1,
    }));
    store.configure({ listNoteVersions, checkpointNote, getNoteVersion, restoreNoteVersion });

    const wrapper = mount(VersionHistory, { props: { noteId: NOTE_ID, currentRevision: 3 } });
    await flushPromises();
    expect(listNoteVersions).toHaveBeenCalled();
    expect(wrapper.text()).toContain("Revision 3");

    // Preview a version — must render read-only, never editable.
    await wrapper.get('ul[aria-label="Versions"] button').trigger("click");
    await flushPromises();
    const preview = wrapper.get('[data-testid="version-preview-body"]');
    expect(preview.element.tagName).toBe("PRE");
    expect(preview.attributes("contenteditable")).toBeUndefined();
    expect(preview.text()).toContain("Snapshot body");

    // Checkpoint dialog.
    const checkpointButton = wrapper.findAll("button").find((b) => b.text() === "Checkpoint");
    await checkpointButton!.trigger("click");
    await flushPromises();
    const createButton = wrapper.findAll("button").find((b) => b.text() === "Create checkpoint");
    await createButton!.trigger("click");
    await flushPromises();
    expect(checkpointNote).toHaveBeenCalledWith(
      NOTE_ID,
      expect.objectContaining({ baseRevision: 3 }),
    );

    // Restore the (now-selected, freshly checkpointed) version.
    const restoreTrigger = wrapper
      .findAll("button")
      .find((b) => b.text() === "Restore this version");
    await restoreTrigger!.trigger("click");
    await flushPromises();
    const confirmRestore = wrapper.findAll("button").find((b) => b.text() === "Restore");
    await confirmRestore!.trigger("click");
    await flushPromises();
    expect(restoreNoteVersion).toHaveBeenCalled();
    expect(wrapper.emitted("restored")).toBeTruthy();

    wrapper.unmount();
  });
});
