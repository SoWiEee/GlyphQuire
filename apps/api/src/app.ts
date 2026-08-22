import { getConnInfo } from "@hono/node-server/conninfo";
import type { AuthOptions } from "@glyphquire/auth";
import { createDb, type Database } from "@glyphquire/database";
import { Hono, type Context, type MiddlewareHandler } from "hono";
import { type Env, type EnvInput, parseEnv } from "./env.js";
import { createCorsMiddleware } from "./middleware/cors.js";
import {
  PublicApiError,
  createErrorHandler,
  type SecurityLogEntry,
  type SecurityLogger,
} from "./middleware/error-handler.js";
import { PostgresRateLimitAdapter } from "./middleware/PostgresRateLimitAdapter.js";
import {
  InMemoryRateLimitAdapter,
  createAuthRateLimitMiddleware,
  type Clock,
  type RateLimitPort,
} from "./middleware/rate-limit.js";
import { createRequestContextMiddleware, getRequestContext } from "./middleware/request-context.js";
import {
  createClientIpMiddleware,
  createRequestSecurityMiddleware,
  createSecurityHeadersMiddleware,
  createTrustedProxyPolicy,
  type SecurityVariables,
} from "./middleware/security.js";
import {
  WorkspaceService,
  type PersonalWorkspaceProvisioner,
} from "./modules/workspaces/WorkspaceService.js";
import { createAuthRoutes } from "./routes/auth.js";
import { healthRoutes } from "./routes/health.js";

type AuthErrorLogger = NonNullable<AuthOptions["errorLogger"]>;
type AuthErrorLogEntry = Parameters<AuthErrorLogger["error"]>[0];

export interface AppSecurityLogger {
  error(entry: SecurityLogEntry | AuthErrorLogEntry): void;
}

const defaultAppLogger: AppSecurityLogger = {
  error(entry) {
    console.error(JSON.stringify(entry));
  },
};

export interface AppDependencies {
  db?: Database;
  workspaceService?: PersonalWorkspaceProvisioner;
  rateLimit?: RateLimitPort;
  clock?: Clock;
  logger?: AppSecurityLogger;
  getDirectPeer?: (context: Context) => string | undefined;
}

function resolvedEnv(input: Env | EnvInput): Env {
  return input.WEB_ORIGIN instanceof URL && "PRODUCTION" in input ? input : parseEnv(input);
}

function nodeDirectPeer(context: Context) {
  try {
    return getConnInfo(context).remote.address;
  } catch {
    return undefined;
  }
}

function isInitializable(port: RateLimitPort): port is RateLimitPort & {
  initialize(): Promise<void>;
} {
  return typeof port.initialize === "function";
}

export function createApp(input: Env | EnvInput, dependencies: AppDependencies = {}) {
  const env = resolvedEnv(input);
  const db = dependencies.db ?? createDb(env.DATABASE_URL);
  const workspaceService = dependencies.workspaceService ?? new WorkspaceService(db);
  const logger = dependencies.logger ?? defaultAppLogger;
  const rateLimit =
    dependencies.rateLimit ??
    (env.PRODUCTION
      ? new PostgresRateLimitAdapter(db, { clock: dependencies.clock })
      : new InMemoryRateLimitAdapter({ clock: dependencies.clock }));

  let limiterReady = Promise.resolve(true);
  if (env.PRODUCTION) {
    if (!rateLimit.distributed || !isInitializable(rateLimit)) {
      throw new Error("Production requires an initializable distributed rate limiter");
    }
    limiterReady = rateLimit.initialize().then(
      () => true,
      () => false,
    );
  }
  const requireLimiter: MiddlewareHandler<{ Variables: SecurityVariables }> = async (
    _context,
    next,
  ) => {
    if (!(await limiterReady)) throw new PublicApiError("SERVICE_UNAVAILABLE", 503);
    await next();
  };

  const trustedProxies = createTrustedProxyPolicy(env.TRUSTED_PROXY_CIDRS, env.FORWARDED_IP_HEADER);
  const clientIp = createClientIpMiddleware(
    trustedProxies,
    dependencies.getDirectPeer ?? nodeDirectPeer,
  );
  const { auth, routes: authRoutes } = createAuthRoutes(db, {
    baseUrl: env.BETTER_AUTH_URL,
    webOrigin: env.WEB_ORIGIN,
    secret: env.BETTER_AUTH_SECRET,
    errorLogger: logger,
    workspaceService,
  });
  const requestSecurity = createRequestSecurityMiddleware({ webOrigin: env.WEB_ORIGIN });

  const ensurePersonalWorkspace: MiddlewareHandler<{ Variables: SecurityVariables }> = async (
    context,
    next,
  ) => {
    try {
      await workspaceService.ensurePersonalWorkspace(getRequestContext(context).actorId);
    } catch {
      throw new PublicApiError("SERVICE_UNAVAILABLE", 503);
    }
    await next();
  };

  const app = new Hono<{ Variables: SecurityVariables }>()
    .use("*", createSecurityHeadersMiddleware())
    .use("*", createCorsMiddleware(env.WEB_ORIGIN))
    .use("/api/auth/*", clientIp)
    .use("/api/v1/*", clientIp)
    .use("/api/auth/*", requestSecurity)
    .use("/api/v1/*", requestSecurity)
    .use("/api/auth/*", requireLimiter)
    .use("/api/v1/*", requireLimiter)
    .use(
      "/api/auth/*",
      createAuthRateLimitMiddleware({
        rateLimit,
        keySecret: env.BETTER_AUTH_SECRET,
      }),
    )
    .use("/api/v1/*", createRequestContextMiddleware(auth.api))
    .use("/api/v1/*", ensurePersonalWorkspace)
    .onError(createErrorHandler(logger as SecurityLogger))
    .route("/api", healthRoutes)
    .route("/api", authRoutes);

  return app;
}

export type AppType = ReturnType<typeof createApp>;
