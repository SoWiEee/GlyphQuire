import { describe, expect, expectTypeOf, it } from "vitest";
import {
  createApiClient,
  noteApiContract as publicNoteApiContract,
  saveNoteInputSchema as publicSaveNoteInputSchema,
} from "@glyphquire/api-contract";
import type {
  ApiErrorCode,
  ApiErrorEnvelope,
  NoteConflict,
  NoteMutation,
  SaveNoteInput,
} from "./types.js";
import { API_ERROR_CODES, apiErrorEnvelopeSchema, noteConflictSchema } from "./errors.js";
import {
  canonicalUuidSchema,
  checkpointNoteInputSchema,
  createNoteInputSchema,
  cursorSchema,
  cursorPaginationQuerySchema,
  deleteNoteInputSchema,
  DEFAULT_PAGE_SIZE,
  MAX_CURSOR_BYTES,
  MAX_MARKDOWN_BYTES,
  MAX_PAGE_SIZE,
  MAX_TITLE_CODE_POINTS,
  markdownSchema,
  noteApiContract,
  checkpointNoteResultSchema,
  notePageSchema,
  noteResultSchema,
  noteTitleSchema,
  noteVersionPageSchema,
  noteVersionResultSchema,
  renameNoteInputSchema,
  restoreNoteInputSchema,
  restoreNoteVersionInputSchema,
  saveNoteInputSchema,
} from "./schemas.js";

const canonicalUuid = "123e4567-e89b-42d3-a456-426614174000";

describe("note API schemas", () => {
  it("accepts exactly 2 MiB of UTF-8 Markdown and rejects 2 MiB plus one byte", () => {
    const exactlyAtLimit = "é".repeat(MAX_MARKDOWN_BYTES / 2);
    const oneByteOverLimit = `${exactlyAtLimit}a`;

    expect(new TextEncoder().encode(exactlyAtLimit)).toHaveLength(2 * 1024 * 1024);
    expect(new TextEncoder().encode(oneByteOverLimit)).toHaveLength(2 * 1024 * 1024 + 1);
    expect(markdownSchema.safeParse(exactlyAtLimit).success).toBe(true);
    expect(markdownSchema.safeParse(oneByteOverLimit).success).toBe(false);
  });

  it("counts title limits in Unicode code points rather than UTF-16 code units", () => {
    const oneCodePoint = "😀";
    const exactlyAtLimit = oneCodePoint.repeat(MAX_TITLE_CODE_POINTS);
    const oneCodePointOverLimit = `${exactlyAtLimit}${oneCodePoint}`;

    expect(oneCodePoint).toHaveLength(2);
    expect([...exactlyAtLimit]).toHaveLength(200);
    expect([...oneCodePointOverLimit]).toHaveLength(201);
    expect(noteTitleSchema.safeParse(oneCodePoint).success).toBe(true);
    expect(noteTitleSchema.safeParse(exactlyAtLimit).success).toBe(true);
    expect(noteTitleSchema.safeParse("").success).toBe(false);
    expect(noteTitleSchema.safeParse(oneCodePointOverLimit).success).toBe(false);
  });

  it("accepts only canonical 36-character UUID resource and operation identifiers", () => {
    expect(canonicalUuid).toHaveLength(36);
    expect(canonicalUuidSchema.safeParse(canonicalUuid).success).toBe(true);
    expect(canonicalUuidSchema.safeParse("123e4567e89b42d3a456426614174000").success).toBe(false);
    expect(canonicalUuidSchema.safeParse(`${canonicalUuid}0`).success).toBe(false);
    expect(canonicalUuidSchema.safeParse(canonicalUuid.toUpperCase()).success).toBe(false);
    expect(canonicalUuidSchema.safeParse("00000000-0000-0000-0000-000000000000").success).toBe(
      false,
    );
  });

  it("accepts a 512-byte multibyte cursor and rejects 513 UTF-8 bytes", () => {
    const exactlyAtLimit = `${"界".repeat(170)}ab`;
    const oneByteOverLimit = `${exactlyAtLimit}c`;

    expect(new TextEncoder().encode(exactlyAtLimit)).toHaveLength(MAX_CURSOR_BYTES);
    expect(new TextEncoder().encode(oneByteOverLimit)).toHaveLength(MAX_CURSOR_BYTES + 1);
    expect(exactlyAtLimit.length).toBeLessThan(MAX_CURSOR_BYTES);
    expect(cursorSchema.safeParse(exactlyAtLimit).success).toBe(true);
    expect(cursorSchema.safeParse(oneByteOverLimit).success).toBe(false);
  });

  it("defaults omitted page size and enforces the inclusive 1 through 100 boundary", () => {
    expect(cursorPaginationQuerySchema.parse({})).toEqual({ pageSize: DEFAULT_PAGE_SIZE });
    expect(cursorPaginationQuerySchema.parse({ pageSize: 1 }).pageSize).toBe(1);
    expect(cursorPaginationQuerySchema.parse({ pageSize: String(MAX_PAGE_SIZE) }).pageSize).toBe(
      100,
    );
    expect(cursorPaginationQuerySchema.safeParse({ pageSize: 0 }).success).toBe(false);
    expect(cursorPaginationQuerySchema.safeParse({ pageSize: MAX_PAGE_SIZE + 1 }).success).toBe(
      false,
    );
  });

  it("requires a positive baseRevision on every existing-note mutation", () => {
    const cases = [
      {
        name: "rename",
        schema: renameNoteInputSchema,
        input: { operationId: canonicalUuid, title: "Renamed" },
      },
      {
        name: "save",
        schema: saveNoteInputSchema,
        input: { operationId: canonicalUuid, contentMarkdown: "# Saved" },
      },
      { name: "delete", schema: deleteNoteInputSchema, input: { operationId: canonicalUuid } },
      {
        name: "note restore",
        schema: restoreNoteInputSchema,
        input: { operationId: canonicalUuid },
      },
      {
        name: "checkpoint",
        schema: checkpointNoteInputSchema,
        input: { operationId: canonicalUuid },
      },
      {
        name: "version restore",
        schema: restoreNoteVersionInputSchema,
        input: { operationId: canonicalUuid },
      },
    ];

    for (const mutation of cases) {
      expect(mutation.schema.safeParse(mutation.input).success, mutation.name).toBe(false);
      expect(
        mutation.schema.safeParse({ ...mutation.input, baseRevision: 1 }).success,
        mutation.name,
      ).toBe(true);
      expect(
        mutation.schema.safeParse({ ...mutation.input, baseRevision: 0 }).success,
        mutation.name,
      ).toBe(false);
    }
  });

  it("scopes create idempotency without a note ID or base revision and permits only private", () => {
    const input = {
      operationId: canonicalUuid,
      title: "New note",
      contentMarkdown: "# New",
      visibility: "private",
    };

    expect(createNoteInputSchema.safeParse(input).success).toBe(true);
    expect(createNoteInputSchema.safeParse({ ...input, visibility: "workspace" }).success).toBe(
      false,
    );
    expect(createNoteInputSchema.safeParse({ ...input, noteId: canonicalUuid }).success).toBe(
      false,
    );
    expect(createNoteInputSchema.safeParse({ ...input, baseRevision: 1 }).success).toBe(false);
    expect(createNoteInputSchema.safeParse({ ...input, operationId: undefined }).success).toBe(
      false,
    );
  });

  it("accepts the complete authorized conflict shape and minimizes editor identity", () => {
    const conflict = {
      code: "REVISION_CONFLICT",
      noteId: canonicalUuid,
      serverRevision: 9,
      serverMarkdown: "# Server",
      serverUpdatedAt: "2026-08-22T02:00:00.000Z",
      lastEditedBy: { displayName: "Editor" },
      requestId: "request-conflict",
    };

    expect(noteConflictSchema.parse(conflict)).toEqual(conflict);
    expect(
      noteConflictSchema.safeParse({
        ...conflict,
        lastEditedBy: {
          displayName: "Editor",
          userId: canonicalUuid,
          email: "editor@example.test",
          session: "secret-session",
          ip: "192.0.2.1",
          userAgent: "secret-agent",
        },
      }).success,
    ).toBe(false);
    expect(noteConflictSchema.safeParse({ ...conflict, lastEditedBy: null }).success).toBe(true);
  });

  it("exposes only the stable uniform NOTE_NOT_FOUND error to an unauthorized caller", () => {
    const notFound = {
      error: {
        code: "NOTE_NOT_FOUND",
        message: "Note not found",
        requestId: "request-not-found",
      },
    };

    expect(API_ERROR_CODES).toEqual([
      "NOTE_NOT_FOUND",
      "REVISION_CONFLICT",
      "DOCUMENT_INVALID",
      "DOCUMENT_TOO_LARGE",
      "OPERATION_REUSED",
      "RATE_LIMITED",
      "SERVICE_UNAVAILABLE",
    ]);
    expect(apiErrorEnvelopeSchema.parse(notFound)).toEqual(notFound);
    expect(
      apiErrorEnvelopeSchema.safeParse({
        ...notFound,
        noteId: canonicalUuid,
        serverRevision: 9,
        serverMarkdown: "# Secret",
        lastEditedBy: { displayName: "Secret Editor" },
      }).success,
    ).toBe(false);
    expect(
      apiErrorEnvelopeSchema.safeParse({
        error: { ...notFound.error, stack: "secret stack", details: "secret SQL" },
      }).success,
    ).toBe(false);
    expect(
      apiErrorEnvelopeSchema.safeParse({
        error: { ...notFound.error, code: "INTERNAL_ERROR" },
      }).success,
    ).toBe(false);
  });

  it("defines transport-independent request schemas for all eleven Phase 2 routes", () => {
    expect(
      Object.fromEntries(
        Object.entries(noteApiContract).map(([name, endpoint]) => [
          name,
          `${endpoint.method} ${endpoint.path}`,
        ]),
      ),
    ).toEqual({
      listNotes: "GET /api/v1/workspaces/:workspaceId/notes",
      createNote: "POST /api/v1/workspaces/:workspaceId/notes",
      getNote: "GET /api/v1/notes/:noteId",
      renameNote: "PATCH /api/v1/notes/:noteId/title",
      saveNote: "PUT /api/v1/notes/:noteId/content",
      deleteNote: "DELETE /api/v1/notes/:noteId",
      restoreNote: "POST /api/v1/notes/:noteId/restore",
      listNoteVersions: "GET /api/v1/notes/:noteId/versions",
      checkpointNote: "POST /api/v1/notes/:noteId/versions/checkpoint",
      getNoteVersion: "GET /api/v1/notes/:noteId/versions/:versionId",
      restoreNoteVersion: "POST /api/v1/notes/:noteId/versions/:versionId/restore",
    });

    const workspaceParams = { workspaceId: canonicalUuid };
    const noteParams = { noteId: canonicalUuid };
    const noteVersionParams = { noteId: canonicalUuid, versionId: canonicalUuid };
    const mutation = { operationId: canonicalUuid, baseRevision: 1 };

    expect(
      noteApiContract.listNotes.request.safeParse({ params: workspaceParams, query: {} }).success,
    ).toBe(true);
    expect(
      noteApiContract.createNote.request.safeParse({
        params: workspaceParams,
        body: {
          operationId: canonicalUuid,
          title: "Created",
          contentMarkdown: "",
          visibility: "private",
        },
      }).success,
    ).toBe(true);
    expect(noteApiContract.getNote.request.safeParse({ params: noteParams }).success).toBe(true);
    expect(
      noteApiContract.renameNote.request.safeParse({
        params: noteParams,
        body: { ...mutation, title: "Renamed" },
      }).success,
    ).toBe(true);
    expect(
      noteApiContract.saveNote.request.safeParse({
        params: noteParams,
        body: { ...mutation, contentMarkdown: "# Saved" },
      }).success,
    ).toBe(true);
    expect(
      noteApiContract.deleteNote.request.safeParse({ params: noteParams, body: mutation }).success,
    ).toBe(true);
    expect(
      noteApiContract.restoreNote.request.safeParse({ params: noteParams, body: mutation }).success,
    ).toBe(true);
    expect(
      noteApiContract.listNoteVersions.request.safeParse({ params: noteParams, query: {} }).success,
    ).toBe(true);
    expect(
      noteApiContract.checkpointNote.request.safeParse({ params: noteParams, body: mutation })
        .success,
    ).toBe(true);
    expect(
      noteApiContract.getNoteVersion.request.safeParse({ params: noteVersionParams }).success,
    ).toBe(true);
    expect(
      noteApiContract.restoreNoteVersion.request.safeParse({
        params: noteVersionParams,
        body: mutation,
      }).success,
    ).toBe(true);
  });

  it("defines strict success and cursor envelopes for notes and immutable versions", () => {
    const noteSummary = {
      id: canonicalUuid,
      workspaceId: canonicalUuid,
      title: "Contract note",
      revision: 3,
      visibility: "private",
      createdAt: "2026-08-22T01:00:00.000Z",
      updatedAt: "2026-08-22T02:00:00.000Z",
      deletedAt: null,
    };
    const note = {
      ...noteSummary,
      contentMarkdown: "# Contract",
      schemaVersion: 1,
    };
    const versionSummary = {
      id: canonicalUuid,
      noteId: canonicalUuid,
      revision: 2,
      reason: "checkpoint",
      createdBy: { displayName: "Editor" },
      createdAt: "2026-08-22T01:30:00.000Z",
    };
    const version = {
      ...versionSummary,
      contentMarkdown: "# Contract before edit",
      schemaVersion: 1,
    };

    expect(noteResultSchema.parse(note)).toEqual(note);
    expect(notePageSchema.parse({ items: [noteSummary], nextCursor: null })).toEqual({
      items: [noteSummary],
      nextCursor: null,
    });
    expect(noteVersionResultSchema.parse(version)).toEqual(version);
    expect(
      noteVersionPageSchema.parse({ items: [versionSummary], nextCursor: "next-page" }),
    ).toEqual({ items: [versionSummary], nextCursor: "next-page" });
    expect(checkpointNoteResultSchema.parse({ note, version })).toEqual({ note, version });

    expect(noteResultSchema.safeParse({ ...note, ownerId: canonicalUuid }).success).toBe(false);
    expect(
      noteVersionResultSchema.safeParse({
        ...version,
        createdBy: { ...version.createdBy, email: "editor@example.test" },
      }).success,
    ).toBe(false);

    expect(noteApiContract.listNotes.response).toBe(notePageSchema);
    expect(noteApiContract.createNote.response).toBe(noteResultSchema);
    expect(noteApiContract.getNote.response).toBe(noteResultSchema);
    expect(noteApiContract.renameNote.response).toBe(noteResultSchema);
    expect(noteApiContract.saveNote.response).toBe(noteResultSchema);
    expect(noteApiContract.deleteNote.response).toBe(noteResultSchema);
    expect(noteApiContract.restoreNote.response).toBe(noteResultSchema);
    expect(noteApiContract.listNoteVersions.response).toBe(noteVersionPageSchema);
    expect(noteApiContract.checkpointNote.response).toBe(checkpointNoteResultSchema);
    expect(noteApiContract.getNoteVersion.response).toBe(noteVersionResultSchema);
    expect(noteApiContract.restoreNoteVersion.response).toBe(noteResultSchema);
  });

  it("infers the exact stable mutation, conflict, and safe-error interfaces", () => {
    expectTypeOf<NoteMutation>().toEqualTypeOf<{
      operationId: string;
      baseRevision: number;
    }>();
    expectTypeOf<SaveNoteInput>().toEqualTypeOf<NoteMutation & { contentMarkdown: string }>();
    expectTypeOf<NoteConflict>().toEqualTypeOf<{
      code: "REVISION_CONFLICT";
      noteId: string;
      serverRevision: number;
      serverMarkdown: string;
      serverUpdatedAt: string;
      lastEditedBy: { displayName: string } | null;
      requestId: string;
    }>();
    expectTypeOf<ApiErrorCode>().toEqualTypeOf<
      | "NOTE_NOT_FOUND"
      | "REVISION_CONFLICT"
      | "DOCUMENT_INVALID"
      | "DOCUMENT_TOO_LARGE"
      | "OPERATION_REUSED"
      | "RATE_LIMITED"
      | "SERVICE_UNAVAILABLE"
    >();
    expectTypeOf<ApiErrorEnvelope>().toEqualTypeOf<{
      error: { code: ApiErrorCode; message: string; requestId: string };
    }>();
  });

  it("gives API routes and web clients one public compile-time save schema", () => {
    const apiRouteSchema = publicNoteApiContract.saveNote.request.shape.body;
    const webClientSchema = publicSaveNoteInputSchema;

    expect(publicNoteApiContract).toBe(noteApiContract);
    expect(apiRouteSchema).toBe(saveNoteInputSchema);
    expect(webClientSchema).toBe(saveNoteInputSchema);
    expectTypeOf<typeof apiRouteSchema>().toEqualTypeOf<typeof webClientSchema>();
  });

  it("keeps createApiClient as a thin schema-validating transport adapter", async () => {
    const note = {
      id: canonicalUuid,
      workspaceId: canonicalUuid,
      title: "Adapter note",
      contentMarkdown: "# Adapter",
      schemaVersion: 1,
      revision: 1,
      visibility: "private",
      createdAt: "2026-08-22T01:00:00.000Z",
      updatedAt: "2026-08-22T01:00:00.000Z",
      deletedAt: null,
    };
    const calls: Array<{ endpoint: string; input: unknown }> = [];
    const client = createApiClient({
      request: async (endpoint, input) => {
        calls.push({ endpoint, input });
        return note;
      },
    });

    await expect(client.request("getNote", { params: { noteId: canonicalUuid } })).resolves.toEqual(
      note,
    );
    expect(client.contract).toBe(noteApiContract);
    expect(calls).toEqual([{ endpoint: "getNote", input: { params: { noteId: canonicalUuid } } }]);

    await expect(
      client.request("getNote", { params: { noteId: "not-a-uuid" } }),
    ).rejects.toBeDefined();
    expect(calls).toHaveLength(1);
  });
});
