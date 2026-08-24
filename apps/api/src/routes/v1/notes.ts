import {
  createNoteInputSchema,
  cursorPaginationQuerySchema,
  deleteNoteInputSchema,
  noteIdParamsSchema,
  renameNoteInputSchema,
  restoreNoteInputSchema,
  workspaceIdParamsSchema,
} from "@glyphquire/api-contract";
import { Hono } from "hono";
import { PublicApiError } from "../../middleware/error-handler.js";
import { getRequestContext } from "../../middleware/request-context.js";
import type { SecurityVariables } from "../../middleware/security.js";
import type { NoteService } from "../../modules/notes/NoteService.js";

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

export function createNoteRoutes(noteService: NoteService) {
  return new Hono<{ Variables: SecurityVariables }>()
    .get("/workspaces/:workspaceId/notes", async (context) => {
      const params = workspaceIdParamsSchema.safeParse({
        workspaceId: context.req.param("workspaceId"),
      });
      if (!params.success) invalidRequest();
      const query = cursorPaginationQuerySchema.safeParse({
        cursor: context.req.query("cursor"),
        pageSize: context.req.query("pageSize"),
      });
      if (!query.success) invalidRequest();

      const { actorId } = getRequestContext(context);
      const page = await noteService.list(actorId, { ...params.data, ...query.data });
      return context.json(page, 200);
    })
    .post("/workspaces/:workspaceId/notes", async (context) => {
      const params = workspaceIdParamsSchema.safeParse({
        workspaceId: context.req.param("workspaceId"),
      });
      if (!params.success) invalidRequest();
      const body = createNoteInputSchema.safeParse(await parseJsonBody(context.req.raw));
      if (!body.success) invalidRequest();

      const { actorId } = getRequestContext(context);
      const result = await noteService.create(actorId, { ...params.data, ...body.data });
      return context.json(result, 201);
    })
    .get("/notes/:noteId", async (context) => {
      const params = noteIdParamsSchema.safeParse({ noteId: context.req.param("noteId") });
      if (!params.success) invalidRequest();

      const { actorId } = getRequestContext(context);
      const result = await noteService.get(actorId, params.data.noteId);
      return context.json(result, 200);
    })
    .patch("/notes/:noteId/title", async (context) => {
      const params = noteIdParamsSchema.safeParse({ noteId: context.req.param("noteId") });
      if (!params.success) invalidRequest();
      const body = renameNoteInputSchema.safeParse(await parseJsonBody(context.req.raw));
      if (!body.success) invalidRequest();

      const { actorId } = getRequestContext(context);
      const result = await noteService.rename(actorId, params.data.noteId, body.data);
      return context.json(result, 200);
    })
    .delete("/notes/:noteId", async (context) => {
      const params = noteIdParamsSchema.safeParse({ noteId: context.req.param("noteId") });
      if (!params.success) invalidRequest();
      const body = deleteNoteInputSchema.safeParse(await parseJsonBody(context.req.raw));
      if (!body.success) invalidRequest();

      const { actorId } = getRequestContext(context);
      const result = await noteService.softDelete(actorId, params.data.noteId, body.data);
      return context.json(result, 200);
    })
    .post("/notes/:noteId/restore", async (context) => {
      const params = noteIdParamsSchema.safeParse({ noteId: context.req.param("noteId") });
      if (!params.success) invalidRequest();
      const body = restoreNoteInputSchema.safeParse(await parseJsonBody(context.req.raw));
      if (!body.success) invalidRequest();

      const { actorId } = getRequestContext(context);
      const result = await noteService.restore(actorId, params.data.noteId, body.data);
      return context.json(result, 200);
    });
}
