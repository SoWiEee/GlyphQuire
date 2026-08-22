import { z } from "zod";

export const MAX_MARKDOWN_BYTES = 2 * 1024 * 1024;
export const MAX_CURSOR_BYTES = 512;
export const MAX_TITLE_CODE_POINTS = 200;
export const MAX_REQUEST_ID_BYTES = 128;
export const MAX_PUBLIC_ERROR_MESSAGE_CODE_POINTS = 1024;
export const MAX_DISPLAY_NAME_CODE_POINTS = 200;
export const DEFAULT_PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 100;

const utf8ByteLength = (value: string) => new TextEncoder().encode(value).byteLength;
const unicodeCodePointLength = (value: string) => [...value].length;
const CANONICAL_UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CANONICAL_PAGE_SIZE_PATTERN = /^(?:[1-9]|[1-9]\d|100)$/;
const STRICT_RFC_3339_TIMESTAMP_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-](?:(?:0\d|1[0-3]):[0-5]\d|14:00))$/;

export const canonicalUuidSchema = z
  .string()
  .max(36)
  .regex(CANONICAL_UUID_PATTERN, "Expected a canonical UUID");

export const cursorSchema = z
  .string()
  .min(1)
  .superRefine((value, context) => {
    if (utf8ByteLength(value) > MAX_CURSOR_BYTES) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Cursor must be at most ${MAX_CURSOR_BYTES} UTF-8 bytes`,
      });
    }
  });

export const pageSizeSchema = z
  .union([
    z.number().int().min(1).max(MAX_PAGE_SIZE),
    z.string().regex(CANONICAL_PAGE_SIZE_PATTERN).transform(Number),
  ])
  .default(DEFAULT_PAGE_SIZE);

export const cursorPaginationQuerySchema = z
  .object({
    cursor: cursorSchema.optional(),
    pageSize: pageSizeSchema,
  })
  .strict();

export const markdownSchema = z.string().superRefine((value, context) => {
  if (utf8ByteLength(value) > MAX_MARKDOWN_BYTES) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: `Markdown must be at most ${MAX_MARKDOWN_BYTES} UTF-8 bytes`,
    });
  }
});

export const noteTitleSchema = z.string().superRefine((value, context) => {
  const codePoints = unicodeCodePointLength(value);
  if (codePoints < 1 || codePoints > MAX_TITLE_CODE_POINTS) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: `Title must contain between 1 and ${MAX_TITLE_CODE_POINTS} Unicode code points`,
    });
  }
});

export const requestIdSchema = z
  .string()
  .min(1)
  .superRefine((value, context) => {
    if (utf8ByteLength(value) > MAX_REQUEST_ID_BYTES) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Request ID must be at most ${MAX_REQUEST_ID_BYTES} UTF-8 bytes`,
      });
    }
  });

const boundedCodePointStringSchema = (label: string, maximum: number) =>
  z.string().superRefine((value, context) => {
    const codePoints = unicodeCodePointLength(value);
    if (codePoints < 1 || codePoints > maximum) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `${label} must contain between 1 and ${maximum} Unicode code points`,
      });
    }
  });

export const publicErrorMessageSchema = boundedCodePointStringSchema(
  "Public error message",
  MAX_PUBLIC_ERROR_MESSAGE_CODE_POINTS,
);
export const displayNameSchema = boundedCodePointStringSchema(
  "Display name",
  MAX_DISPLAY_NAME_CODE_POINTS,
);

export const revisionSchema = z.number().int().positive();
export const noteVisibilitySchema = z.literal("private");

export const createNoteInputSchema = z
  .object({
    operationId: canonicalUuidSchema,
    title: noteTitleSchema,
    contentMarkdown: markdownSchema,
    visibility: noteVisibilitySchema,
  })
  .strict();

export const noteMutationSchema = z
  .object({
    operationId: canonicalUuidSchema,
    baseRevision: revisionSchema,
  })
  .strict();

export const renameNoteInputSchema = noteMutationSchema.extend({
  title: noteTitleSchema,
});

export const saveNoteInputSchema = noteMutationSchema.extend({
  contentMarkdown: markdownSchema,
});

export const deleteNoteInputSchema = noteMutationSchema;
export const restoreNoteInputSchema = noteMutationSchema;
export const checkpointNoteInputSchema = noteMutationSchema;
export const restoreNoteVersionInputSchema = noteMutationSchema;

export const timestampSchema = z
  .string()
  .regex(STRICT_RFC_3339_TIMESTAMP_PATTERN, "Expected a strict RFC 3339 timestamp")
  .datetime({ offset: true });

export const noteSummarySchema = z
  .object({
    id: canonicalUuidSchema,
    workspaceId: canonicalUuidSchema,
    title: noteTitleSchema,
    revision: revisionSchema,
    visibility: noteVisibilitySchema,
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
    deletedAt: timestampSchema.nullable(),
  })
  .strict();

export const noteResultSchema = noteSummarySchema.extend({
  contentMarkdown: markdownSchema,
  schemaVersion: z.number().int().positive(),
});

export const snapshotReasonSchema = z.enum([
  "autosave",
  "checkpoint",
  "restore",
  "migration",
  "import",
]);

export const displayNameIdentitySchema = z.object({ displayName: displayNameSchema }).strict();

export const noteVersionSummarySchema = z
  .object({
    id: canonicalUuidSchema,
    noteId: canonicalUuidSchema,
    revision: revisionSchema,
    reason: snapshotReasonSchema,
    createdBy: displayNameIdentitySchema,
    createdAt: timestampSchema,
  })
  .strict();

export const noteVersionResultSchema = noteVersionSummarySchema.extend({
  contentMarkdown: markdownSchema,
  schemaVersion: z.number().int().positive(),
});

export const cursorEnvelopeSchema = <TItem extends z.ZodTypeAny>(itemSchema: TItem) =>
  z
    .object({
      items: z.array(itemSchema).max(MAX_PAGE_SIZE),
      nextCursor: cursorSchema.nullable(),
    })
    .strict();

export const notePageSchema = cursorEnvelopeSchema(noteSummarySchema);
export const noteVersionPageSchema = cursorEnvelopeSchema(noteVersionSummarySchema);

export const checkpointNoteResultSchema = z
  .object({
    note: noteResultSchema,
    version: noteVersionResultSchema,
  })
  .strict();

export const workspaceIdParamsSchema = z
  .object({
    workspaceId: canonicalUuidSchema,
  })
  .strict();

export const noteIdParamsSchema = z
  .object({
    noteId: canonicalUuidSchema,
  })
  .strict();

export const noteVersionIdParamsSchema = z
  .object({
    noteId: canonicalUuidSchema,
    versionId: canonicalUuidSchema,
  })
  .strict();

export const listNotesRequestSchema = z
  .object({
    params: workspaceIdParamsSchema,
    query: cursorPaginationQuerySchema,
  })
  .strict();

export const createNoteRequestSchema = z
  .object({
    params: workspaceIdParamsSchema,
    body: createNoteInputSchema,
  })
  .strict();

export const getNoteRequestSchema = z.object({ params: noteIdParamsSchema }).strict();

export const renameNoteRequestSchema = z
  .object({ params: noteIdParamsSchema, body: renameNoteInputSchema })
  .strict();

export const saveNoteRequestSchema = z
  .object({ params: noteIdParamsSchema, body: saveNoteInputSchema })
  .strict();

export const deleteNoteRequestSchema = z
  .object({ params: noteIdParamsSchema, body: deleteNoteInputSchema })
  .strict();

export const restoreNoteRequestSchema = z
  .object({ params: noteIdParamsSchema, body: restoreNoteInputSchema })
  .strict();

export const listNoteVersionsRequestSchema = z
  .object({ params: noteIdParamsSchema, query: cursorPaginationQuerySchema })
  .strict();

export const checkpointNoteRequestSchema = z
  .object({ params: noteIdParamsSchema, body: checkpointNoteInputSchema })
  .strict();

export const getNoteVersionRequestSchema = z.object({ params: noteVersionIdParamsSchema }).strict();

export const restoreNoteVersionRequestSchema = z
  .object({ params: noteVersionIdParamsSchema, body: restoreNoteVersionInputSchema })
  .strict();

export const noteApiContract = {
  listNotes: {
    method: "GET",
    path: "/api/v1/workspaces/:workspaceId/notes",
    request: listNotesRequestSchema,
    response: notePageSchema,
  },
  createNote: {
    method: "POST",
    path: "/api/v1/workspaces/:workspaceId/notes",
    request: createNoteRequestSchema,
    response: noteResultSchema,
  },
  getNote: {
    method: "GET",
    path: "/api/v1/notes/:noteId",
    request: getNoteRequestSchema,
    response: noteResultSchema,
  },
  renameNote: {
    method: "PATCH",
    path: "/api/v1/notes/:noteId/title",
    request: renameNoteRequestSchema,
    response: noteResultSchema,
  },
  saveNote: {
    method: "PUT",
    path: "/api/v1/notes/:noteId/content",
    request: saveNoteRequestSchema,
    response: noteResultSchema,
  },
  deleteNote: {
    method: "DELETE",
    path: "/api/v1/notes/:noteId",
    request: deleteNoteRequestSchema,
    response: noteResultSchema,
  },
  restoreNote: {
    method: "POST",
    path: "/api/v1/notes/:noteId/restore",
    request: restoreNoteRequestSchema,
    response: noteResultSchema,
  },
  listNoteVersions: {
    method: "GET",
    path: "/api/v1/notes/:noteId/versions",
    request: listNoteVersionsRequestSchema,
    response: noteVersionPageSchema,
  },
  checkpointNote: {
    method: "POST",
    path: "/api/v1/notes/:noteId/versions/checkpoint",
    request: checkpointNoteRequestSchema,
    response: checkpointNoteResultSchema,
  },
  getNoteVersion: {
    method: "GET",
    path: "/api/v1/notes/:noteId/versions/:versionId",
    request: getNoteVersionRequestSchema,
    response: noteVersionResultSchema,
  },
  restoreNoteVersion: {
    method: "POST",
    path: "/api/v1/notes/:noteId/versions/:versionId/restore",
    request: restoreNoteVersionRequestSchema,
    response: noteResultSchema,
  },
} as const;
