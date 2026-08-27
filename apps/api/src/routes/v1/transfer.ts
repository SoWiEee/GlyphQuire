import { canonicalUuidSchema } from "@glyphquire/api-contract";
import { Hono } from "hono";
import { PublicApiError } from "../../middleware/error-handler.js";
import { getRequestContext } from "../../middleware/request-context.js";
import type { SecurityVariables } from "../../middleware/security.js";
import type { ImportService } from "../../modules/transfer/ImportService.js";

function invalidImport(): never {
  throw new PublicApiError("IMPORT_INVALID", 400);
}

/** Import-only transfer route seam. Export endpoints are owned separately. */
export function createTransferRoutes(importService: ImportService) {
  return new Hono<{ Variables: SecurityVariables }>().get("/imports/:id", async (context) => {
    const importId = canonicalUuidSchema.safeParse(context.req.param("id"));
    if (!importId.success) invalidImport();

    const { actorId } = getRequestContext(context);
    const result = await importService.getStatus(actorId, importId.data);
    return context.json(result, 200);
  });
}
