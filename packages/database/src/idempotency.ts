import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes as nodeRandomBytes,
} from "node:crypto";
import { and, eq, gt, isNull } from "drizzle-orm";
import { z } from "zod";
import type { Database } from "./client.js";
import { idempotencyRecords } from "./schema/idempotency-records.js";

const CANONICAL_UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SAFE_KEY_PATTERN = /^[A-Za-z0-9._~-]+$/;
const SAFE_OPERATION_PATTERN = /^[A-Za-z0-9._:-]+$/;
const HASH_PATTERN = /^[0-9a-f]{64}$/;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;
const ENCRYPTION_VERSION = 1;
const IV_BYTES = 12;
const TOKEN_BYTES = 32;

const utf8ByteLength = (value: string) => new TextEncoder().encode(value).byteLength;

const encryptionEnvelopeSchema = z
  .object({
    version: z.literal(ENCRYPTION_VERSION),
    iv: z.string().length(16).regex(BASE64URL_PATTERN),
    ciphertext: z
      .string()
      .max(2 * 1024 * 1024)
      .regex(BASE64URL_PATTERN),
    tag: z.string().length(22).regex(BASE64URL_PATTERN),
  })
  .strict();

const beginBoundarySchema = z
  .object({
    workspaceId: z.string().regex(CANONICAL_UUID_PATTERN),
    actorId: z
      .string()
      .min(1)
      .refine((value) => utf8ByteLength(value) <= 200),
    operation: z.string().min(1).max(80).regex(SAFE_OPERATION_PATTERN),
    key: z
      .string()
      .min(1)
      .regex(SAFE_KEY_PATTERN)
      .refine((value) => utf8ByteLength(value) <= 200),
    requestHash: z.string().regex(HASH_PATTERN),
  })
  .strict();

export interface IdempotencyBackendBeginInput {
  workspaceId: string;
  actorId: string;
  operation: string;
  key: string;
  requestHash: string;
  ownerTokenHash: string;
  now: Date;
  leaseExpiresAt: Date;
}

export type IdempotencyBackendBeginResult =
  | { kind: "new"; recordId: string }
  | { kind: "in_progress"; leaseExpiresAt: Date }
  | { kind: "conflict" }
  | { kind: "replay"; recordId: string; responseCiphertext: string };

export interface IdempotencyBackendCompleteInput {
  recordId: string;
  ownerTokenHash: string;
  responseCiphertext: string;
  now: Date;
}

export interface IdempotencyBackend {
  begin(input: IdempotencyBackendBeginInput): Promise<IdempotencyBackendBeginResult>;
  complete(input: IdempotencyBackendCompleteInput): Promise<boolean>;
}

export class PostgresIdempotencyBackend implements IdempotencyBackend {
  constructor(private readonly db: Database) {}

  async begin(input: IdempotencyBackendBeginInput): Promise<IdempotencyBackendBeginResult> {
    return this.db.transaction(async (transaction) => {
      const inserted = await transaction
        .insert(idempotencyRecords)
        .values({
          workspaceId: input.workspaceId,
          actorId: input.actorId,
          operation: input.operation,
          idempotencyKey: input.key,
          requestHash: input.requestHash,
          ownerTokenHash: input.ownerTokenHash,
          leaseExpiresAt: input.leaseExpiresAt,
        })
        .onConflictDoNothing()
        .returning({ id: idempotencyRecords.id });
      const created = inserted[0];
      if (created) return { kind: "new", recordId: created.id };

      const existingRows = await transaction
        .select({
          id: idempotencyRecords.id,
          requestHash: idempotencyRecords.requestHash,
          responseCiphertext: idempotencyRecords.responseCiphertext,
          leaseExpiresAt: idempotencyRecords.leaseExpiresAt,
        })
        .from(idempotencyRecords)
        .where(
          and(
            eq(idempotencyRecords.workspaceId, input.workspaceId),
            eq(idempotencyRecords.actorId, input.actorId),
            eq(idempotencyRecords.operation, input.operation),
            eq(idempotencyRecords.idempotencyKey, input.key),
          ),
        )
        .for("update");
      const existing = existingRows[0];
      if (!existing) throw new Error("Idempotency record disappeared during claim");
      if (existing.requestHash !== input.requestHash) return { kind: "conflict" };
      if (existing.responseCiphertext !== null) {
        return {
          kind: "replay",
          recordId: existing.id,
          responseCiphertext: existing.responseCiphertext,
        };
      }
      if (existing.leaseExpiresAt && existing.leaseExpiresAt.getTime() > input.now.getTime()) {
        return { kind: "in_progress", leaseExpiresAt: existing.leaseExpiresAt };
      }

      await transaction
        .update(idempotencyRecords)
        .set({
          ownerTokenHash: input.ownerTokenHash,
          leaseExpiresAt: input.leaseExpiresAt,
        })
        .where(eq(idempotencyRecords.id, existing.id));
      return { kind: "new", recordId: existing.id };
    });
  }

  async complete(input: IdempotencyBackendCompleteInput): Promise<boolean> {
    const completed = await this.db
      .update(idempotencyRecords)
      .set({
        responseCiphertext: input.responseCiphertext,
        ownerTokenHash: null,
        leaseExpiresAt: null,
        completedAt: input.now,
      })
      .where(
        and(
          eq(idempotencyRecords.id, input.recordId),
          eq(idempotencyRecords.ownerTokenHash, input.ownerTokenHash),
          isNull(idempotencyRecords.responseCiphertext),
          isNull(idempotencyRecords.completedAt),
          gt(idempotencyRecords.leaseExpiresAt, input.now),
        ),
      )
      .returning({ id: idempotencyRecords.id });
    return completed.length === 1;
  }
}

export interface IdempotencyBeginInput<TResponse> {
  workspaceId: string;
  actorId: string;
  operation: string;
  key: string;
  requestHash: string;
  responseSchema: z.ZodType<TResponse>;
}

export type IdempotencyBeginResult<TResponse> =
  | { kind: "new"; recordId: string; leaseToken: string }
  | { kind: "in_progress"; retryAfterSeconds: number }
  | { kind: "conflict" }
  | { kind: "replay"; response: TResponse };

export interface IdempotencyStoreOptions {
  encryptionKey: string | Uint8Array;
  leaseSeconds?: number;
  clock?: () => number;
  randomBytes?: (size: number) => Uint8Array;
}

function base64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

export function decodeEncryptionKey(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]{43}$/u.test(value)) throw new Error("Invalid encryption key");
  const decoded = Buffer.from(value, "base64url");
  if (decoded.byteLength !== 32 || decoded.toString("base64url") !== value) {
    throw new Error("Invalid encryption key");
  }
  return decoded;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function aadFor(recordId: string): Buffer {
  return Buffer.from(`glyphquire:idempotency:v${ENCRYPTION_VERSION}:${recordId}`, "utf8");
}

function encryptResponse(
  recordId: string,
  key: Uint8Array,
  iv: Uint8Array,
  response: unknown,
): string {
  let plaintext: string;
  try {
    const serialized = JSON.stringify(response);
    if (serialized === undefined) throw new Error("not JSON serializable");
    plaintext = serialized;
  } catch {
    throw new Error("Idempotency response is not JSON serializable");
  }
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(aadFor(recordId));
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return JSON.stringify({
    version: ENCRYPTION_VERSION,
    iv: base64Url(iv),
    ciphertext: ciphertext.toString("base64url"),
    tag: cipher.getAuthTag().toString("base64url"),
  });
}

function decryptResponse(recordId: string, key: Uint8Array, value: string): unknown {
  try {
    const envelope = encryptionEnvelopeSchema.parse(JSON.parse(value));
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(envelope.iv, "base64url"));
    decipher.setAAD(aadFor(recordId));
    decipher.setAuthTag(Buffer.from(envelope.tag, "base64url"));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(envelope.ciphertext, "base64url")),
      decipher.final(),
    ]).toString("utf8");
    return JSON.parse(plaintext);
  } catch {
    throw new Error("Idempotency replay could not be authenticated");
  }
}

function isBackend(value: Database | IdempotencyBackend): value is IdempotencyBackend {
  return "begin" in value && typeof value.begin === "function" && "complete" in value;
}

export class IdempotencyStore {
  private readonly backend: IdempotencyBackend;
  private readonly encryptionKey: Uint8Array;
  private readonly leaseSeconds: number;
  private readonly clock: () => number;
  private readonly randomBytes: (size: number) => Uint8Array;

  constructor(databaseOrBackend: Database | IdempotencyBackend, options: IdempotencyStoreOptions) {
    this.backend = isBackend(databaseOrBackend)
      ? databaseOrBackend
      : new PostgresIdempotencyBackend(databaseOrBackend);
    this.encryptionKey =
      typeof options.encryptionKey === "string"
        ? decodeEncryptionKey(options.encryptionKey)
        : new Uint8Array(options.encryptionKey);
    if (this.encryptionKey.byteLength !== 32) throw new Error("Invalid encryption key");
    this.leaseSeconds = options.leaseSeconds ?? 60;
    if (!Number.isInteger(this.leaseSeconds) || this.leaseSeconds < 1 || this.leaseSeconds > 300) {
      throw new Error("Invalid idempotency lease duration");
    }
    this.clock = options.clock ?? Date.now;
    this.randomBytes = options.randomBytes ?? nodeRandomBytes;
  }

  async begin<TResponse>(
    input: IdempotencyBeginInput<TResponse>,
  ): Promise<IdempotencyBeginResult<TResponse>> {
    const boundary = beginBoundarySchema.parse({
      workspaceId: input.workspaceId,
      actorId: input.actorId,
      operation: input.operation,
      key: input.key,
      requestHash: input.requestHash,
    });
    const leaseToken = base64Url(this.randomBytes(TOKEN_BYTES));
    const now = new Date(this.clock());
    const result = await this.backend.begin({
      ...boundary,
      ownerTokenHash: sha256(leaseToken),
      now,
      leaseExpiresAt: new Date(now.getTime() + this.leaseSeconds * 1_000),
    });
    if (result.kind === "new") {
      return { kind: "new", recordId: result.recordId, leaseToken };
    }
    if (result.kind === "in_progress") {
      return {
        kind: "in_progress",
        retryAfterSeconds: Math.max(
          1,
          Math.ceil((result.leaseExpiresAt.getTime() - now.getTime()) / 1_000),
        ),
      };
    }
    if (result.kind === "conflict") return result;

    const decrypted = decryptResponse(
      result.recordId,
      this.encryptionKey,
      result.responseCiphertext,
    );
    const parsed = input.responseSchema.safeParse(decrypted);
    if (!parsed.success) throw new Error("Idempotency replay failed response validation");
    return { kind: "replay", response: parsed.data };
  }

  async complete(recordId: string, leaseToken: string, response: unknown): Promise<void> {
    if (!CANONICAL_UUID_PATTERN.test(recordId) || !/^[A-Za-z0-9_-]{43}$/u.test(leaseToken)) {
      throw new Error("Invalid idempotency lease");
    }
    const now = new Date(this.clock());
    const responseCiphertext = encryptResponse(
      recordId,
      this.encryptionKey,
      this.randomBytes(IV_BYTES),
      response,
    );
    const completed = await this.backend.complete({
      recordId,
      ownerTokenHash: sha256(leaseToken),
      responseCiphertext,
      now,
    });
    if (!completed) throw new Error("Idempotency lease is not current");
  }
}
