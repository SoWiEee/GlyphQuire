import {
  putThemePreferenceInputSchema,
  themePreferenceResultSchema,
} from "@glyphquire/api-contract";
import { Hono } from "hono";
import { PublicApiError } from "../../middleware/error-handler.js";
import { getRequestContext } from "../../middleware/request-context.js";
import type { SecurityVariables } from "../../middleware/security.js";
import type { UserPreferenceService } from "../../modules/preferences/UserPreferenceService.js";

function invalidRequest(): never {
  throw new PublicApiError("DOCUMENT_INVALID", 400);
}

function requireNoQuery(request: Request): void {
  if ([...new URL(request.url).searchParams.keys()].length > 0) invalidRequest();
}

async function parseJsonBody(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    invalidRequest();
  }
}

export function createUserPreferenceRoutes(service: UserPreferenceService) {
  return new Hono<{ Variables: SecurityVariables }>()
    .get("/me/preferences/theme", async (context) => {
      requireNoQuery(context.req.raw);
      const result = themePreferenceResultSchema.parse(
        await service.getThemePreference(getRequestContext(context).actorId),
      );
      return context.json(result, 200);
    })
    .put("/me/preferences/theme", async (context) => {
      requireNoQuery(context.req.raw);
      const body = putThemePreferenceInputSchema.safeParse(await parseJsonBody(context.req.raw));
      if (!body.success) invalidRequest();
      const result = themePreferenceResultSchema.parse(
        await service.putThemePreference(getRequestContext(context).actorId, body.data),
      );
      return context.json(result, 200);
    });
}
