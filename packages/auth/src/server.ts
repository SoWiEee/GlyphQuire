import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { APIError } from "better-auth/api";
import type { Database } from "@glyphquire/database";

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
    try {
      return await providerHandler(request);
    } catch {
      const suppliedRequestId = request.headers.get("x-request-id");
      const requestId =
        suppliedRequestId && /^[A-Za-z0-9._:-]{1,128}$/.test(suppliedRequestId)
          ? suppliedRequestId
          : undefined;
      const status = requestId ? 503 : 500;
      const entry: AuthErrorLogEntry = {
        event: "auth_request_failed",
        requestId: requestId ?? "unavailable",
        code: "SERVICE_UNAVAILABLE",
        status,
        method: request.method,
        routeClass: "auth",
      };
      try {
        (options.errorLogger ?? defaultAuthErrorLogger).error(entry);
      } catch {
        // Logging must not replace the stable public response.
      }

      if (!requestId) return new Response(null, { status });
      return Response.json(
        {
          error: {
            code: "SERVICE_UNAVAILABLE",
            message: "The service is temporarily unavailable",
            requestId,
          },
        },
        {
          status,
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
  status: 500 | 503;
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
