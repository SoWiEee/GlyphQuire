import {
  createThemeInputSchema,
  updateThemeInputSchema,
  setUserThemeInputSchema,
  themeIdParamsSchema,
  workspaceIdParamsSchema,
} from "@glyphquire/api-contract";
import { Hono } from "hono";
import { PublicApiError } from "../../middleware/error-handler.js";
import { getRequestContext } from "../../middleware/request-context.js";
import type { SecurityVariables } from "../../middleware/security.js";
import type { ThemeService } from "../../modules/themes/ThemeService.js";

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

export function createThemeRoutes(themeService: ThemeService) {
  return new Hono<{ Variables: SecurityVariables }>()
    .get("/workspaces/:workspaceId/themes", async (context) => {
      const params = workspaceIdParamsSchema.safeParse({ workspaceId: context.req.param("workspaceId") });
      if (!params.success) invalidRequest();
      const { actorId } = getRequestContext(context);
      const result = await themeService.list(actorId, params.data.workspaceId);
      return context.json(result, 200);
    })
    .post("/workspaces/:workspaceId/themes", async (context) => {
      const params = workspaceIdParamsSchema.safeParse({ workspaceId: context.req.param("workspaceId") });
      if (!params.success) invalidRequest();
      const body = createThemeInputSchema.safeParse(await parseJsonBody(context.req.raw));
      if (!body.success) invalidRequest();
      const { actorId } = getRequestContext(context);
      const result = await themeService.create(actorId, params.data.workspaceId, body.data);
      return context.json(result, 201);
    })
    .get("/themes/:themeId", async (context) => {
      const params = themeIdParamsSchema.safeParse({ themeId: context.req.param("themeId") });
      if (!params.success) invalidRequest();
      const { actorId } = getRequestContext(context);
      const result = await themeService.get(actorId, params.data.themeId);
      return context.json(result, 200);
    })
    .put("/themes/:themeId", async (context) => {
      const params = themeIdParamsSchema.safeParse({ themeId: context.req.param("themeId") });
      if (!params.success) invalidRequest();
      const body = updateThemeInputSchema.safeParse(await parseJsonBody(context.req.raw));
      if (!body.success) invalidRequest();
      const { actorId } = getRequestContext(context);
      const result = await themeService.update(actorId, params.data.themeId, body.data);
      return context.json(result, 200);
    })
    .delete("/themes/:themeId", async (context) => {
      const params = themeIdParamsSchema.safeParse({ themeId: context.req.param("themeId") });
      if (!params.success) invalidRequest();
      const { actorId } = getRequestContext(context);
      await themeService.remove(actorId, params.data.themeId);
      return context.json({ ok: true }, 200);
    })
    .get("/user-theme", async (context) => {
      const { actorId } = getRequestContext(context);
      const workspaceId = context.req.query("workspaceId");
      if (!workspaceId) invalidRequest();
      const result = await themeService.getUserTheme(actorId, workspaceId);
      return context.json(result, 200);
    })
    .put("/user-theme", async (context) => {
      const { actorId } = getRequestContext(context);
      const workspaceId = context.req.query("workspaceId");
      if (!workspaceId) invalidRequest();
      const body = setUserThemeInputSchema.safeParse(await parseJsonBody(context.req.raw));
      if (!body.success) invalidRequest();
      const result = await themeService.setUserTheme(actorId, workspaceId, body.data);
      return context.json(result, 200);
    });
}
