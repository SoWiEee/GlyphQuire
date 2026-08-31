import type { Database } from "@glyphquire/database";
import { idempotencyKeySchema, opaqueAuthIdSchema } from "@glyphquire/api-contract/jobs";
import type {
  JobDispatcher,
  JobDatabaseExecutor,
  TransactionalJobDispatcher,
} from "@glyphquire/queue";
import { PublicApiError } from "../../middleware/error-handler.js";

type DbTransaction = Parameters<Database["transaction"]>[0] extends (tx: infer Tx) => unknown
  ? Tx
  : never;

export interface TransferLifecycle<T> {
  replay(): Promise<T | undefined>;
  transaction(tx: DbTransaction, dispatcher: JobDispatcher): Promise<T>;
}

export interface TransferStage<T> {
  replay(): Promise<T | undefined>;
  insert(): Promise<void>;
}

export interface TransferScopeShape {
  readonly [key: string]: unknown;
}

function isTransactionalDispatcher(
  dispatcher: JobDispatcher,
): dispatcher is TransactionalJobDispatcher {
  return (
    "withDatabaseExecutor" in dispatcher && typeof dispatcher.withDatabaseExecutor === "function"
  );
}

function isUniqueViolation(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { code?: string; cause?: { code?: string } };
  return candidate.code === "23505" || candidate.cause?.code === "23505";
}

/**
 * Owns the shared transfer lifecycle: replay before creation, one transaction
 * for row creation plus enqueue, and deterministic unique-key race replay.
 * Import and export supply only operation-specific row/artifact callbacks.
 */
export class TransferCoordinator {
  constructor(
    private readonly db: Database,
    private readonly dispatcher: JobDispatcher,
  ) {}

  /** Validates the common identity portion of every transfer request. */
  validateIdentity(actorId: string, idempotencyKey: string, invalid: () => never): void {
    if (
      !opaqueAuthIdSchema.safeParse(actorId).success ||
      !idempotencyKeySchema.safeParse(idempotencyKey).success
    ) {
      invalid();
    }
  }

  /** Rejects arrays, inherited keys, and fields outside the operation scope. */
  validateScopeShape(
    scope: unknown,
    allowedKeys: readonly string[],
    invalid: () => never,
  ): asserts scope is TransferScopeShape {
    if (
      !scope ||
      typeof scope !== "object" ||
      Array.isArray(scope) ||
      Object.getPrototypeOf(scope) !== Object.prototype ||
      Object.keys(scope).some((key) => !allowedKeys.includes(key))
    ) {
      invalid();
    }
  }

  /** Computes a bounded transfer expiry at the lifecycle boundary. */
  validateSeconds(seconds: number, label: string): number {
    if (!Number.isInteger(seconds) || seconds < 1 || seconds > 31_536_000) {
      throw new Error(`Invalid ${label}`);
    }
    return seconds;
  }

  expiryAt(now: Date, seconds: number, label: string): Date {
    if (!Number.isFinite(now.getTime())) throw new Error(`Invalid ${label} clock`);
    return new Date(now.getTime() + this.validateSeconds(seconds, label) * 1_000);
  }

  /** Converts storage/queue failures to a scrubbed public error after cleanup. */
  async withFailureBoundary<T>(
    operation: () => Promise<T>,
    compensate: () => Promise<void>,
  ): Promise<T> {
    try {
      return await operation();
    } catch {
      try {
        await compensate();
      } catch {
        // Compensation is best effort; the public error remains scrubbed.
      }
      throw new PublicApiError("SERVICE_UNAVAILABLE", 503);
    }
  }

  transactionalDispatcher(tx: DbTransaction): JobDispatcher {
    if (!isTransactionalDispatcher(this.dispatcher)) {
      throw new Error("JOB_FAILED: transactional enqueue unavailable");
    }
    return this.dispatcher.withDatabaseExecutor(tx as JobDatabaseExecutor);
  }

  async run<T>(lifecycle: TransferLifecycle<T>): Promise<T> {
    const replay = await lifecycle.replay();
    if (replay !== undefined) return replay;

    try {
      return await this.db.transaction((tx) =>
        lifecycle.transaction(tx, this.transactionalDispatcher(tx)),
      );
    } catch (error) {
      if (isUniqueViolation(error)) {
        const raced = await lifecycle.replay();
        if (raced !== undefined) return raced;
      }
      throw error;
    }
  }

  async stage<T>(stage: TransferStage<T>): Promise<T | undefined> {
    const replay = await stage.replay();
    if (replay !== undefined) return replay;
    try {
      await stage.insert();
      return undefined;
    } catch (error) {
      if (isUniqueViolation(error)) {
        const raced = await stage.replay();
        if (raced !== undefined) return raced;
      }
      throw error;
    }
  }
}

export type { DbTransaction };
