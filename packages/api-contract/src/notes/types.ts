import type { z } from "zod";
import type { apiErrorCodeSchema, apiErrorEnvelopeSchema, noteConflictSchema } from "./errors.js";
import type {
  checkpointNoteInputSchema,
  checkpointNoteRequestSchema,
  checkpointNoteResultSchema,
  createNoteInputSchema,
  createNoteRequestSchema,
  cursorPaginationQuerySchema,
  deleteNoteInputSchema,
  deleteNoteRequestSchema,
  getNoteRequestSchema,
  getNoteVersionRequestSchema,
  listNotesRequestSchema,
  listNoteVersionsRequestSchema,
  noteApiContract,
  noteIdParamsSchema,
  noteMutationSchema,
  notePageSchema,
  noteResultSchema,
  noteSummarySchema,
  noteVersionIdParamsSchema,
  noteVersionPageSchema,
  noteVersionResultSchema,
  noteVersionSummarySchema,
  noteVisibilitySchema,
  renameNoteInputSchema,
  renameNoteRequestSchema,
  restoreNoteInputSchema,
  restoreNoteRequestSchema,
  restoreNoteVersionInputSchema,
  restoreNoteVersionRequestSchema,
  saveNoteRequestSchema,
  workspaceIdParamsSchema,
} from "./schemas.js";

export type ApiErrorCode = z.infer<typeof apiErrorCodeSchema>;
export type ApiErrorEnvelope = z.infer<typeof apiErrorEnvelopeSchema>;
export type NoteConflict = z.infer<typeof noteConflictSchema>;

export type NoteVisibility = z.infer<typeof noteVisibilitySchema>;
export type NoteMutation = z.infer<typeof noteMutationSchema>;
export type CreateNoteInput = z.infer<typeof createNoteInputSchema>;
export type RenameNoteInput = z.infer<typeof renameNoteInputSchema>;
export type SaveNoteInput = NoteMutation & { contentMarkdown: string };
export type DeleteNoteInput = z.infer<typeof deleteNoteInputSchema>;
export type RestoreNoteInput = z.infer<typeof restoreNoteInputSchema>;
export type CheckpointNoteInput = z.infer<typeof checkpointNoteInputSchema>;
export type RestoreNoteVersionInput = z.infer<typeof restoreNoteVersionInputSchema>;

export type WorkspaceIdParams = z.infer<typeof workspaceIdParamsSchema>;
export type NoteIdParams = z.infer<typeof noteIdParamsSchema>;
export type NoteVersionIdParams = z.infer<typeof noteVersionIdParamsSchema>;
export type CursorPaginationQuery = z.infer<typeof cursorPaginationQuerySchema>;

export type ListNotesInput = WorkspaceIdParams & CursorPaginationQuery;
export type CreateNoteServiceInput = WorkspaceIdParams & CreateNoteInput;

export type ListNotesRequest = z.input<typeof listNotesRequestSchema>;
export type CreateNoteRequest = z.input<typeof createNoteRequestSchema>;
export type GetNoteRequest = z.input<typeof getNoteRequestSchema>;
export type RenameNoteRequest = z.input<typeof renameNoteRequestSchema>;
export type SaveNoteRequest = z.input<typeof saveNoteRequestSchema>;
export type DeleteNoteRequest = z.input<typeof deleteNoteRequestSchema>;
export type RestoreNoteRequest = z.input<typeof restoreNoteRequestSchema>;
export type ListNoteVersionsRequest = z.input<typeof listNoteVersionsRequestSchema>;
export type CheckpointNoteRequest = z.input<typeof checkpointNoteRequestSchema>;
export type GetNoteVersionRequest = z.input<typeof getNoteVersionRequestSchema>;
export type RestoreNoteVersionRequest = z.input<typeof restoreNoteVersionRequestSchema>;

export type NoteSummary = z.infer<typeof noteSummarySchema>;
export type NoteResult = z.infer<typeof noteResultSchema>;
export type NotePage = z.infer<typeof notePageSchema>;
export type NoteVersionSummary = z.infer<typeof noteVersionSummarySchema>;
export type NoteVersionResult = z.infer<typeof noteVersionResultSchema>;
export type NoteVersionPage = z.infer<typeof noteVersionPageSchema>;
export type CheckpointNoteResult = z.infer<typeof checkpointNoteResultSchema>;

export type NoteEndpointName = keyof typeof noteApiContract;
export type NoteEndpointInput<TName extends NoteEndpointName> = z.input<
  (typeof noteApiContract)[TName]["request"]
>;
export type NoteEndpointOutput<TName extends NoteEndpointName> = z.output<
  (typeof noteApiContract)[TName]["response"]
>;

export interface ApiClientTransport {
  request(endpoint: NoteEndpointName, input: unknown): Promise<unknown>;
}

export interface ApiClient {
  readonly contract: typeof noteApiContract;
  request<TName extends NoteEndpointName>(
    endpoint: TName,
    input: NoteEndpointInput<TName>,
  ): Promise<NoteEndpointOutput<TName>>;
}
