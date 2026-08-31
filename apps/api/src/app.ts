import { getConnInfo } from "@hono/node-server/conninfo";
import type { AuthOptions } from "@glyphquire/auth";
import { createDb, IdempotencyStore, type Database } from "@glyphquire/database";
import { PostgresJobDispatcher, type JobDispatcher } from "@glyphquire/queue";
import { PostgresSearchAdapter } from "@glyphquire/search";
import {
  createMinioObjectStorage,
  createS3ObjectStorage,
  type ObjectStoragePort,
} from "@glyphquire/storage";
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
import { AssetServiceImpl, type AssetService } from "./modules/assets/AssetService.js";
import { ImportServiceImpl, type ImportService } from "./modules/transfer/ImportService.js";
import { ExportServiceImpl, type ExportService } from "./modules/transfer/ExportService.js";
import {
  ShareLinkServiceImpl,
  type ShareLinkService,
} from "./modules/share-links/ShareLinkService.js";
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
import {
  createHealthRoutes,
  createReadinessState,
  type ReleaseReadinessState,
} from "./routes/health.js";
import { createReleasePreflightRoutes } from "./routes/internal-release-preflight.js";
import { createNoteRoutes } from "./routes/v1/notes.js";
import { createVersionRoutes } from "./routes/v1/versions.js";
import { ThemeServiceImpl, type ThemeService } from "./modules/themes/ThemeService.js";
import { createThemeRoutes } from "./routes/v1/themes.js";
import { createSearchRoutes } from "./routes/v1/search.js";
import { createAssetRoutes } from "./routes/v1/assets.js";
import { createTransferRoutes } from "./routes/v1/transfer.js";
import { createShareLinkRoutes } from "./routes/v1/share-links.js";
import { createSharedRoutes } from "./routes/shared.js";
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
  storage?: ObjectStoragePort;
  idempotencyStore?: IdempotencyStore;
  assetService?: AssetService;
  importService?: ImportService;
  exportService?: ExportService;
  shareLinkService?: ShareLinkService;
  rateLimit?: RateLimitPort;
  clock?: Clock;
  logger?: AppSecurityLogger;
  readiness?: ReleaseReadinessState;
  getDirectPeer?: (context: Context) => string | undefined;
}

export function createOperationalLogger(logger: AppSecurityLogger = defaultAppLogger) {
  return {
    error(entry: Parameters<AppSecurityLogger["error"]>[0]) {
      logger.error(entry);
    },
  } satisfies AppSecurityLogger;
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
    dependencies.operatorAuthorizer ?? createOperatorAuthorizer(env.OPERATIONS_OPERATOR_IDS);
  const jobDispatcher = dependencies.jobDispatcher ?? new PostgresJobDispatcher(db);
  let ownedStorage: (ObjectStoragePort & { destroy?(): void }) | undefined;
  const storage =
    dependencies.storage ??
    (env.WORKSPACE_SERVICES_ENABLED
      ? (ownedStorage = env.S3_FORCE_PATH_STYLE
          ? createMinioObjectStorage(env)
          : createS3ObjectStorage(env))
      : undefined);
  const idempotencyStore =
    dependencies.idempotencyStore ??
    (env.WORKSPACE_SERVICES_ENABLED
      ? new IdempotencyStore(db, {
          encryptionKey: env.IDEMPOTENCY_ENCRYPTION_KEY,
          leaseSeconds: env.IDEMPOTENCY_LEASE_SECONDS,
          clock: dependencies.clock,
        })
      : undefined);
  const assetService =
    dependencies.assetService ??
    (env.WORKSPACE_SERVICES_ENABLED && storage && idempotencyStore
      ? new AssetServiceImpl(db, storage, jobDispatcher, idempotencyStore, {
          maxBytes: env.ASSET_MAX_BYTES,
          workspaceQuotaBytes: env.ASSET_WORKSPACE_QUOTA_BYTES,
          assetDeleteGraceDays: env.ASSET_DELETE_GRACE_DAYS,
          downloadUrlExpirySeconds: 300,
        })
      : undefined);
  const importService =
    dependencies.importService ??
    (env.WORKSPACE_SERVICES_ENABLED && storage
      ? new ImportServiceImpl(db, storage, jobDispatcher, {
          stagingGraceSeconds: env.IMPORT_STAGING_GRACE_SECONDS,
        })
      : undefined);
  const exportService =
    dependencies.exportService ??
    (env.WORKSPACE_SERVICES_ENABLED && storage
      ? new ExportServiceImpl(db, storage, jobDispatcher, {
          expirySeconds: env.EXPORT_RETENTION_DAYS * 24 * 60 * 60,
          downloadUrlExpirySeconds: 300,
        })
      : undefined);
  const shareLinkService =
    dependencies.shareLinkService ??
    (env.WORKSPACE_SERVICES_ENABLED && idempotencyStore
      ? new ShareLinkServiceImpl(db, idempotencyStore, jobDispatcher, {
          tokenHashKey: env.IDEMPOTENCY_ENCRYPTION_KEY,
          publicBaseUrl: env.WEB_ORIGIN,
          deleteGraceSeconds: env.SHARE_DELETE_GRACE_SECONDS,
          clock: dependencies.clock,
        })
      : undefined);
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
  const logger = createOperationalLogger(dependencies.logger);
  const readiness = dependencies.readiness ?? createReadinessState();
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

  const app = new Hono<{ Variables: SecurityVariables }>();
  app.use("*", createSecurityHeadersMiddleware());
  app.use("*", async (_context, next) => {
    readiness.recordRequest();
    await next();
  });
  app.use("*", createCorsMiddleware(env.WEB_ORIGIN));
  app.use("/api/auth/*", clientIp);
  app.use("/api/v1/*", clientIp);
  app.use("/api/auth/*", requestSecurity);
  app.use("/api/v1/*", requestSecurity);
  app.use("/api/auth/*", requireLimiter);
  app.use("/api/v1/*", requireLimiter);
  app.use(
    "/api/auth/*",
    createAuthRateLimitMiddleware({
      rateLimit,
      keySecret: env.BETTER_AUTH_SECRET,
    }),
  );
  const errorHandler = createErrorHandler(logger as SecurityLogger);
  app.onError((error, context) => {
    readiness.recordError();
    return errorHandler(error, context);
  });
  app.use("/api/v1/*", async (_context, next) => {
    if (!readiness.ready) throw new PublicApiError("SERVICE_UNAVAILABLE", 503);
    await next();
  });

  // Anonymous read-only sharing must run before authenticated v1 context and
  // personal-workspace provisioning, while retaining IP, origin, limiter,
  // hardening-header, and scrubbed-error middleware above.
  if (shareLinkService) {
    app.route(
      "/api/v1",
      createSharedRoutes(shareLinkService, {
        rateLimit,
        keySecret: env.BETTER_AUTH_SECRET,
      }),
    );
  }

  app.use("/api/v1/*", createRequestContextMiddleware(auth.api));
  app.use(
    "/api/v1/*",
    createNoteRateLimitMiddleware({
      rateLimit,
      keySecret: env.BETTER_AUTH_SECRET,
    }),
  );
  app.use("/api/v1/*", ensurePersonalWorkspace);

  const expectedRuntimeRole = process.env.RELEASE_EXPECTED_RUNTIME_ROLE ?? "unavailable";
  const expectedMigrationRole = process.env.RELEASE_EXPECTED_MIGRATION_ROLE ?? "unavailable";
  const expectedWorkerId = process.env.RELEASE_EXPECTED_WORKER_ID ?? "unavailable";
  const expectedBucket = env.WORKSPACE_SERVICES_ENABLED
    ? (process.env.RELEASE_EXPECTED_BUCKET ?? env.S3_BUCKET)
    : "unavailable";
  const expectedImageDigest = process.env.RELEASE_EXPECTED_IMAGE_DIGEST ?? "unavailable";
  const expectedMigrationJournalSha =
    process.env.RELEASE_EXPECTED_MIGRATION_JOURNAL_SHA ?? "unavailable";
  const preflightProbeToken = process.env.RELEASE_PREFLIGHT_PROBE_TOKEN;
  const preflightOperatorId =
    process.env.RELEASE_PREFLIGHT_OPERATOR_ID ??
    (env.WORKSPACE_SERVICES_ENABLED ? env.OPERATIONS_OPERATOR_IDS[0] : undefined);
  const preflightRoutes = createReleasePreflightRoutes({
    operatorAuthorizer,
    expected: {
      runtimeRole: expectedRuntimeRole,
      migrationRole: expectedMigrationRole,
      workerId: expectedWorkerId,
      bucket: expectedBucket,
      imageDigest: expectedImageDigest,
      migrationJournalSha: expectedMigrationJournalSha,
    },
    probeToken: preflightProbeToken,
    probeOperatorId: preflightOperatorId,
    probe: async () => {
      let database = false;
      try {
        await db.execute("select 1");
        database = true;
      } catch {
        // The preflight response contains only the fixed boolean result.
      }
      const identitiesConfigured =
        expectedRuntimeRole !== "unavailable" &&
        expectedMigrationRole !== "unavailable" &&
        expectedWorkerId !== "unavailable" &&
        expectedImageDigest !== "unavailable" &&
        expectedMigrationJournalSha !== "unavailable";
      return {
        health: readiness.healthy,
        readiness: readiness.ready,
        database,
        objectStorage: env.WORKSPACE_SERVICES_ENABLED && storage !== undefined,
        roles: identitiesConfigured,
        worker: expectedWorkerId !== "unavailable",
        image: expectedImageDigest !== "unavailable",
        migrationJournal: expectedMigrationJournalSha !== "unavailable",
      };
    },
  });
  app.use("/api/internal/release/*", async (context, next) => {
    if (
      preflightProbeToken !== undefined &&
      context.req.header("authorization") === `Bearer ${preflightProbeToken}`
    ) {
      await next();
      return;
    }
    let session: Awaited<ReturnType<typeof auth.api.getSession>>;
    try {
      session = await auth.api.getSession({ headers: context.req.raw.headers });
    } catch {
      throw new PublicApiError("SERVICE_UNAVAILABLE", 503);
    }
    if (!session?.user.id) throw new PublicApiError("NOTE_NOT_FOUND", 404);
    context.set("requestContext", {
      requestId: context.get("requestId"),
      actorId: session.user.id,
      session: session.session,
    });
    await next();
  });
  app.route("/api", createHealthRoutes(readiness));
  app.route("/api", preflightRoutes);
  app.route("/api", authRoutes);
  app.route("/api/v1", createNoteRoutes(noteService));
  app.route("/api/v1", createVersionRoutes(noteService));
  app.route("/api/v1", createThemeRoutes(themeService));
  app.route("/api/v1", createSearchRoutes(searchService, operatorAuthorizer));
  if (assetService) app.route("/api/v1", createAssetRoutes(assetService));
  if (importService) app.route("/api/v1", createTransferRoutes(importService, exportService));
  if (shareLinkService) app.route("/api/v1", createShareLinkRoutes(shareLinkService));
  app.route("/api/v1", createDeletionRoutes(workspaceDeletionService, accountDeletionService));
  app.route("/api/v1", createMaintenanceRoutes(maintenanceService, operatorAuthorizer));

  return {
    app,
    ready: limiterReady,
    readiness,
    async close() {
      try {
        ownedStorage?.destroy?.();
      } finally {
        if (ownsDb) await db.$client.end();
      }
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
