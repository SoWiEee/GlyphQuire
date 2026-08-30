import { randomUUID } from "node:crypto";
import {
  workspaceDeletions,
  workspaceMembers,
  type Database,
  type WorkspaceDeletion,
} from "@glyphquire/database";
import {
  canonicalUuidSchema,
  deletionConfirmationSchema,
  deletionResponseSchema,
  type DeletionConfirmation,
  type DeletionResponse,
} from "@glyphquire/api-contract";
import { idempotencyKeySchema, opaqueAuthIdSchema } from "@glyphquire/api-contract/jobs";
import type { JobDispatcher, TransactionalJobDispatcher } from "@glyphquire/queue";
import { and, eq, inArray } from "drizzle-orm";
import { PublicApiError } from "../../middleware/error-handler.js";

const DEFAULT_GRACE_SECONDS = 86_400;
const MINIMUM_GRACE_SECONDS = 86_400;
const MAX_GRACE_SECONDS = 31_536_000;
const MILLISECONDS_PER_SECOND = 1_000;

export interface WorkspaceDeletionService {
  request(
    actorId: string,
    workspaceId: string,
    confirmation: DeletionConfirmation,
    idempotencyKey: string,
  ): Promise<DeletionResponse>;
}

export interface WorkspaceDeletionServiceOptions {
  graceSeconds?: number;
  clock?: () => number;
}

type DbTransaction = Parameters<Database["transaction"]>[0] extends (tx: infer Tx) => unknown
  ? Tx
  : never;

function invalid(): never {
  throw new PublicApiError("DOCUMENT_INVALID", 400);
}

function notFound(): never {
  throw new PublicApiError("NOTE_NOT_FOUND", 404);
}

function reused(): never {
  throw new PublicApiError("OPERATION_REUSED", 409);
}

function isUniqueViolation(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { code?: string; cause?: { code?: string } };
  return candidate.code === "23505" || candidate.cause?.code === "23505";
}

function toResponse(row: WorkspaceDeletion): DeletionResponse {
  return deletionResponseSchema.parse({
    id: row.id,
    status: row.status,
    confirmedAt: row.confirmedAt.toISOString(),
    executeAfter: row.executeAfter.toISOString(),
  });
}

function validateConfirmation(value: unknown): DeletionConfirmation {
  const parsed = deletionConfirmationSchema.safeParse(value);
  if (!parsed.success) invalid();
  return parsed.data;
}

function isTransactionalDispatcher(
  dispatcher: JobDispatcher,
): dispatcher is TransactionalJobDispatcher {
  return (
    "withDatabaseExecutor" in dispatcher && typeof dispatcher.withDatabaseExecutor === "function"
  );
}

export class WorkspaceDeletionServiceImpl implements WorkspaceDeletionService {
  private readonly graceSeconds: number;
  private readonly clock: () => number;

  constructor(
    private readonly db: Database,
    private readonly dispatcher: JobDispatcher,
    options: WorkspaceDeletionServiceOptions = {},
  ) {
    this.graceSeconds = options.graceSeconds ?? DEFAULT_GRACE_SECONDS;
    if (
      !Number.isInteger(this.graceSeconds) ||
      this.graceSeconds < MINIMUM_GRACE_SECONDS ||
      this.graceSeconds > MAX_GRACE_SECONDS
    ) {
      throw new Error("Invalid workspace deletion grace seconds");
    }
    this.clock = options.clock ?? Date.now;
  }

  private transactionDispatcher(tx: DbTransaction): JobDispatcher {
    if (!isTransactionalDispatcher(this.dispatcher)) {
      throw new Error("JOB_FAILED: transactional enqueue unavailable");
    }
    return this.dispatcher.withDatabaseExecutor(tx);
  }

  private async requireOwner(actorId: string, workspaceId: string): Promise<void> {
    const [member] = await this.db
      .select({ role: workspaceMembers.role })
      .from(workspaceMembers)
      .where(
        and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, actorId)),
      )
      .limit(1);
    if (!member || member.role !== "owner") notFound();
  }

  async request(
    actorId: string,
    workspaceId: string,
    confirmation: DeletionConfirmation,
    idempotencyKey: string,
  ): Promise<DeletionResponse> {
    if (
      !opaqueAuthIdSchema.safeParse(actorId).success ||
      !canonicalUuidSchema.safeParse(workspaceId).success ||
      !idempotencyKeySchema.safeParse(idempotencyKey).success
    ) {
      invalid();
    }
    validateConfirmation(confirmation);
    await this.requireOwner(actorId, workspaceId);

    const existing = await this.db
      .select()
      .from(workspaceDeletions)
      .where(
        and(
          eq(workspaceDeletions.workspaceId, workspaceId),
          inArray(workspaceDeletions.status, ["pending", "processing", "failed", "completed"]),
        ),
      )
      .limit(1);
    if (existing[0]) {
      if (existing[0].requestedBy === actorId && existing[0].idempotencyKey === idempotencyKey) {
        return toResponse(existing[0]);
      }
      reused();
    }

    const nowMs = this.clock();
    const now = new Date(nowMs);
    if (!Number.isFinite(nowMs) || Number.isNaN(now.getTime())) {
      throw new Error("Invalid workspace deletion clock");
    }
    const executeAfter = new Date(nowMs + this.graceSeconds * MILLISECONDS_PER_SECOND);
    const deletionId = randomUUID();

    try {
      const row = await this.db.transaction(async (tx) => {
        const [inserted] = await tx
          .insert(workspaceDeletions)
          .values({
            id: deletionId,
            workspaceId,
            requestedBy: actorId,
            confirmedAt: now,
            executeAfter,
            status: "pending",
            idempotencyKey,
            manifest: {},
            sanitizedError: null,
            createdAt: now,
            updatedAt: now,
          })
          .returning();
        if (!inserted) throw new Error("JOB_FAILED: workspace deletion insert failed");
        await this.transactionDispatcher(tx).enqueue({
          workspaceId,
          type: "workspace.purge",
          payload: { workspaceId, deletionId },
          idempotencyKey: `workspace-purge-${deletionId}`,
          runAt: executeAfter,
        });
        return inserted;
      });
      return toResponse(row);
    } catch (error) {
      if (isUniqueViolation(error)) {
        const [raced] = await this.db
          .select()
          .from(workspaceDeletions)
          .where(
            and(
              eq(workspaceDeletions.workspaceId, workspaceId),
              eq(workspaceDeletions.idempotencyKey, idempotencyKey),
            ),
          )
          .limit(1);
        if (raced && raced.requestedBy === actorId) return toResponse(raced);
        reused();
      }
      throw error;
    }
  }
}
