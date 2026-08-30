import { getConnInfo } from "@hono/node-server/conninfo";
import type { AuthOptions } from "@glyphquire/auth";
import { createDb, type Database } from "@glyphquire/database";
import { PostgresJobDispatcher, type JobDispatcher } from "@glyphquire/queue";
import { PostgresSearchAdapter } from "@glyphquire/search";
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
  createNoteRateLimitMiddleware,
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
import { NoteServiceImpl, type NoteService } from "./modules/notes/NoteService.js";
import {
  createOperatorAuthorizer,
  type OperatorAuthorizer,
} from "./modules/search/OperatorAuthorizer.js";
import { SearchServiceImpl, type SearchService } from "./modules/search/SearchService.js";
import {
  AccountDeletionServiceImpl,
  type AccountDeletionService,
} from "./modules/lifecycle/AccountDeletionService.js";
import {
  WorkspaceDeletionServiceImpl,
  type WorkspaceDeletionService,
} from "./modules/lifecycle/WorkspaceDeletionService.js";
import {
  WorkspaceService,
  type PersonalWorkspaceProvisioner,
} from "./modules/workspaces/WorkspaceService.js";
import { createAuthRoutes } from "./routes/auth.js";
import { healthRoutes } from "./routes/health.js";
import { createNoteRoutes } from "./routes/v1/notes.js";
import { createVersionRoutes } from "./routes/v1/versions.js";
import { ThemeServiceImpl, type ThemeService } from "./modules/themes/ThemeService.js";
import { createThemeRoutes } from "./routes/v1/themes.js";
import { createSearchRoutes } from "./routes/v1/search.js";
import { createDeletionRoutes } from "./routes/v1/deletion.js";
import {
  createMaintenanceRoutes,
  MaintenanceServiceImpl,
  type MaintenanceService,
} from "./routes/v1/maintenance.js";

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
  noteService?: NoteService;
  themeService?: ThemeService;
  searchService?: SearchService;
  workspaceDeletionService?: WorkspaceDeletionService;
  accountDeletionService?: AccountDeletionService;
  maintenanceService?: MaintenanceService;
  operatorAuthorizer?: OperatorAuthorizer;
  jobDispatcher?: JobDispatcher;
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

export function createAppRuntime(input: Env | EnvInput, dependencies: AppDependencies = {}) {
  const env = resolvedEnv(input);
  const ownsDb = dependencies.db === undefined;
  const db = dependencies.db ?? createDb(env.DATABASE_URL);
  const workspaceService = dependencies.workspaceService ?? new WorkspaceService(db);
  const noteService = dependencies.noteService ?? new NoteServiceImpl(db);
  const themeService = dependencies.themeService ?? new ThemeServiceImpl(db);
  const operatorAuthorizer =
    dependencies.operatorAuthorizer ?? createOperatorAuthorizer(env.PHASE5_OPERATOR_IDS);
  const jobDispatcher = dependencies.jobDispatcher ?? new PostgresJobDispatcher(db);
  const searchService =
    dependencies.searchService ??
    new SearchServiceImpl(db, new PostgresSearchAdapter(db), jobDispatcher, operatorAuthorizer);
  const workspaceDeletionService =
    dependencies.workspaceDeletionService ??
    new WorkspaceDeletionServiceImpl(db, jobDispatcher, { clock: dependencies.clock });
  const accountDeletionService =
    dependencies.accountDeletionService ??
    new AccountDeletionServiceImpl(db, jobDispatcher, { clock: dependencies.clock });
  const maintenanceService =
    dependencies.maintenanceService ??
    new MaintenanceServiceImpl(db, jobDispatcher, operatorAuthorizer);
  const logger = dependencies.logger ?? defaultAppLogger;
  const rateLimit =
    dependencies.rateLimit ??
    (env.PRODUCTION
      ? new PostgresRateLimitAdapter(db, { clock: dependencies.clock })
      : new InMemoryRateLimitAdapter({ clock: dependencies.clock }));

  let limiterReady = Promise.resolve();
  if (env.PRODUCTION) {
    if (!rateLimit.distributed || !isInitializable(rateLimit)) {
      throw new Error("Production requires an initializable distributed rate limiter");
    }
    limiterReady = rateLimit.initialize();
    // The synchronous request-harness factory below may defer observing this
    // promise until a request. The production bootstrap always awaits it.
    void limiterReady.catch(() => undefined);
  }
  const requireLimiter: MiddlewareHandler<{ Variables: SecurityVariables }> = async (
    _context,
    next,
  ) => {
    try {
      await limiterReady;
    } catch {
      throw new PublicApiError("SERVICE_UNAVAILABLE", 503);
    }
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
    const path = context.req.path;
    if (
      path === "/api/v1/account/deletion" ||
      path.startsWith("/api/v1/maintenance/") ||
      /^\/api\/v1\/workspaces\/[^/]+\/deletion$/u.test(path)
    ) {
      await next();
      return;
    }
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
    .use(
      "/api/v1/*",
      createNoteRateLimitMiddleware({
        rateLimit,
        keySecret: env.BETTER_AUTH_SECRET,
      }),
    )
    .use("/api/v1/*", ensurePersonalWorkspace)
    .onError(createErrorHandler(logger as SecurityLogger))
    .route("/api", healthRoutes)
    .route("/api", authRoutes)
    .route("/api/v1", createNoteRoutes(noteService))
    .route("/api/v1", createVersionRoutes(noteService))
    .route("/api/v1", createThemeRoutes(themeService))
    .route("/api/v1", createSearchRoutes(searchService, operatorAuthorizer))
    .route("/api/v1", createDeletionRoutes(workspaceDeletionService, accountDeletionService))
    .route("/api/v1", createMaintenanceRoutes(maintenanceService, operatorAuthorizer));

  return {
    app,
    ready: limiterReady,
    async close() {
      if (ownsDb) await db.$client.end();
    },
  };
}

/**
 * Synchronous request-harness factory used by tests and in-process callers.
 * The production server entrypoint must use createAppRuntime and await ready
 * before opening a listening socket.
 */
export function createApp(input: Env | EnvInput, dependencies: AppDependencies = {}) {
  return createAppRuntime(input, dependencies).app;
}

export type AppType = ReturnType<typeof createApp>;
