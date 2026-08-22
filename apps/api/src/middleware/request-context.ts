import type { Auth } from "@glyphquire/auth";
import type { Context, MiddlewareHandler } from "hono";
import { PublicApiError } from "./error-handler.js";
import type { SecurityVariables } from "./security.js";

type AuthSession = Awaited<ReturnType<Auth["api"]["getSession"]>>;
type AuthenticatedSession = NonNullable<AuthSession>;

export interface SessionReader {
  getSession(options: { headers: Headers }): Promise<AuthSession>;
}

export interface RequestContext {
  requestId: string;
  actorId: string;
  session: AuthenticatedSession["session"];
}

export function createRequestContextMiddleware(
  sessionReader: SessionReader,
): MiddlewareHandler<{ Variables: SecurityVariables }> {
  return async (context, next) => {
    let authenticated: AuthSession;
    try {
      authenticated = await sessionReader.getSession({ headers: context.req.raw.headers });
    } catch {
      throw new PublicApiError("SERVICE_UNAVAILABLE", 503);
    }

    if (!authenticated?.user.id) {
      throw new PublicApiError("NOTE_NOT_FOUND", 404);
    }

    context.set("requestContext", {
      requestId: context.get("requestId"),
      actorId: authenticated.user.id,
      session: authenticated.session,
    });
    await next();
  };
}

export function getRequestContext(
  context: Context<{ Variables: SecurityVariables }>,
): RequestContext {
  return context.get("requestContext");
}
