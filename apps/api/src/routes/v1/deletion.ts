import {
  canonicalUuidSchema,
  deletionConfirmationSchema,
  deletionResponseSchema,
  idempotencyKeySchema,
} from "@glyphquire/api-contract";
import { Hono } from "hono";
import { PublicApiError } from "../../middleware/error-handler.js";
import { getRequestContext } from "../../middleware/request-context.js";
import type { SecurityVariables } from "../../middleware/security.js";
import type { AccountDeletionService } from "../../modules/lifecycle/AccountDeletionService.js";
import type { WorkspaceDeletionService } from "../../modules/lifecycle/WorkspaceDeletionService.js";

function invalidRequest(): never {
  throw new PublicApiError("DOCUMENT_INVALID", 400);
}

async function parseConfirmation(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    invalidRequest();
  }
  const parsed = deletionConfirmationSchema.safeParse(body);
  if (!parsed.success) invalidRequest();
  return parsed.data;
}

function requireIdempotencyKey(context: {
  req: { header(name: string): string | undefined };
}): string {
  const parsed = idempotencyKeySchema.safeParse(context.req.header("idempotency-key"));
  if (!parsed.success) invalidRequest();
  return parsed.data;
}

function requireNoQuery(request: Request): void {
  if ([...new URL(request.url).searchParams.keys()].length > 0) invalidRequest();
}

export function createDeletionRoutes(
  workspaceDeletion: WorkspaceDeletionService,
  accountDeletion: AccountDeletionService,
) {
  return new Hono<{ Variables: SecurityVariables }>()
    .post("/workspaces/:workspaceId/deletion", async (context) => {
      requireNoQuery(context.req.raw);
      const workspaceId = canonicalUuidSchema.safeParse(context.req.param("workspaceId"));
      if (!workspaceId.success) invalidRequest();
      const confirmation = await parseConfirmation(context.req.raw);
      const idempotencyKey = requireIdempotencyKey(context);
      const result = deletionResponseSchema.parse(
        await workspaceDeletion.request(
          getRequestContext(context).actorId,
          workspaceId.data,
          confirmation,
          idempotencyKey,
        ),
      );
      return context.json(result, 202);
    })
    .post("/account/deletion", async (context) => {
      requireNoQuery(context.req.raw);
      const confirmation = await parseConfirmation(context.req.raw);
      const idempotencyKey = requireIdempotencyKey(context);
      const result = deletionResponseSchema.parse(
        await accountDeletion.request(
          getRequestContext(context).actorId,
          confirmation,
          idempotencyKey,
        ),
      );
      return context.json(result, 202);
    });
}
