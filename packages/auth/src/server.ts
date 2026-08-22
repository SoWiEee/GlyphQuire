import { randomUUID } from "node:crypto";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { APIError } from "better-auth/api";
import type { Database } from "@glyphquire/database";

const canonicalRequestIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function safeRequestId(request: Request) {
  const supplied = request.headers.get("x-request-id");
  return supplied && canonicalRequestIdPattern.test(supplied) ? supplied : randomUUID();
}

export function createAuth(db: Database, options: AuthOptions) {
  const webOrigin = options.webOrigin ?? new URL(options.baseUrl);
  const secureCookies = webOrigin.protocol === "https:";

  const auth = betterAuth({
    database: drizzleAdapter(db, {
      provider: "pg",
    }),
    baseURL: options.baseUrl,
    trustedOrigins: [webOrigin.origin],
    secret: options.secret,
    rateLimit: {
      // The API owns the audited shared PostgreSQL limiter. Better Auth's
      // default process-local limiter must never become a second production
      // policy with divergent counters.
      enabled: false,
    },
    advanced: {
      useSecureCookies: secureCookies,
      defaultCookieAttributes: {
        httpOnly: true,
        path: "/",
        sameSite: "lax",
        secure: secureCookies,
      },
    },
    logger: {
      // Hono's scrubbed structured error seam owns application logging. This
      // prevents provider internals from emitting bodies, cookies, SQL, or
      // exception stacks through a second unsanitized logger.
      disabled: true,
    },
    onAPIError: {
      // Better Call logs an exception after a void onError callback. Throwing
      // lets the wrapper below replace it with one scrubbed application event.
      throw: true,
    },
    emailAndPassword: {
      enabled: true,
    },
    databaseHooks: {
      user: {
        create: {
          after: async (createdUser) => {
            try {
              await options.onUserCreated(createdUser.id);
            } catch {
              throw new APIError("SERVICE_UNAVAILABLE", {
                code: "SERVICE_UNAVAILABLE",
                message: "Account setup is temporarily unavailable",
              });
            }
          },
        },
      },
    },
  });

  const providerHandler = auth.handler;
  const safeHandler = async (request: Request) => {
    const requestId = safeRequestId(request);
    const headers = new Headers(request.headers);
    headers.set("x-request-id", requestId);
    const sanitizedRequest = new Request(request, { headers });
    try {
      return await providerHandler(sanitizedRequest);
    } catch {
      const entry: AuthErrorLogEntry = {
        event: "auth_request_failed",
        requestId,
        code: "SERVICE_UNAVAILABLE",
        status: 503,
        method: request.method,
        routeClass: "auth",
      };
      try {
        (options.errorLogger ?? defaultAuthErrorLogger).error(entry);
      } catch {
        // Logging must not replace the stable public response.
      }

      return Response.json(
        {
          error: {
            code: "SERVICE_UNAVAILABLE",
            message: "The service is temporarily unavailable",
            requestId,
          },
        },
        {
          status: 503,
          headers: {
            "cache-control": "no-store",
            "x-request-id": requestId,
          },
        },
      );
    }
  };
  return Object.assign(auth, {
    handler: safeHandler,
    fetch: safeHandler,
  });
}

export interface AuthErrorLogEntry {
  event: "auth_request_failed";
  requestId: string;
  code: "SERVICE_UNAVAILABLE";
  status: 503;
  method: string;
  routeClass: "auth";
}

export interface AuthErrorLogger {
  error(entry: AuthErrorLogEntry): void;
}

const defaultAuthErrorLogger: AuthErrorLogger = {
  error(entry) {
    console.error(JSON.stringify(entry));
  },
};

export interface AuthOptions {
  baseUrl: string;
  webOrigin?: URL;
  secret: string;
  errorLogger?: AuthErrorLogger;
  onUserCreated(userId: string): Promise<void>;
}

export type Auth = ReturnType<typeof createAuth>;
