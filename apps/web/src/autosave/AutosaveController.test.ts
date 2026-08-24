import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { canonicalUuidSchema } from "@glyphquire/api-contract";
import { NoteApiError, NoteConflictError, NoteOfflineError } from "../api/NoteClient.js";
import { AutosaveController } from "./AutosaveController.js";
import type { AutosaveSaveFn } from "./AutosaveController.js";

const NOTE_CONFLICT = {
  code: "REVISION_CONFLICT" as const,
  noteId: "44444444-4444-4444-8444-444444444444",
  serverRevision: 9,
  serverMarkdown: "# server wins",
  serverUpdatedAt: "2026-01-01T00:00:00.000Z",
  lastEditedBy: { displayName: "Ada" },
  requestId: "req-conflict",
};

function operationIdSequence(): () => string {
  let n = 0;
  return () => `00000000-0000-4000-8000-${(n += 1).toString().padStart(12, "0")}`;
}

/** A controllable save() double: each call is captured and resolved/rejected on demand. */
function deferredSaveFn() {
  const calls: { operationId: string; baseRevision: number; contentMarkdown: string }[] = [];
  const pending: {
    input: { operationId: string; baseRevision: number; contentMarkdown: string };
    resolve: (v: { revision: number; contentMarkdown: string }) => void;
    reject: (e: unknown) => void;
  }[] = [];
  const fn: AutosaveSaveFn = (input) =>
    new Promise((resolve, reject) => {
      calls.push(input);
      pending.push({ input, resolve, reject });
    });
  return {
    fn,
    calls,
    resolveNext(revision: number, contentMarkdown?: string): void {
      const next = pending.shift();
      if (!next) throw new Error("No pending save call to resolve");
      next.resolve({
        revision,
        contentMarkdown: contentMarkdown ?? next.input.contentMarkdown,
      });
    },
    rejectNext(error: unknown): void {
      const next = pending.shift();
      if (!next) throw new Error("No pending save call to reject");
      next.reject(error);
    },
  };
}

describe("AutosaveController", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("starts clean", () => {
    const controller = new AutosaveController({
      initialRevision: 1,
      save: deferredSaveFn().fn,
      generateOperationId: operationIdSequence(),
    });

    expect(controller.getState().status).toBe("clean");
    expect(controller.getState().revision).toBe(1);
  });

  it("uses a canonical random UUID operation id when production does not inject a generator", () => {
    const controller = new AutosaveController({
      initialRevision: 1,
      save: deferredSaveFn().fn,
    });

    controller.edit("draft");

    expect(canonicalUuidSchema.safeParse(controller.getState().pending?.operationId).success).toBe(
      true,
    );
  });

  it("moves clean -> dirty -> saving -> saved on a normal edit/save cycle", async () => {
    const deferred = deferredSaveFn();
    const controller = new AutosaveController({
      initialRevision: 1,
      save: deferred.fn,
      generateOperationId: operationIdSequence(),
    });
    const states: string[] = [];
    controller.subscribe((state) => states.push(state.status));

    controller.edit("# hello");
    expect(controller.getState().status).toBe("dirty");

    await vi.advanceTimersByTimeAsync(1500);
    expect(controller.getState().status).toBe("saving");
    expect(deferred.calls).toHaveLength(1);
    expect(deferred.calls[0]).toEqual({
      operationId: "00000000-0000-4000-8000-000000000001",
      baseRevision: 1,
      contentMarkdown: "# hello",
    });

    deferred.resolveNext(2);
    await vi.waitFor(() => expect(controller.getState().status).toBe("saved"));

    expect(controller.getState().revision).toBe(2);
    expect(controller.getState().lastSavedAt).not.toBeNull();
    expect(states).toEqual(["dirty", "saving", "saved"]);
  });

  it("debounces for exactly 1.5 seconds — not a moment sooner", async () => {
    const deferred = deferredSaveFn();
    const controller = new AutosaveController({
      initialRevision: 1,
      save: deferred.fn,
      generateOperationId: operationIdSequence(),
    });

    controller.edit("# hello");
    await vi.advanceTimersByTimeAsync(1499);
    expect(controller.getState().status).toBe("dirty");
    expect(deferred.calls).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(1);
    expect(controller.getState().status).toBe("saving");
    expect(deferred.calls).toHaveLength(1);
  });

  it("resets the debounce window on every new edit", async () => {
    const deferred = deferredSaveFn();
    const controller = new AutosaveController({
      initialRevision: 1,
      save: deferred.fn,
      generateOperationId: operationIdSequence(),
    });

    controller.edit("a");
    await vi.advanceTimersByTimeAsync(1000);
    controller.edit("ab");
    await vi.advanceTimersByTimeAsync(1000);
    expect(deferred.calls).toHaveLength(0); // only 1000ms since the latest edit

    await vi.advanceTimersByTimeAsync(500);
    expect(deferred.calls).toHaveLength(1);
    expect(deferred.calls[0]?.contentMarkdown).toBe("ab");
  });

  it("saveNow triggers an immediate save, bypassing the debounce timer", async () => {
    const deferred = deferredSaveFn();
    const controller = new AutosaveController({
      initialRevision: 1,
      save: deferred.fn,
      generateOperationId: operationIdSequence(),
    });

    controller.edit("# hello");
    const savePromise = controller.saveNow();
    expect(controller.getState().status).toBe("saving");
    expect(deferred.calls).toHaveLength(1);

    deferred.resolveNext(2);
    await savePromise;
    expect(controller.getState().status).toBe("saved");
  });

  it("keeps exactly one request in flight and folds a queued edit into one automatic follow-up save", async () => {
    const deferred = deferredSaveFn();
    const controller = new AutosaveController({
      initialRevision: 1,
      save: deferred.fn,
      generateOperationId: operationIdSequence(),
    });

    controller.edit("v1");
    await controller.saveNow();
    expect(deferred.calls).toHaveLength(1);
    expect(controller.getState().status).toBe("saving");

    // An edit arriving mid-flight must not start a second concurrent request.
    controller.edit("v2");
    expect(deferred.calls).toHaveLength(1);
    expect(controller.getState().status).toBe("saving");
    expect(controller.getState().pending).toEqual({
      operationId: "00000000-0000-4000-8000-000000000002",
      baseRevision: 1,
      markdown: "v2",
    });

    deferred.resolveNext(2);
    await vi.waitFor(() => expect(deferred.calls).toHaveLength(2));
    expect(deferred.calls[1]).toEqual({
      operationId: "00000000-0000-4000-8000-000000000002",
      baseRevision: 2,
      contentMarkdown: "v2",
    });

    deferred.resolveNext(3);
    await vi.waitFor(() => expect(controller.getState().status).toBe("saved"));
    expect(controller.getState().revision).toBe(3);
  });

  it("replays retained work after pause and resume even when the resumed debounce expires in flight", async () => {
    const deferred = deferredSaveFn();
    const controller = new AutosaveController({
      initialRevision: 1,
      save: deferred.fn,
      generateOperationId: operationIdSequence(),
    });

    controller.edit("v1");
    await controller.saveNow();
    expect(deferred.calls).toHaveLength(1);

    controller.pause();
    controller.resume();
    await vi.advanceTimersByTimeAsync(1500);
    expect(deferred.calls).toHaveLength(1);

    deferred.resolveNext(2);
    await vi.waitFor(() => expect(deferred.calls).toHaveLength(2));
    expect(deferred.calls[1]).toEqual(deferred.calls[0]);

    deferred.resolveNext(2);
    await vi.waitFor(() => expect(controller.getState().status).toBe("saved"));
    expect(controller.getState().revision).toBe(2);
  });

  it("reuses the same operation id across automatic retries of one failed attempt", async () => {
    const deferred = deferredSaveFn();
    const controller = new AutosaveController({
      initialRevision: 1,
      save: deferred.fn,
      generateOperationId: operationIdSequence(),
      retryBaseMs: 1000,
    });

    controller.edit("# hello");
    await controller.saveNow();
    expect(deferred.calls[0]?.operationId).toBe("00000000-0000-4000-8000-000000000001");

    deferred.rejectNext(new NoteOfflineError());
    await vi.waitFor(() => expect(controller.getState().status).toBe("offline"));

    await vi.advanceTimersByTimeAsync(1000);
    await vi.waitFor(() => expect(deferred.calls).toHaveLength(2));
    expect(deferred.calls[1]?.operationId).toBe("00000000-0000-4000-8000-000000000001"); // same attempt, not a new operation
    expect(deferred.calls[1]?.contentMarkdown).toBe("# hello");

    deferred.rejectNext(new NoteOfflineError());
    await vi.waitFor(() => expect(controller.getState().status).toBe("offline"));
    await vi.advanceTimersByTimeAsync(2000); // exponential backoff: second retry waits longer
    await vi.waitFor(() => expect(deferred.calls).toHaveLength(3));
    expect(deferred.calls[2]?.operationId).toBe("00000000-0000-4000-8000-000000000001");
  });

  it("goes to error (not offline) for a non-network API failure, and still retries", async () => {
    const deferred = deferredSaveFn();
    const controller = new AutosaveController({
      initialRevision: 1,
      save: deferred.fn,
      generateOperationId: operationIdSequence(),
      retryBaseMs: 500,
    });

    controller.edit("# hello");
    await controller.saveNow();
    deferred.rejectNext(new NoteApiError("SERVICE_UNAVAILABLE", 503, "req-x"));

    await vi.waitFor(() => expect(controller.getState().status).toBe("error"));
    expect(controller.getState().lastError).toEqual({
      code: "SERVICE_UNAVAILABLE",
      message: expect.any(String),
    });

    await vi.advanceTimersByTimeAsync(500);
    await vi.waitFor(() => expect(deferred.calls).toHaveLength(2));
  });

  it("mints a fresh operation id if the user edits again after a failed attempt", async () => {
    const deferred = deferredSaveFn();
    const controller = new AutosaveController({
      initialRevision: 1,
      save: deferred.fn,
      generateOperationId: operationIdSequence(),
      retryBaseMs: 10_000,
    });

    controller.edit("v1");
    await controller.saveNow();
    deferred.rejectNext(new NoteOfflineError());
    await vi.waitFor(() => expect(controller.getState().status).toBe("offline"));

    // New content before the backoff timer fires abandons the stale attempt.
    controller.edit("v2");
    expect(controller.getState().status).toBe("dirty");

    await controller.saveNow();
    expect(deferred.calls).toHaveLength(2);
    expect(deferred.calls[1]).toEqual({
      operationId: "00000000-0000-4000-8000-000000000002",
      baseRevision: 1,
      contentMarkdown: "v2",
    });
  });

  it("moves to conflict on a 409 and never auto-retries it", async () => {
    const deferred = deferredSaveFn();
    const controller = new AutosaveController({
      initialRevision: 1,
      save: deferred.fn,
      generateOperationId: operationIdSequence(),
      retryBaseMs: 100,
    });

    controller.edit("# mine");
    await controller.saveNow();
    deferred.rejectNext(new NoteConflictError(NOTE_CONFLICT));

    await vi.waitFor(() => expect(controller.getState().status).toBe("conflict"));
    expect(controller.getState().conflict).toEqual(NOTE_CONFLICT);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(deferred.calls).toHaveLength(1); // no automatic retry, ever

    controller.resolveConflict(NOTE_CONFLICT.serverRevision);
    expect(controller.getState().status).toBe("dirty");
    expect(controller.getState().revision).toBe(NOTE_CONFLICT.serverRevision);

    await vi.advanceTimersByTimeAsync(1500);
    expect(deferred.calls).toHaveLength(2);
    expect(deferred.calls[1]?.baseRevision).toBe(NOTE_CONFLICT.serverRevision);
  });

  it("does not regress or clear local state when a stale acknowledgement arrives", async () => {
    const deferred = deferredSaveFn();
    const controller = new AutosaveController({
      initialRevision: 5,
      save: deferred.fn,
      generateOperationId: operationIdSequence(),
    });

    controller.edit("authoritative local markdown");
    await controller.saveNow();
    deferred.resolveNext(4);

    await vi.waitFor(() => expect(controller.getState().status).toBe("error"));
    expect(controller.getState().revision).toBe(5);
    expect(controller.getState().pending?.markdown).toBe("authoritative local markdown");
    expect(controller.getState().lastError?.code).toBe("STALE_ACKNOWLEDGEMENT");
  });

  it("does not accept an acknowledgement for different markdown", async () => {
    const deferred = deferredSaveFn();
    const controller = new AutosaveController({
      initialRevision: 1,
      save: deferred.fn,
      generateOperationId: operationIdSequence(),
    });

    controller.edit("authoritative local markdown");
    await controller.saveNow();
    deferred.resolveNext(2, "forged response markdown");

    await vi.waitFor(() => expect(controller.getState().status).toBe("error"));
    expect(controller.getState().revision).toBe(1);
    expect(controller.getState().pending?.markdown).toBe("authoritative local markdown");
    expect(controller.getState().lastError?.code).toBe("STALE_ACKNOWLEDGEMENT");
  });

  it("exposes the pending attempt eagerly, before the debounce timer ever fires, and clears it once saved", async () => {
    const deferred = deferredSaveFn();
    const controller = new AutosaveController({
      initialRevision: 1,
      save: deferred.fn,
      generateOperationId: operationIdSequence(),
    });

    expect(controller.getState().pending).toBeNull();

    controller.edit("draft content");
    expect(controller.getState().pending).toEqual({
      operationId: "00000000-0000-4000-8000-000000000001",
      baseRevision: 1,
      markdown: "draft content",
    });

    await controller.saveNow();
    deferred.resolveNext(2);
    await vi.waitFor(() => expect(controller.getState().status).toBe("saved"));
    expect(controller.getState().pending).toBeNull();
  });

  it("recovers a prior session's pending attempt and sends it immediately under the same operation id", async () => {
    const deferred = deferredSaveFn();
    const controller = new AutosaveController({
      initialRevision: 3,
      save: deferred.fn,
      generateOperationId: operationIdSequence(),
    });

    controller.recoverPendingAttempt({
      operationId: "77777777-7777-4777-8777-777777777777",
      baseRevision: 3,
      markdown: "unsent draft",
    });

    expect(controller.getState().status).toBe("saving");
    expect(deferred.calls).toEqual([
      {
        operationId: "77777777-7777-4777-8777-777777777777",
        baseRevision: 3,
        contentMarkdown: "unsent draft",
      },
    ]);

    deferred.resolveNext(4);
    await vi.waitFor(() => expect(controller.getState().status).toBe("saved"));
    expect(controller.getState().revision).toBe(4);
  });

  it("does nothing on saveNow when there is nothing dirty", async () => {
    const deferred = deferredSaveFn();
    const controller = new AutosaveController({
      initialRevision: 1,
      save: deferred.fn,
      generateOperationId: operationIdSequence(),
    });

    await controller.saveNow();
    expect(deferred.calls).toHaveLength(0);
    expect(controller.getState().status).toBe("clean");
  });

  it("stops applying results after dispose", async () => {
    const deferred = deferredSaveFn();
    const controller = new AutosaveController({
      initialRevision: 1,
      save: deferred.fn,
      generateOperationId: operationIdSequence(),
    });

    controller.edit("# hello");
    await controller.saveNow();
    controller.dispose();
    deferred.resolveNext(2);
    await Promise.resolve();
    await Promise.resolve();

    expect(controller.getState().revision).toBe(1); // the late result must not regress/alter disposed state
  });
});
