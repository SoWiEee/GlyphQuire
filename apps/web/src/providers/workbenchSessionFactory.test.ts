import { describe, expect, it, vi } from "vitest";
import { createWorkbenchSessionFactory } from "./workbenchSessionFactory.js";
import type { EditorSession } from "../editors/editor-session.types.js";
import type { WorkbenchNote } from "../components/workbench/types.js";

const userId = "usr_2N4kQb8fVxErq7wZ";
const workspaceId = "22222222-2222-4222-8222-222222222222";
const noteId = "44444444-4444-4444-8444-444444444444";

const config = {
  userId,
  workspaceId,
  workspaceName: "Personal",
  accountLabel: "a@b.co",
};

function fakeNote(): WorkbenchNote {
  return { id: noteId, title: "My note", markdown: "" };
}

describe("createWorkbenchSessionFactory", () => {
  it("loads the note content and opens a session with correctly wired deps", async () => {
    const fakeSession = { dispose: async () => undefined } as unknown as EditorSession;
    const openSession = vi.fn(async () => fakeSession);
    const getNote = vi.fn(async () => ({ contentMarkdown: "# Hello", revision: 7 }));
    const makeLock = vi.fn((scope) => ({ scope }) as never);

    const factory = createWorkbenchSessionFactory(config, {
      openSession,
      noteReader: { getNote },
      lifecycle: {} as never,
      draftStore: {} as never,
      documentAnalysis: {} as never,
      makeLock,
    });

    const handle = (await factory(fakeNote())) as { session: EditorSession; context: unknown };
    expect(getNote).toHaveBeenCalledWith(noteId);
    // Lock scope is the full tenant/note identity.
    expect(makeLock).toHaveBeenCalledWith({ userId, workspaceId, noteId });
    // openSession receives the authoritative content + identity.
    const deps = openSession.mock.calls[0]![0];
    expect(deps.userId).toBe(userId);
    expect(deps.workspaceId).toBe(workspaceId);
    expect(deps.noteId).toBe(noteId);
    expect(deps.initialMarkdown).toBe("# Hello");
    expect(deps.initialRevision).toBe(7);
    expect(handle.session).toBe(fakeSession);
    expect(handle.context).toEqual({ userId, workspaceId, workspaceName: "Personal", accountLabel: "a@b.co" });
  });

  it("propagates a getNote failure (the workbench context handles a rejected factory)", async () => {
    const factory = createWorkbenchSessionFactory(config, {
      openSession: vi.fn(),
      noteReader: { getNote: vi.fn(async () => { throw new Error("offline"); }) },
      lifecycle: {} as never,
      draftStore: {} as never,
      documentAnalysis: {} as never,
      makeLock: vi.fn(),
    });
    await expect(factory(fakeNote())).rejects.toThrow("offline");
  });
});
