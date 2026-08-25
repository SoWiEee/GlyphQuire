import {
  checkpointNoteInputSchema,
  cursorPaginationQuerySchema,
  noteIdParamsSchema,
  noteVersionIdParamsSchema,
  restoreNoteVersionInputSchema,
  saveNoteInputSchema,
} from "@glyphquire/api-contract";
import { Hono } from "hono";
import { PublicApiError } from "../../middleware/error-handler.js";
import { getRequestContext } from "../../middleware/request-context.js";
import type { SecurityVariables } from "../../middleware/security.js";
import type { NoteService } from "../../modules/notes/NoteService.js";
import { NoteSaveConflictError } from "../../modules/notes/NoteWriter.js";

function invalidRequest(): never {
  throw new PublicApiError("DOCUMENT_INVALID", 400);
}

async function parseJsonBody(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    invalidRequest();
  }
}

/**
 * Save, checkpoint, version list/preview, and version restore. `save` is
 * mounted here rather than in notes.ts because it shares NoteWriter's
 * transactional/version machinery and its own 409 shape (the rich
 * `noteConflictSchema` body) with the other version-producing routes.
 */
export function createVersionRoutes(noteService: NoteService) {
  return new Hono<{ Variables: SecurityVariables }>()
    .put("/notes/:noteId/content", async (context) => {
      const params = noteIdParamsSchema.safeParse({ noteId: context.req.param("noteId") });
      if (!params.success) invalidRequest();
      const body = saveNoteInputSchema.safeParse(await parseJsonBody(context.req.raw));
      if (!body.success) invalidRequest();

      const { actorId, requestId } = getRequestContext(context);
      try {
        const result = await noteService.save(actorId, params.data.noteId, body.data);
        return context.json(result, 200);
      } catch (error) {
        if (error instanceof NoteSaveConflictError) {
          return context.json({ ...error.conflict, requestId }, 409);
        }
        throw error;
      }
    })
    .get("/notes/:noteId/versions", async (context) => {
      const params = noteIdParamsSchema.safeParse({ noteId: context.req.param("noteId") });
      if (!params.success) invalidRequest();
      const query = cursorPaginationQuerySchema.safeParse({
        cursor: context.req.query("cursor"),
        pageSize: context.req.query("pageSize"),
      });
      if (!query.success) invalidRequest();

      const { actorId } = getRequestContext(context);
      const page = await noteService.listVersions(actorId, params.data.noteId, query.data);
      return context.json(page, 200);
    })
    .post("/notes/:noteId/versions/checkpoint", async (context) => {
      const params = noteIdParamsSchema.safeParse({ noteId: context.req.param("noteId") });
      if (!params.success) invalidRequest();
      const body = checkpointNoteInputSchema.safeParse(await parseJsonBody(context.req.raw));
      if (!body.success) invalidRequest();

      const { actorId } = getRequestContext(context);
      const result = await noteService.checkpoint(actorId, params.data.noteId, body.data);
      return context.json(result, 200);
    })
    .get("/notes/:noteId/versions/:versionId", async (context) => {
      const params = noteVersionIdParamsSchema.safeParse({
        noteId: context.req.param("noteId"),
        versionId: context.req.param("versionId"),
      });
      if (!params.success) invalidRequest();

      const { actorId } = getRequestContext(context);
      const result = await noteService.getVersion(
        actorId,
        params.data.noteId,
        params.data.versionId,
      );
      return context.json(result, 200);
    })
    .post("/notes/:noteId/versions/:versionId/restore", async (context) => {
      const params = noteVersionIdParamsSchema.safeParse({
        noteId: context.req.param("noteId"),
        versionId: context.req.param("versionId"),
      });
      if (!params.success) invalidRequest();
      const body = restoreNoteVersionInputSchema.safeParse(await parseJsonBody(context.req.raw));
      if (!body.success) invalidRequest();

      const { actorId } = getRequestContext(context);
      const result = await noteService.restoreVersion(
        actorId,
        params.data.noteId,
        params.data.versionId,
        body.data,
      );
      return context.json(result, 200);
    });
}
