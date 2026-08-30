import { randomUUID } from "node:crypto";
import {
  accountDeletions,
  workspaceDeletions,
  workspaceMembers,
  type AccountDeletion,
  type Database,
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
import { and, asc, eq, inArray } from "drizzle-orm";
import { PublicApiError } from "../../middleware/error-handler.js";

const DEFAULT_GRACE_SECONDS = 86_400;
const MINIMUM_GRACE_SECONDS = 86_400;
const MAX_GRACE_SECONDS = 31_536_000;
const MILLISECONDS_PER_SECOND = 1_000;

export interface AccountDeletionService {
  request(
    actorId: string,
    confirmation: DeletionConfirmation,
    idempotencyKey: string,
  ): Promise<DeletionResponse>;
}

export interface AccountDeletionServiceOptions {
  graceSeconds?: number;
  clock?: () => number;
}

type DbTransaction = Parameters<Database["transaction"]>[0] extends (tx: infer Tx) => unknown
  ? Tx
  : never;

function invalid(): never {
  throw new PublicApiError("DOCUMENT_INVALID", 400);
}

function reused(): never {
  throw new PublicApiError("OPERATION_REUSED", 409);
}

function isUniqueViolation(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { code?: string; cause?: { code?: string } };
  return candidate.code === "23505" || candidate.cause?.code === "23505";
}

function toResponse(row: AccountDeletion): DeletionResponse {
  return deletionResponseSchema.parse({
    id: row.id,
    status: row.status,
    confirmedAt: row.confirmedAt.toISOString(),
    executeAfter: row.executeAfter.toISOString(),
  });
}

function isTransactionalDispatcher(
  dispatcher: JobDispatcher,
): dispatcher is TransactionalJobDispatcher {
  return (
    "withDatabaseExecutor" in dispatcher && typeof dispatcher.withDatabaseExecutor === "function"
  );
}

export class AccountDeletionServiceImpl implements AccountDeletionService {
  private readonly graceSeconds: number;
  private readonly clock: () => number;

  constructor(
    private readonly db: Database,
    private readonly dispatcher: JobDispatcher,
    options: AccountDeletionServiceOptions = {},
  ) {
    this.graceSeconds = options.graceSeconds ?? DEFAULT_GRACE_SECONDS;
    if (
      !Number.isInteger(this.graceSeconds) ||
      this.graceSeconds < MINIMUM_GRACE_SECONDS ||
      this.graceSeconds > MAX_GRACE_SECONDS
    ) {
      throw new Error("Invalid account deletion grace seconds");
    }
    this.clock = options.clock ?? Date.now;
  }

  private transactionDispatcher(tx: DbTransaction): JobDispatcher {
    if (!isTransactionalDispatcher(this.dispatcher)) {
      throw new Error("JOB_FAILED: transactional enqueue unavailable");
    }
    return this.dispatcher.withDatabaseExecutor(tx);
  }

  async request(
    actorId: string,
    confirmation: DeletionConfirmation,
    idempotencyKey: string,
  ): Promise<DeletionResponse> {
    if (
      !opaqueAuthIdSchema.safeParse(actorId).success ||
      !idempotencyKeySchema.safeParse(idempotencyKey).success ||
      !deletionConfirmationSchema.safeParse(confirmation).success
    ) {
      invalid();
    }

    const existing = await this.db
      .select()
      .from(accountDeletions)
      .where(
        and(
          eq(accountDeletions.accountId, actorId),
          inArray(accountDeletions.status, ["pending", "processing", "failed", "completed"]),
        ),
      )
      .limit(1);
    if (existing[0]) {
      if (existing[0].idempotencyKey === idempotencyKey) return toResponse(existing[0]);
      reused();
    }

    const nowMs = this.clock();
    const now = new Date(nowMs);
    if (!Number.isFinite(nowMs) || Number.isNaN(now.getTime())) {
      throw new Error("Invalid account deletion clock");
    }
    const executeAfter = new Date(nowMs + this.graceSeconds * MILLISECONDS_PER_SECOND);
    const deletionId = randomUUID();
    const ownerWorkspaceRows = await this.db
      .select({ workspaceId: workspaceMembers.workspaceId })
      .from(workspaceMembers)
      .where(and(eq(workspaceMembers.userId, actorId), eq(workspaceMembers.role, "owner")))
      .orderBy(asc(workspaceMembers.workspaceId));
    const workspaceIds = [...new Set(ownerWorkspaceRows.map((row) => row.workspaceId))].filter(
      (workspaceId) => canonicalUuidSchema.safeParse(workspaceId).success,
    );

    try {
      const row = await this.db.transaction(async (tx) => {
        const [inserted] = await tx
          .insert(accountDeletions)
          .values({
            id: deletionId,
            accountId: actorId,
            confirmedAt: now,
            executeAfter,
            status: "pending",
            workspaceIds,
            idempotencyKey,
            manifest: {},
            sanitizedError: null,
            createdAt: now,
            updatedAt: now,
          })
          .returning();
        if (!inserted) throw new Error("JOB_FAILED: account deletion insert failed");

        const workspaceDeletionIds: string[] = [];
        for (const workspaceId of workspaceIds) {
          const workspaceDeletionId = randomUUID();
          workspaceDeletionIds.push(workspaceDeletionId);
          await tx.insert(workspaceDeletions).values({
            id: workspaceDeletionId,
            workspaceId,
            requestedBy: actorId,
            confirmedAt: now,
            executeAfter,
            status: "pending",
            idempotencyKey: `account-${deletionId}-${workspaceId}`,
            manifest: { accountDeletionId: deletionId },
            sanitizedError: null,
            createdAt: now,
            updatedAt: now,
          });
          await this.transactionDispatcher(tx).enqueue({
            workspaceId,
            type: "workspace.purge",
            payload: { workspaceId, deletionId: workspaceDeletionId },
            idempotencyKey: `workspace-purge-${workspaceDeletionId}`,
            runAt: executeAfter,
          });
        }

        if (workspaceDeletionIds.length === 0) {
          await this.transactionDispatcher(tx).enqueue({
            workspaceId: null,
            type: "account.purge",
            payload: { workspaceId: null, accountDeletionId: deletionId, accountId: actorId },
            idempotencyKey: `account-purge-${deletionId}`,
            runAt: executeAfter,
          });
        }

        return inserted;
      });
      return toResponse(row);
    } catch (error) {
      if (isUniqueViolation(error)) {
        const [raced] = await this.db
          .select()
          .from(accountDeletions)
          .where(
            and(
              eq(accountDeletions.accountId, actorId),
              eq(accountDeletions.idempotencyKey, idempotencyKey),
            ),
          )
          .limit(1);
        if (raced) return toResponse(raced);
        reused();
      }
      throw error;
    }
  }
}
