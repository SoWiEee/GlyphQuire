import {
  apiErrorEnvelopeSchema,
  noteApiContract,
  noteConflictSchema,
} from "@glyphquire/api-contract";
import type {
  ApiClientTransport,
  ApiErrorCode,
  CheckpointNoteInput,
  CheckpointNoteResult,
  CreateNoteInput,
  DeleteNoteInput,
  ListNotesRequest,
  ListNoteVersionsRequest,
  NoteConflict,
  NoteEndpointName,
  NoteEndpointInput,
  NoteEndpointOutput,
  NotePage,
  NoteResult,
  NoteVersionPage,
  NoteVersionResult,
  RenameNoteInput,
  RestoreNoteInput,
  RestoreNoteVersionInput,
  SaveNoteInput,
} from "@glyphquire/api-contract";

/**
 * A well-formed API error response (`{ code, message, requestId }`) for any
 * endpoint other than `saveNote`'s revision conflict, which carries its own
 * richer shape and is surfaced as {@link NoteConflictError} instead.
 */
export class NoteApiError extends Error {
  constructor(
    readonly code: ApiErrorCode,
    readonly status: number,
    readonly requestId: string,
  ) {
    super(`Note API request failed: ${code}`);
    this.name = "NoteApiError";
  }
}

/** `saveNote` was rejected with 409 REVISION_CONFLICT — carries the server's current state. */
export class NoteConflictError extends Error {
  constructor(readonly conflict: NoteConflict) {
    super("REVISION_CONFLICT");
    this.name = "NoteConflictError";
  }
}

/** The request never reached the server (offline, DNS failure, CORS, timeout, ...). */
export class NoteOfflineError extends Error {
  constructor(cause?: unknown) {
    super("The note request could not be completed");
    this.name = "NoteOfflineError";
    this.cause = cause;
  }
}

/** A caller supplied data outside the shared request contract. */
export class NoteRequestValidationError extends Error {
  constructor(readonly endpoint: string) {
    super(`Invalid ${endpoint} request`);
    this.name = "NoteRequestValidationError";
  }
}

/** The configured transport prefix could escape the browser's same origin. */
export class NoteClientConfigurationError extends Error {
  constructor() {
    super("Invalid same-origin Note API base");
    this.name = "NoteClientConfigurationError";
  }
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

interface EndpointInputShape {
  params?: Record<string, string>;
  query?: Record<string, string | number>;
  body?: unknown;
}

const CANONICAL_RELATIVE_API_BASE = /^\/[A-Za-z0-9._~-]+(?:\/[A-Za-z0-9._~-]+)*$/;

/**
 * Accept only an empty prefix or a canonical root-relative path. Rejecting
 * URL syntax, escapes, dot segments, and backslashes up front keeps browser
 * and intermediary URL parsers from disagreeing about the request origin.
 */
function parseRelativeApiBase(value: unknown): string {
  if (value === "") return value;
  if (typeof value !== "string" || !CANONICAL_RELATIVE_API_BASE.test(value)) {
    throw new NoteClientConfigurationError();
  }
  if (value.split("/").some((segment) => segment === "." || segment === "..")) {
    throw new NoteClientConfigurationError();
  }
  return value;
}

function buildUrl(baseUrl: string, path: string, params: Record<string, string>): string {
  const withParams = path.replace(/:([a-zA-Z0-9_]+)/g, (match, key: string) => {
    const value = params[key];
    if (value === undefined) throw new Error(`Missing path parameter "${key}" for ${path}`);
    return encodeURIComponent(value);
  });
  return `${baseUrl}${withParams}`;
}

function withQuery(url: string, query: Record<string, string | number> | undefined): string {
  if (!query) return url;
  const entries = Object.entries(query).filter(([, value]) => value !== undefined);
  if (entries.length === 0) return url;
  const search = new URLSearchParams(entries.map(([key, value]) => [key, String(value)]));
  return `${url}?${search.toString()}`;
}

/**
 * Translates every {@link noteApiContract} call into a `fetch` request and
 * every non-2xx response into a typed error. This is the only place in the
 * web app that constructs a note-related HTTP request — everything else
 * (AutosaveController, EditorSession) depends on {@link NoteClient} instead.
 */
class FetchNoteTransport implements ApiClientTransport {
  constructor(
    private readonly fetchImpl: FetchLike,
    private readonly baseUrl: string,
  ) {}

  async request(endpoint: NoteEndpointName, input: unknown): Promise<unknown> {
    const contract = noteApiContract[endpoint];
    const { params, query, body } = (input ?? {}) as EndpointInputShape;
    const url = withQuery(buildUrl(this.baseUrl, contract.path, params ?? {}), query);

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: contract.method,
        headers: body !== undefined ? { "content-type": "application/json" } : undefined,
        body: body !== undefined ? JSON.stringify(body) : undefined,
        credentials: "same-origin",
      });
    } catch (cause) {
      throw new NoteOfflineError(cause);
    }

    if (response.ok) {
      if (response.status === 204) return undefined;
      try {
        return await response.json();
      } catch {
        throw invalidResponseError();
      }
    }
    return this.throwForErrorResponse(endpoint, response);
  }

  private async throwForErrorResponse(
    endpoint: NoteEndpointName,
    response: Response,
  ): Promise<never> {
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      payload = undefined;
    }

    if (endpoint === "saveNote" && response.status === 409) {
      const conflict = noteConflictSchema.safeParse(payload);
      if (conflict.success) throw new NoteConflictError(conflict.data);
    }

    const envelope = apiErrorEnvelopeSchema.safeParse(payload);
    if (envelope.success) {
      throw new NoteApiError(
        envelope.data.error.code,
        response.status,
        envelope.data.error.requestId,
      );
    }

    // The server returned something outside the documented contract entirely
    // (a proxy error page, an empty body, ...) — treat it as the generic
    // "try again" failure mode rather than guessing at a more specific code.
    throw new NoteApiError("SERVICE_UNAVAILABLE", response.status, "unknown");
  }
}

export interface NoteClientOptions {
  /** Canonical root-relative prefix; empty means same-origin `/api/v1/...`. */
  baseUrl?: string;
  fetchImpl?: FetchLike;
}

type ValidatedEndpointInput = {
  params?: {
    workspaceId?: string;
    noteId?: string;
    versionId?: string;
  };
};

function invalidResponseError(): NoteApiError {
  return new NoteApiError("SERVICE_UNAVAILABLE", 502, "unknown");
}

function responseIdentityMatches(
  endpoint: NoteEndpointName,
  input: ValidatedEndpointInput,
  response: NoteEndpointOutput<NoteEndpointName>,
): boolean {
  const workspaceId = input.params?.workspaceId;
  const noteId = input.params?.noteId;
  const versionId = input.params?.versionId;

  switch (endpoint) {
    case "listNotes":
      return (response as NotePage).items.every((note) => note.workspaceId === workspaceId);
    case "createNote":
      return (response as NoteResult).workspaceId === workspaceId;
    case "getNote":
    case "renameNote":
    case "saveNote":
    case "deleteNote":
    case "restoreNote":
    case "restoreNoteVersion":
      return (response as NoteResult).id === noteId;
    case "listNoteVersions":
      return (response as NoteVersionPage).items.every((version) => version.noteId === noteId);
    case "checkpointNote": {
      const checkpoint = response as CheckpointNoteResult;
      return (
        checkpoint.note.id === noteId &&
        checkpoint.version.noteId === noteId &&
        checkpoint.note.revision === checkpoint.version.revision
      );
    }
    case "getNoteVersion": {
      const version = response as NoteVersionResult;
      return version.id === versionId && version.noteId === noteId;
    }
  }
}

/**
 * The sole adapter between the editing module and the note API. Every method
 * validates its input against the shared contract schema before sending and
 * its response against the shared response schema after receiving, so a
 * drifted server response fails loudly here instead of corrupting editor
 * state downstream.
 */
export class NoteClient {
  private readonly transport: ApiClientTransport;

  constructor(options: NoteClientOptions = {}) {
    const baseUrl = parseRelativeApiBase(options.baseUrl ?? "");
    const fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.transport = new FetchNoteTransport(fetchImpl, baseUrl);
  }

  /**
   * Validates both sides of every note request and enforces that response
   * identities remain bound to the requested resource before returning data.
   */
  async request<TName extends NoteEndpointName>(
    endpoint: TName,
    input: NoteEndpointInput<TName>,
  ): Promise<NoteEndpointOutput<TName>> {
    const contract = noteApiContract[endpoint];
    if (!contract) throw new NoteRequestValidationError(String(endpoint));

    const parsedInput = contract.request.safeParse(input);
    if (!parsedInput.success) throw new NoteRequestValidationError(endpoint);

    let rawResponse: unknown;
    try {
      rawResponse = await this.transport.request(endpoint, parsedInput.data);
    } catch (error) {
      if (error instanceof NoteConflictError) {
        const requestedNoteId = (parsedInput.data as ValidatedEndpointInput).params?.noteId;
        if (endpoint !== "saveNote" || error.conflict.noteId !== requestedNoteId) {
          throw invalidResponseError();
        }
      }
      throw error;
    }

    const parsedResponse = contract.response.safeParse(rawResponse);
    if (!parsedResponse.success) throw invalidResponseError();
    const response = parsedResponse.data as NoteEndpointOutput<TName>;
    if (
      !responseIdentityMatches(
        endpoint,
        parsedInput.data as ValidatedEndpointInput,
        response as NoteEndpointOutput<NoteEndpointName>,
      )
    ) {
      throw invalidResponseError();
    }
    return response;
  }

  async listNotes(workspaceId: string, query: ListNotesRequest["query"]): Promise<NotePage> {
    return this.request("listNotes", { params: { workspaceId }, query });
  }

  async createNote(workspaceId: string, input: CreateNoteInput): Promise<NoteResult> {
    return this.request("createNote", { params: { workspaceId }, body: input });
  }

  async getNote(noteId: string): Promise<NoteResult> {
    return this.request("getNote", { params: { noteId } });
  }

  async renameNote(noteId: string, input: RenameNoteInput): Promise<NoteResult> {
    return this.request("renameNote", { params: { noteId }, body: input });
  }

  async save(noteId: string, input: SaveNoteInput): Promise<NoteResult> {
    return this.request("saveNote", { params: { noteId }, body: input });
  }

  async deleteNote(noteId: string, input: DeleteNoteInput): Promise<NoteResult> {
    return this.request("deleteNote", { params: { noteId }, body: input });
  }

  async restoreNote(noteId: string, input: RestoreNoteInput): Promise<NoteResult> {
    return this.request("restoreNote", { params: { noteId }, body: input });
  }

  async listNoteVersions(
    noteId: string,
    query: ListNoteVersionsRequest["query"],
  ): Promise<NoteVersionPage> {
    return this.request("listNoteVersions", { params: { noteId }, query });
  }

  async checkpointNote(noteId: string, input: CheckpointNoteInput): Promise<CheckpointNoteResult> {
    return this.request("checkpointNote", { params: { noteId }, body: input });
  }

  async getNoteVersion(noteId: string, versionId: string): Promise<NoteVersionResult> {
    return this.request("getNoteVersion", { params: { noteId, versionId } });
  }

  async restoreNoteVersion(
    noteId: string,
    versionId: string,
    input: RestoreNoteVersionInput,
  ): Promise<NoteResult> {
    return this.request("restoreNoteVersion", {
      params: { noteId, versionId },
      body: input,
    });
  }
}
