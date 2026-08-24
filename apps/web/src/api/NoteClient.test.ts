import { describe, expect, it, vi } from "vitest";
import {
  NoteApiError,
  NoteClient,
  NoteConflictError,
  NoteOfflineError,
  NoteRequestValidationError,
} from "./NoteClient.js";

const NOTE_ID = "44444444-4444-4444-8444-444444444444";
const OP_ID = "66666666-6666-4666-8666-666666666666";
const WORKSPACE_ID = "33333333-3333-4333-8333-333333333333";
const OTHER_NOTE_ID = "55555555-5555-4555-8555-555555555555";
const VERSION_ID = "77777777-7777-4777-8777-777777777777";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function noteResultFixture(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: NOTE_ID,
    workspaceId: WORKSPACE_ID,
    title: "Meeting notes",
    revision: 2,
    visibility: "private",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:05:00.000Z",
    deletedAt: null,
    contentMarkdown: "# Hi",
    schemaVersion: 1,
    ...overrides,
  };
}

function noteSummaryFixture(overrides: Partial<Record<string, unknown>> = {}) {
  const {
    contentMarkdown: _contentMarkdown,
    schemaVersion: _schemaVersion,
    ...summary
  } = noteResultFixture(overrides);
  return summary;
}

function noteVersionFixture(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: VERSION_ID,
    noteId: NOTE_ID,
    revision: 2,
    reason: "checkpoint",
    createdBy: { displayName: "Ada" },
    createdAt: "2026-01-01T00:05:00.000Z",
    contentMarkdown: "# Hi",
    schemaVersion: 1,
    ...overrides,
  };
}

function noteVersionSummaryFixture(overrides: Partial<Record<string, unknown>> = {}) {
  const {
    contentMarkdown: _contentMarkdown,
    schemaVersion: _schemaVersion,
    ...summary
  } = noteVersionFixture(overrides);
  return summary;
}

describe("NoteClient", () => {
  it("saves content via PUT to the note's content endpoint and returns the parsed result", async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe(`/api/v1/notes/${NOTE_ID}/content`);
      expect(init?.method).toBe("PUT");
      expect(JSON.parse(String(init?.body))).toEqual({
        operationId: OP_ID,
        baseRevision: 1,
        contentMarkdown: "# Hi",
      });
      return jsonResponse(200, noteResultFixture());
    });
    const client = new NoteClient({ fetchImpl });

    const result = await client.save(NOTE_ID, {
      operationId: OP_ID,
      baseRevision: 1,
      contentMarkdown: "# Hi",
    });

    expect(result.revision).toBe(2);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("fetches a note via GET and returns the parsed result", async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe(`/api/v1/notes/${NOTE_ID}`);
      expect(init?.method).toBe("GET");
      return jsonResponse(200, noteResultFixture());
    });
    const client = new NoteClient({ fetchImpl });

    const result = await client.getNote(NOTE_ID);

    expect(result.id).toBe(NOTE_ID);
  });

  it("throws NoteConflictError with the parsed server state on a 409 from save", async () => {
    const conflictBody = {
      code: "REVISION_CONFLICT",
      noteId: NOTE_ID,
      serverRevision: 5,
      serverMarkdown: "# Someone else's edit",
      serverUpdatedAt: "2026-01-01T00:10:00.000Z",
      lastEditedBy: { displayName: "Ada" },
      requestId: "req-1",
    };
    const fetchImpl = vi.fn(async () => jsonResponse(409, conflictBody));
    const client = new NoteClient({ fetchImpl });

    const attempt = client.save(NOTE_ID, {
      operationId: OP_ID,
      baseRevision: 1,
      contentMarkdown: "x",
    });

    await expect(attempt).rejects.toBeInstanceOf(NoteConflictError);
    await attempt.catch((error: unknown) => {
      expect(error).toBeInstanceOf(NoteConflictError);
      expect((error as NoteConflictError).conflict).toEqual(conflictBody);
    });
  });

  it("throws a typed NoteApiError for a generic error envelope", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(400, {
        error: { code: "DOCUMENT_INVALID", message: "The request is invalid", requestId: "req-2" },
      }),
    );
    const client = new NoteClient({ fetchImpl });

    const attempt = client.save(NOTE_ID, {
      operationId: OP_ID,
      baseRevision: 1,
      contentMarkdown: "x",
    });

    await expect(attempt).rejects.toBeInstanceOf(NoteApiError);
    await attempt.catch((error: unknown) => {
      const apiError = error as NoteApiError;
      expect(apiError.code).toBe("DOCUMENT_INVALID");
      expect(apiError.status).toBe(400);
      expect(apiError.requestId).toBe("req-2");
    });
  });

  it("throws NoteOfflineError when the request never reaches the server", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    });
    const client = new NoteClient({ fetchImpl });

    const attempt = client.getNote(NOTE_ID);

    await expect(attempt).rejects.toBeInstanceOf(NoteOfflineError);
  });

  it("throws a generic NoteApiError when an error response body does not match any known shape", async () => {
    const fetchImpl = vi.fn(async () => new Response("<html>Bad gateway</html>", { status: 502 }));
    const client = new NoteClient({ fetchImpl });

    const attempt = client.getNote(NOTE_ID);

    await expect(attempt).rejects.toBeInstanceOf(NoteApiError);
    await attempt.catch((error: unknown) => {
      expect((error as NoteApiError).code).toBe("SERVICE_UNAVAILABLE");
      expect((error as NoteApiError).status).toBe(502);
    });
  });

  it("rejects an invalid request locally without exposing schema details or calling fetch", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, noteResultFixture()));
    const client = new NoteClient({ fetchImpl });

    const attempt = client.getNote("not-a-uuid");

    await expect(attempt).rejects.toBeInstanceOf(NoteRequestValidationError);
    await attempt.catch((error: unknown) => {
      expect((error as Error).message).toBe("Invalid getNote request");
      expect((error as Error).cause).toBeUndefined();
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("maps malformed success JSON and schema-invalid responses to a safe API error", async () => {
    const malformedJsonClient = new NoteClient({
      fetchImpl: vi.fn(async () => new Response("not json", { status: 200 })),
    });
    const invalidShapeClient = new NoteClient({
      fetchImpl: vi.fn(async () => jsonResponse(200, { id: NOTE_ID, secret: "leak" })),
    });

    for (const attempt of [
      malformedJsonClient.getNote(NOTE_ID),
      invalidShapeClient.getNote(NOTE_ID),
    ]) {
      await expect(attempt).rejects.toMatchObject({
        name: "NoteApiError",
        code: "SERVICE_UNAVAILABLE",
        status: 502,
        requestId: "unknown",
      });
    }
  });

  it("rejects a successful response whose resource identity does not match the request", async () => {
    const client = new NoteClient({
      fetchImpl: vi.fn(async () => jsonResponse(200, noteResultFixture({ id: OTHER_NOTE_ID }))),
    });

    await expect(client.getNote(NOTE_ID)).rejects.toMatchObject({
      name: "NoteApiError",
      code: "SERVICE_UNAVAILABLE",
      status: 502,
    });
  });

  it("does not surface a forged conflict for another note", async () => {
    const client = new NoteClient({
      fetchImpl: vi.fn(async () =>
        jsonResponse(409, {
          code: "REVISION_CONFLICT",
          noteId: OTHER_NOTE_ID,
          serverRevision: 5,
          serverMarkdown: "# Wrong note",
          serverUpdatedAt: "2026-01-01T00:10:00.000Z",
          lastEditedBy: { displayName: "Ada" },
          requestId: "req-forged",
        }),
      ),
    });

    const attempt = client.save(NOTE_ID, {
      operationId: OP_ID,
      baseRevision: 1,
      contentMarkdown: "x",
    });
    await expect(attempt).rejects.toMatchObject({
      name: "NoteApiError",
      code: "SERVICE_UNAVAILABLE",
      status: 502,
      requestId: "unknown",
    });
  });

  it("routes and validates every remaining note endpoint through the shared contract", async () => {
    const responses: unknown[] = [
      { items: [noteSummaryFixture()], nextCursor: null },
      noteResultFixture(),
      noteResultFixture(),
      noteResultFixture(),
      noteResultFixture(),
      { items: [noteVersionSummaryFixture()], nextCursor: null },
      { note: noteResultFixture(), version: noteVersionFixture() },
      noteVersionFixture(),
      noteResultFixture(),
    ];
    const fetchImpl = vi.fn(async () => jsonResponse(200, responses.shift()));
    const client = new NoteClient({ fetchImpl });

    await client.listNotes(WORKSPACE_ID, {});
    await client.createNote(WORKSPACE_ID, {
      operationId: OP_ID,
      title: "Meeting notes",
      contentMarkdown: "# Hi",
      visibility: "private",
    });
    await client.renameNote(NOTE_ID, {
      operationId: OP_ID,
      baseRevision: 1,
      title: "Renamed",
    });
    await client.deleteNote(NOTE_ID, { operationId: OP_ID, baseRevision: 1 });
    await client.restoreNote(NOTE_ID, { operationId: OP_ID, baseRevision: 1 });
    await client.listNoteVersions(NOTE_ID, {});
    await client.checkpointNote(NOTE_ID, { operationId: OP_ID, baseRevision: 1 });
    await client.getNoteVersion(NOTE_ID, VERSION_ID);
    await client.restoreNoteVersion(NOTE_ID, VERSION_ID, {
      operationId: OP_ID,
      baseRevision: 1,
    });

    expect(fetchImpl.mock.calls.map(([url, init]) => [url, init?.method])).toEqual([
      [`/api/v1/workspaces/${WORKSPACE_ID}/notes?pageSize=50`, "GET"],
      [`/api/v1/workspaces/${WORKSPACE_ID}/notes`, "POST"],
      [`/api/v1/notes/${NOTE_ID}/title`, "PATCH"],
      [`/api/v1/notes/${NOTE_ID}`, "DELETE"],
      [`/api/v1/notes/${NOTE_ID}/restore`, "POST"],
      [`/api/v1/notes/${NOTE_ID}/versions?pageSize=50`, "GET"],
      [`/api/v1/notes/${NOTE_ID}/versions/checkpoint`, "POST"],
      [`/api/v1/notes/${NOTE_ID}/versions/${VERSION_ID}`, "GET"],
      [`/api/v1/notes/${NOTE_ID}/versions/${VERSION_ID}/restore`, "POST"],
    ]);
  });

  it("rejects cross-workspace and cross-note items in paginated responses", async () => {
    const wrongWorkspaceClient = new NoteClient({
      fetchImpl: vi.fn(async () =>
        jsonResponse(200, {
          items: [
            noteSummaryFixture({
              workspaceId: "88888888-8888-4888-8888-888888888888",
            }),
          ],
          nextCursor: null,
        }),
      ),
    });
    const wrongNoteClient = new NoteClient({
      fetchImpl: vi.fn(async () =>
        jsonResponse(200, {
          items: [noteVersionSummaryFixture({ noteId: OTHER_NOTE_ID })],
          nextCursor: null,
        }),
      ),
    });

    await expect(wrongWorkspaceClient.listNotes(WORKSPACE_ID, {})).rejects.toBeInstanceOf(
      NoteApiError,
    );
    await expect(wrongNoteClient.listNoteVersions(NOTE_ID, {})).rejects.toBeInstanceOf(
      NoteApiError,
    );
  });
});
