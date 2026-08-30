import { createHash } from "node:crypto";
import {
  MAINTENANCE_CAPABILITIES,
  assetCleanupRequestSchema,
  backupVerificationQuerySchema,
  backupVerificationResponseSchema,
  canonicalUuidSchema,
  deadLetterQuerySchema,
  deadLetterReplayParamsSchema,
  deadLetterResponseSchema,
  decodeCursor,
  encodeCursor,
  idempotencyKeySchema,
  jobEnvelopeSchema,
  jobPayloadSchemas,
  jobTypeSchema,
  maintenanceCapabilitiesResponseSchema,
  maintenanceJobMutationResponseSchema,
  maintenanceSearchRebuildRequestSchema,
  requestIdSchema,
  type AssetCleanupRequest,
  type BackupVerificationQuery,
  type BackupVerificationResponse,
  type DeadLetterQuery,
  type DeadLetterResponse,
  type JobPayload,
  type JobType,
  type MaintenanceCapabilitiesResponse,
  type MaintenanceJobMutationResponse,
  type MaintenanceSearchRebuildRequest,
} from "@glyphquire/api-contract";
import { jobs, type Database } from "@glyphquire/database";
import type { JobDispatcher } from "@glyphquire/queue";
import { and, asc, eq, gt, or } from "drizzle-orm";
import { Hono, type Context, type MiddlewareHandler } from "hono";
import type { ZodType } from "zod";
import { PublicApiError } from "../../middleware/error-handler.js";
import { getRequestContext } from "../../middleware/request-context.js";
import type { SecurityVariables } from "../../middleware/security.js";
import type { OperatorAuthorizer } from "../../modules/search/OperatorAuthorizer.js";

export type { BackupVerificationQuery, DeadLetterQuery } from "@glyphquire/api-contract";

const DIAGNOSTIC_QUERY_PARAMETERS = new Set(["cursor", "pageSize"]);
const REPLAY_IDEMPOTENCY_DOMAIN = "glyphquire:maintenance-replay:v1";

export interface MaintenanceService {
  capabilities(actorId: string): Promise<MaintenanceCapabilitiesResponse>;
  startSearchRebuild(
    actorId: string,
    input: MaintenanceSearchRebuildRequest,
    idempotencyKey: string,
    requestId: string,
  ): Promise<MaintenanceJobMutationResponse>;
  listDeadLetters(actorId: string, query: DeadLetterQuery): Promise<DeadLetterResponse>;
  replayDeadLetter(
    actorId: string,
    deadLetterId: string,
    idempotencyKey: string,
    requestId: string,
  ): Promise<MaintenanceJobMutationResponse>;
  startAssetCleanup(
    actorId: string,
    input: AssetCleanupRequest,
    idempotencyKey: string,
    requestId: string,
  ): Promise<MaintenanceJobMutationResponse>;
  backupVerification(
    actorId: string,
    query: BackupVerificationQuery,
  ): Promise<BackupVerificationResponse>;
}

function invalidRequest(): never {
  throw new PublicApiError("DOCUMENT_INVALID", 400);
}

function notFound(): never {
  throw new PublicApiError("NOTE_NOT_FOUND", 404);
}

function reused(): never {
  throw new PublicApiError("OPERATION_REUSED", 409);
}

function storedJobInvalid(): never {
  throw new PublicApiError("JOB_FAILED", 503);
}

function parseCursor(value: string | undefined): { createdAt: Date; id: string } | undefined {
  if (value === undefined) return undefined;
  try {
    const decoded = decodeCursor(value);
    const createdAt = new Date(decoded.createdAt);
    if (Number.isNaN(createdAt.getTime())) invalidRequest();
    return { createdAt, id: decoded.id };
  } catch {
    invalidRequest();
  }
}

function afterCursor(cursor: { createdAt: Date; id: string }) {
  return or(
    gt(jobs.createdAt, cursor.createdAt),
    and(eq(jobs.createdAt, cursor.createdAt), gt(jobs.id, cursor.id)),
  );
}

function scrubErrorCode(value: string | null): "JOB_INVALID" | "JOB_FAILED" {
  return value?.startsWith("JOB_INVALID") ? "JOB_INVALID" : "JOB_FAILED";
}

function replayIdempotencyKey(deadLetterId: string, idempotencyKey: string): string {
  const digest = createHash("sha256")
    .update(REPLAY_IDEMPOTENCY_DOMAIN)
    .update("\0")
    .update(deadLetterId)
    .update("\0")
    .update(idempotencyKey)
    .digest("hex");
  return `replay-${digest}`;
}

export class MaintenanceServiceImpl implements MaintenanceService {
  constructor(
    private readonly db: Database,
    private readonly dispatcher: JobDispatcher,
    private readonly operatorAuthorizer: OperatorAuthorizer,
  ) {}

  private authorize(actorId: string): void {
    this.operatorAuthorizer.authorize(actorId);
  }

  private validateMutation(idempotencyKey: string, requestId: string): void {
    if (
      !idempotencyKeySchema.safeParse(idempotencyKey).success ||
      !requestIdSchema.safeParse(requestId).success
    ) {
      invalidRequest();
    }
  }

  private async mutationResponse(
    enqueued: { id: string; duplicate: boolean },
    expected: {
      workspaceId: string | null;
      type: JobType;
      payload: JobPayload<JobType>;
    },
  ): Promise<MaintenanceJobMutationResponse> {
    if (enqueued.duplicate) {
      const [stored] = await this.db
        .select({
          workspaceId: jobs.workspaceId,
          type: jobs.type,
          payload: jobs.payload,
        })
        .from(jobs)
        .where(eq(jobs.id, enqueued.id))
        .limit(1);
      if (!stored) storedJobInvalid();
      const storedType = jobTypeSchema.safeParse(stored.type);
      const expectedPayload = jobPayloadSchemas[expected.type].safeParse(expected.payload);
      const storedPayload = jobPayloadSchemas[expected.type].safeParse(stored.payload);
      if (
        !storedType.success ||
        storedType.data !== expected.type ||
        stored.workspaceId !== expected.workspaceId ||
        !expectedPayload.success ||
        !storedPayload.success ||
        JSON.stringify(storedPayload.data) !== JSON.stringify(expectedPayload.data)
      ) {
        reused();
      }
    }
    return maintenanceJobMutationResponseSchema.parse({
      jobId: enqueued.id,
      duplicate: enqueued.duplicate,
    });
  }

  async capabilities(actorId: string): Promise<MaintenanceCapabilitiesResponse> {
    this.authorize(actorId);
    return maintenanceCapabilitiesResponseSchema.parse({
      operator: true,
      capabilities: [...MAINTENANCE_CAPABILITIES],
    });
  }

  async startSearchRebuild(
    actorId: string,
    input: MaintenanceSearchRebuildRequest,
    idempotencyKey: string,
    requestId: string,
  ): Promise<MaintenanceJobMutationResponse> {
    this.authorize(actorId);
    this.validateMutation(idempotencyKey, requestId);
    const parsed = maintenanceSearchRebuildRequestSchema.safeParse(input);
    if (!parsed.success) invalidRequest();

    const payload = {
      workspaceId: parsed.data.workspaceId,
      scope: "workspace" as const,
      batchSize: parsed.data.batchSize,
      ...(parsed.data.cursor === undefined ? {} : { cursor: parsed.data.cursor }),
    };
    const enqueued = await this.dispatcher.enqueue({
      workspaceId: parsed.data.workspaceId,
      type: "search.rebuild",
      payload,
      idempotencyKey,
    });
    return this.mutationResponse(enqueued, {
      workspaceId: parsed.data.workspaceId,
      type: "search.rebuild",
      payload,
    });
  }

  async listDeadLetters(actorId: string, query: DeadLetterQuery): Promise<DeadLetterResponse> {
    this.authorize(actorId);
    const parsed = deadLetterQuerySchema.safeParse(query);
    if (!parsed.success) invalidRequest();
    const cursor = parseCursor(parsed.data.cursor);
    const rows = await this.db
      .select()
      .from(jobs)
      .where(
        cursor
          ? and(eq(jobs.status, "dead_letter"), afterCursor(cursor))
          : eq(jobs.status, "dead_letter"),
      )
      .orderBy(asc(jobs.createdAt), asc(jobs.id))
      .limit(parsed.data.pageSize + 1);
    const hasMore = rows.length > parsed.data.pageSize;
    const page = hasMore ? rows.slice(0, parsed.data.pageSize) : rows;
    const items = page.map((row) => {
      const type = jobTypeSchema.safeParse(row.type);
      if (!type.success || row.deadLetteredAt === null) storedJobInvalid();
      return {
        id: row.id,
        workspaceId: row.workspaceId,
        type: type.data,
        attempts: row.attempts,
        maxAttempts: row.maxAttempts,
        createdAt: row.createdAt.toISOString(),
        deadLetteredAt: row.deadLetteredAt.toISOString(),
        errorCode: scrubErrorCode(row.lastError),
      };
    });
    const last = page.at(-1);
    return deadLetterResponseSchema.parse({
      items,
      nextCursor:
        hasMore && last
          ? encodeCursor({ createdAt: last.createdAt.toISOString(), id: last.id })
          : null,
    });
  }

  async replayDeadLetter(
    actorId: string,
    deadLetterId: string,
    idempotencyKey: string,
    requestId: string,
  ): Promise<MaintenanceJobMutationResponse> {
    this.authorize(actorId);
    this.validateMutation(idempotencyKey, requestId);
    if (!canonicalUuidSchema.safeParse(deadLetterId).success) invalidRequest();

    const [stored] = await this.db
      .select()
      .from(jobs)
      .where(and(eq(jobs.id, deadLetterId), eq(jobs.status, "dead_letter")))
      .limit(1);
    if (!stored) notFound();
    const envelope = jobEnvelopeSchema.safeParse({
      id: stored.id,
      workspaceId: stored.workspaceId,
      type: stored.type,
      version: stored.version,
      attempts: Math.max(stored.attempts, 1),
      createdAt: stored.createdAt.toISOString(),
      payload: stored.payload,
    });
    if (!envelope.success) storedJobInvalid();

    const replayPayload = envelope.data.payload as JobPayload<JobType>;
    const enqueued = await this.dispatcher.enqueue({
      workspaceId: envelope.data.workspaceId,
      type: envelope.data.type,
      // jobEnvelopeSchema has already selected the exact payload schema for
      // envelope.data.type. Zod's transformed union exposes `unknown` here,
      // so retain that runtime proof at the dispatcher boundary explicitly.
      payload: replayPayload,
      idempotencyKey: replayIdempotencyKey(deadLetterId, idempotencyKey),
    });
    return this.mutationResponse(enqueued, {
      workspaceId: envelope.data.workspaceId,
      type: envelope.data.type,
      payload: replayPayload,
    });
  }

  async startAssetCleanup(
    actorId: string,
    input: AssetCleanupRequest,
    idempotencyKey: string,
    requestId: string,
  ): Promise<MaintenanceJobMutationResponse> {
    this.authorize(actorId);
    this.validateMutation(idempotencyKey, requestId);
    const parsed = assetCleanupRequestSchema.safeParse(input);
    if (!parsed.success) invalidRequest();

    const payload = {
      workspaceId: parsed.data.workspaceId,
      batchSize: parsed.data.batchSize,
      ...(parsed.data.cursor === undefined ? {} : { cursor: parsed.data.cursor }),
    };
    const enqueued = await this.dispatcher.enqueue({
      workspaceId: parsed.data.workspaceId,
      type: "asset.orphan_cleanup",
      payload,
      idempotencyKey,
    });
    return this.mutationResponse(enqueued, {
      workspaceId: parsed.data.workspaceId,
      type: "asset.orphan_cleanup",
      payload,
    });
  }

  async backupVerification(
    actorId: string,
    query: BackupVerificationQuery,
  ): Promise<BackupVerificationResponse> {
    this.authorize(actorId);
    const parsed = backupVerificationQuerySchema.safeParse(query);
    if (!parsed.success) invalidRequest();
    const cursor = parseCursor(parsed.data.cursor);
    const rows = await this.db
      .select()
      .from(jobs)
      .where(
        cursor
          ? and(eq(jobs.type, "backup.verify"), afterCursor(cursor))
          : eq(jobs.type, "backup.verify"),
      )
      .orderBy(asc(jobs.createdAt), asc(jobs.id))
      .limit(parsed.data.pageSize + 1);
    const hasMore = rows.length > parsed.data.pageSize;
    const page = hasMore ? rows.slice(0, parsed.data.pageSize) : rows;
    const items = page.map((row) => {
      const payload = jobPayloadSchemas["backup.verify"].safeParse(row.payload);
      if (!payload.success) storedJobInvalid();
      return {
        jobId: row.id,
        backupId: payload.data.backupId,
        status: row.status,
        createdAt: row.createdAt.toISOString(),
        completedAt: row.completedAt?.toISOString() ?? null,
        errorCode: row.lastError === null ? null : scrubErrorCode(row.lastError),
      };
    });
    const last = page.at(-1);
    return backupVerificationResponseSchema.parse({
      items,
      nextCursor:
        hasMore && last
          ? encodeCursor({ createdAt: last.createdAt.toISOString(), id: last.id })
          : null,
    });
  }
}

function operatorOnly(
  operatorAuthorizer: OperatorAuthorizer,
): MiddlewareHandler<{ Variables: SecurityVariables }> {
  return async (context, next) => {
    operatorAuthorizer.authorize(getRequestContext(context).actorId);
    await next();
  };
}

function requireNoQuery(context: Context<{ Variables: SecurityVariables }>): void {
  if ([...new URL(context.req.url).searchParams.keys()].length > 0) invalidRequest();
}

function rawDiagnosticQuery(context: Context<{ Variables: SecurityVariables }>) {
  const searchParams = new URL(context.req.url).searchParams;
  if (
    [...searchParams.keys()].some((key) => !DIAGNOSTIC_QUERY_PARAMETERS.has(key)) ||
    [...DIAGNOSTIC_QUERY_PARAMETERS].some((key) => searchParams.getAll(key).length > 1)
  ) {
    invalidRequest();
  }
  return {
    cursor: context.req.query("cursor"),
    pageSize: context.req.query("pageSize"),
  };
}

async function parseJson<T>(request: Request, schema: ZodType<T>): Promise<T> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    invalidRequest();
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) invalidRequest();
  return parsed.data;
}

async function requireEmptyBody(request: Request): Promise<void> {
  let body: string;
  try {
    body = await request.text();
  } catch {
    invalidRequest();
  }
  if (body.length > 0) invalidRequest();
}

function requireIdempotencyKey(context: Context<{ Variables: SecurityVariables }>): string {
  const parsed = idempotencyKeySchema.safeParse(context.req.header("idempotency-key"));
  if (!parsed.success) invalidRequest();
  return parsed.data;
}

export function createMaintenanceRoutes(
  maintenance: MaintenanceService,
  operatorAuthorizer: OperatorAuthorizer,
) {
  return new Hono<{ Variables: SecurityVariables }>()
    .use("/maintenance/*", operatorOnly(operatorAuthorizer))
    .get("/maintenance/capabilities", async (context) => {
      requireNoQuery(context);
      const { actorId } = getRequestContext(context);
      const result = maintenanceCapabilitiesResponseSchema.parse(
        await maintenance.capabilities(actorId),
      );
      return context.json(result, 200);
    })
    .post("/maintenance/search-rebuild", async (context) => {
      requireNoQuery(context);
      const input = await parseJson(context.req.raw, maintenanceSearchRebuildRequestSchema);
      const idempotencyKey = requireIdempotencyKey(context);
      const { actorId, requestId } = getRequestContext(context);
      const result = maintenanceJobMutationResponseSchema.parse(
        await maintenance.startSearchRebuild(actorId, input, idempotencyKey, requestId),
      );
      return context.json(result, 202);
    })
    .get("/maintenance/dead-letters", async (context) => {
      const query = deadLetterQuerySchema.safeParse(rawDiagnosticQuery(context));
      if (!query.success) invalidRequest();
      const result = deadLetterResponseSchema.parse(
        await maintenance.listDeadLetters(getRequestContext(context).actorId, query.data),
      );
      return context.json(result, 200);
    })
    .post("/maintenance/dead-letters/:id/replay", async (context) => {
      requireNoQuery(context);
      await requireEmptyBody(context.req.raw);
      const params = deadLetterReplayParamsSchema.safeParse({ id: context.req.param("id") });
      if (!params.success) invalidRequest();
      const idempotencyKey = requireIdempotencyKey(context);
      const { actorId, requestId } = getRequestContext(context);
      const result = maintenanceJobMutationResponseSchema.parse(
        await maintenance.replayDeadLetter(actorId, params.data.id, idempotencyKey, requestId),
      );
      return context.json(result, 202);
    })
    .post("/maintenance/asset-cleanup", async (context) => {
      requireNoQuery(context);
      const input = await parseJson(context.req.raw, assetCleanupRequestSchema);
      const idempotencyKey = requireIdempotencyKey(context);
      const { actorId, requestId } = getRequestContext(context);
      const result = maintenanceJobMutationResponseSchema.parse(
        await maintenance.startAssetCleanup(actorId, input, idempotencyKey, requestId),
      );
      return context.json(result, 202);
    })
    .get("/maintenance/backup-verification", async (context) => {
      const query = backupVerificationQuerySchema.safeParse(rawDiagnosticQuery(context));
      if (!query.success) invalidRequest();
      const result = backupVerificationResponseSchema.parse(
        await maintenance.backupVerification(getRequestContext(context).actorId, query.data),
      );
      return context.json(result, 200);
    });
}
