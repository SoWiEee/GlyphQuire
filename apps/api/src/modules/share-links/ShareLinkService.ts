import {
  createHash,
  createHmac,
  randomBytes as nodeRandomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import {
  canonicalUuidSchema,
  createShareLinkInputSchema,
  idempotencyKeySchema,
  shareLinkResponseSchema,
  sharedNoteResponseSchema,
  type CreateShareLinkInput,
  type ShareLinkResponse,
  type SharedNoteResponse,
} from "@glyphquire/api-contract";
import {
  notes,
  shareLinks,
  workspaceMembers,
  type Database,
  type IdempotencyStore,
} from "@glyphquire/database";
import type {
  JobDatabaseExecutor,
  JobDispatcher,
  TransactionalJobDispatcher,
} from "@glyphquire/queue";
import { and, eq, gt, isNull, or } from "drizzle-orm";
import { PublicApiError } from "../../middleware/error-handler.js";

const TOKEN_BYTES = 32;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const HASH_PATTERN = /^[0-9a-f]{64}$/u;
const HASH_KEY_DOMAIN = "glyphquire:share-link-token-hmac-key:v1";
const HASH_VALUE_DOMAIN = "glyphquire:share-link-token:v1\0";
const REQUEST_HASH_DOMAIN = "glyphquire:share-link-create:v1\0";
const MAX_HASH_KEY_BYTES = 4_096;
const MAX_ACTOR_ID_BYTES = 200;
const MAX_DELETE_GRACE_SECONDS = 31_536_000;
const MILLISECONDS_PER_SECOND = 1_000;

type RandomBytes = (size: number) => Uint8Array;

export interface ShareLinkServiceHooks {
  afterIdempotencyComplete?(): void | Promise<void>;
}

export interface ShareLinkServiceOptions {
  tokenHashKey: string | Uint8Array;
  publicBaseUrl: string | URL;
  deleteGraceSeconds?: number;
  clock?: () => number;
  randomBytes?: RandomBytes;
  hooks?: ShareLinkServiceHooks;
}

export interface ShareLinkManagementService {
  create(
    actorId: string,
    noteId: string,
    input: CreateShareLinkInput,
    idempotencyKey: string,
  ): Promise<ShareLinkResponse>;
  revoke(actorId: string, linkId: string): Promise<void>;
}

export interface SharedNoteResolver {
  resolve(token: string): Promise<SharedNoteResponse>;
}

export interface ShareLinkService extends ShareLinkManagementService, SharedNoteResolver {}

function notFound(): never {
  throw new PublicApiError("SHARE_NOT_FOUND", 404);
}

function invalidRequest(): never {
  throw new PublicApiError("DOCUMENT_INVALID", 400);
}

function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function validActorId(actorId: string): boolean {
  return actorId.length > 0 && utf8Bytes(actorId) <= MAX_ACTOR_ID_BYTES;
}

function decodeHashKey(value: string | Uint8Array): Buffer {
  let key: Buffer;
  if (typeof value === "string") {
    if (!/^[A-Za-z0-9_-]{43}$/u.test(value)) {
      throw new Error("Share token hash key must be a canonical base64url 32-byte key");
    }
    key = Buffer.from(value, "base64url");
    if (key.byteLength !== 32 || key.toString("base64url") !== value) {
      throw new Error("Share token hash key must be a canonical base64url 32-byte key");
    }
  } else {
    key = Buffer.from(value);
    if (key.byteLength < 32 || key.byteLength > MAX_HASH_KEY_BYTES) {
      throw new Error("Share token hash key must contain between 32 and 4096 bytes");
    }
  }
  return key;
}

export function hashShareToken(token: string, key: string | Uint8Array): string {
  const derivedKey = createHmac("sha256", decodeHashKey(key))
    .update(HASH_KEY_DOMAIN, "utf8")
    .digest();
  return createHmac("sha256", derivedKey)
    .update(HASH_VALUE_DOMAIN, "utf8")
    .update(token, "utf8")
    .digest("hex");
}

export function constantTimeShareHashEquals(left: string, right: string): boolean {
  if (!HASH_PATTERN.test(left) || !HASH_PATTERN.test(right)) return false;
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

function canonicalToken(token: string): boolean {
  if (!TOKEN_PATTERN.test(token)) return false;
  const bytes = Buffer.from(token, "base64url");
  return bytes.byteLength === TOKEN_BYTES && bytes.toString("base64url") === token;
}

function canonicalRequestHash(noteId: string, expiresAt: string | null): string {
  return createHash("sha256")
    .update(REQUEST_HASH_DOMAIN, "utf8")
    .update(JSON.stringify({ noteId, expiresAt }), "utf8")
    .digest("hex");
}

function canonicalPublicOrigin(value: string | URL): URL {
  const parsed = value instanceof URL ? new URL(value.href) : new URL(value);
  if (
    !["http:", "https:"].includes(parsed.protocol) ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.search !== "" ||
    parsed.hash !== ""
  ) {
    throw new Error("Invalid public share base URL");
  }
  return new URL(parsed.origin);
}

function validClockValue(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

export class ShareLinkServiceImpl implements ShareLinkService {
  private readonly tokenHashKey: Buffer;
  private readonly publicOrigin: URL;
  private readonly deleteGraceSeconds: number;
  private readonly clock: () => number;
  private readonly randomBytes: RandomBytes;
  private readonly hooks: ShareLinkServiceHooks;

  constructor(
    private readonly db: Database,
    private readonly idempotencyStore: IdempotencyStore,
    private readonly jobDispatcher: JobDispatcher,
    options: ShareLinkServiceOptions,
  ) {
    this.tokenHashKey = decodeHashKey(options.tokenHashKey);
    this.publicOrigin = canonicalPublicOrigin(options.publicBaseUrl);
    this.deleteGraceSeconds = options.deleteGraceSeconds ?? 3_600;
    if (
      !Number.isInteger(this.deleteGraceSeconds) ||
      this.deleteGraceSeconds < 1 ||
      this.deleteGraceSeconds > MAX_DELETE_GRACE_SECONDS
    ) {
      throw new Error("Invalid share cleanup grace seconds");
    }
    this.clock = options.clock ?? Date.now;
    this.randomBytes = options.randomBytes ?? nodeRandomBytes;
    this.hooks = options.hooks ?? {};
  }

  private transactionDispatcher(executor: JobDatabaseExecutor): JobDispatcher {
    const transactional = this.jobDispatcher as Partial<TransactionalJobDispatcher>;
    if (typeof transactional.withDatabaseExecutor !== "function") {
      throw new Error("Share revocation requires a transaction-bound job dispatcher");
    }
    return transactional.withDatabaseExecutor(executor);
  }

  private async loadOwnedNote(actorId: string, noteId: string) {
    if (!validActorId(actorId) || !canonicalUuidSchema.safeParse(noteId).success) notFound();
    const [row] = await this.db
      .select({
        noteId: notes.id,
        workspaceId: notes.workspaceId,
        ownerId: notes.ownerId,
      })
      .from(notes)
      .innerJoin(
        workspaceMembers,
        and(
          eq(workspaceMembers.workspaceId, notes.workspaceId),
          eq(workspaceMembers.userId, actorId),
        ),
      )
      .where(and(eq(notes.id, noteId), eq(notes.ownerId, actorId), isNull(notes.deletedAt)))
      .limit(1);
    if (!row) notFound();
    return row;
  }

  private async persistResponse(actorId: string, response: ShareLinkResponse): Promise<void> {
    const expectedHash = hashShareToken(response.token, this.tokenHashKey);
    const createdAt = new Date(response.createdAt);
    const expiresAt = response.expiresAt === null ? null : new Date(response.expiresAt);

    await this.db.transaction(async (transaction) => {
      const [existing] = await transaction
        .select()
        .from(shareLinks)
        .where(eq(shareLinks.id, response.id))
        .limit(1)
        .for("update");
      if (existing) {
        const matches =
          existing.workspaceId === response.workspaceId &&
          existing.noteId === response.noteId &&
          existing.creatorId === actorId &&
          existing.scopeType === "note" &&
          existing.createdAt.getTime() === createdAt.getTime() &&
          (existing.expiresAt?.getTime() ?? null) === (expiresAt?.getTime() ?? null) &&
          constantTimeShareHashEquals(existing.tokenHash, expectedHash);
        if (!matches) throw new Error("Share idempotency row mismatch");
        return;
      }

      const [authorized] = await transaction
        .select({ noteId: notes.id, workspaceId: notes.workspaceId })
        .from(notes)
        .innerJoin(
          workspaceMembers,
          and(
            eq(workspaceMembers.workspaceId, notes.workspaceId),
            eq(workspaceMembers.userId, actorId),
          ),
        )
        .where(
          and(
            eq(notes.id, response.noteId),
            eq(notes.workspaceId, response.workspaceId),
            eq(notes.ownerId, actorId),
            isNull(notes.deletedAt),
          ),
        )
        .limit(1)
        .for("update");
      if (!authorized) notFound();

      const [inserted] = await transaction
        .insert(shareLinks)
        .values({
          id: response.id,
          workspaceId: response.workspaceId,
          noteId: response.noteId,
          creatorId: actorId,
          scopeType: "note",
          tokenHash: expectedHash,
          expiresAt,
          createdAt,
          updatedAt: createdAt,
        })
        .onConflictDoNothing()
        .returning({ id: shareLinks.id });
      if (!inserted) throw new Error("Share link persistence conflict");
    });
  }

  async create(
    actorId: string,
    noteId: string,
    input: CreateShareLinkInput,
    idempotencyKey: string,
  ): Promise<ShareLinkResponse> {
    const parsedInput = createShareLinkInputSchema.safeParse(input);
    if (!parsedInput.success || !idempotencyKeySchema.safeParse(idempotencyKey).success) {
      invalidRequest();
    }
    const ownedNote = await this.loadOwnedNote(actorId, noteId);
    const now = this.clock();
    if (!validClockValue(now)) throw new Error("Invalid share service clock");
    const createdAt = new Date(now);
    const expiresAtText = parsedInput.data.expiresAt ?? null;
    const expiresAt = expiresAtText === null ? null : new Date(expiresAtText);
    if (expiresAt !== null && expiresAt.getTime() <= now) invalidRequest();

    const lease = await this.idempotencyStore.begin({
      workspaceId: ownedNote.workspaceId,
      actorId,
      operation: "share.create",
      key: idempotencyKey,
      requestHash: canonicalRequestHash(noteId, expiresAt?.toISOString() ?? null),
      responseSchema: shareLinkResponseSchema,
    });
    if (lease.kind === "conflict" || lease.kind === "in_progress") {
      throw new PublicApiError("OPERATION_REUSED", 409);
    }
    if (lease.kind === "replay") {
      if (
        lease.response.workspaceId !== ownedNote.workspaceId ||
        lease.response.noteId !== noteId
      ) {
        throw new Error("Share idempotency scope mismatch");
      }
      await this.persistResponse(actorId, lease.response);
      return lease.response;
    }

    const tokenBytes = this.randomBytes(TOKEN_BYTES);
    if (tokenBytes.byteLength !== TOKEN_BYTES) throw new Error("Invalid share token source");
    const token = Buffer.from(tokenBytes).toString("base64url");
    if (!canonicalToken(token)) throw new Error("Invalid share token source");
    const id = randomUUID();
    const url = new URL(`/api/v1/shared/${token}`, this.publicOrigin);
    const response = shareLinkResponseSchema.parse({
      id,
      workspaceId: ownedNote.workspaceId,
      noteId,
      token,
      url: url.href,
      expiresAt: expiresAt?.toISOString() ?? null,
      createdAt: createdAt.toISOString(),
    });

    // The encrypted response is completed before the hash-only row is inserted.
    // If the process dies between these writes, the same scoped request recovers
    // this exact token from authenticated ciphertext and inserts the same UUID.
    await this.idempotencyStore.complete(lease.recordId, lease.leaseToken, response);
    await this.hooks.afterIdempotencyComplete?.();
    await this.persistResponse(actorId, response);
    return response;
  }

  async revoke(actorId: string, linkId: string): Promise<void> {
    if (!validActorId(actorId) || !canonicalUuidSchema.safeParse(linkId).success) notFound();
    const now = this.clock();
    if (!validClockValue(now)) throw new Error("Invalid share service clock");

    await this.db.transaction(async (transaction) => {
      const [owned] = await transaction
        .select({
          id: shareLinks.id,
          workspaceId: shareLinks.workspaceId,
          creatorId: shareLinks.creatorId,
          createdAt: shareLinks.createdAt,
          revokedAt: shareLinks.revokedAt,
        })
        .from(shareLinks)
        .innerJoin(
          notes,
          and(eq(notes.id, shareLinks.noteId), eq(notes.workspaceId, shareLinks.workspaceId)),
        )
        .innerJoin(
          workspaceMembers,
          and(
            eq(workspaceMembers.workspaceId, shareLinks.workspaceId),
            eq(workspaceMembers.userId, actorId),
          ),
        )
        .where(
          and(
            eq(shareLinks.id, linkId),
            eq(shareLinks.creatorId, actorId),
            eq(notes.ownerId, actorId),
            isNull(notes.deletedAt),
          ),
        )
        .limit(1)
        .for("update");
      if (!owned) notFound();
      if (owned.revokedAt !== null) return;
      if (now < owned.createdAt.getTime()) throw new Error("Invalid share service clock");
      const revokedAt = new Date(now);
      const [updated] = await transaction
        .update(shareLinks)
        .set({ revokedAt, updatedAt: revokedAt })
        .where(and(eq(shareLinks.id, linkId), isNull(shareLinks.revokedAt)))
        .returning({ id: shareLinks.id });
      if (!updated) return;

      await this.transactionDispatcher(transaction).enqueue({
        workspaceId: owned.workspaceId,
        type: "share.cleanup",
        payload: {
          workspaceId: owned.workspaceId,
          scope: "one",
          shareLinkId: linkId,
        },
        idempotencyKey: `share-cleanup-${linkId}`,
        runAt: new Date(now + this.deleteGraceSeconds * MILLISECONDS_PER_SECOND),
      });
    });
  }

  async resolve(token: string): Promise<SharedNoteResponse> {
    if (!canonicalToken(token)) notFound();
    const now = this.clock();
    if (!validClockValue(now)) throw new Error("Invalid share service clock");
    const candidateHash = hashShareToken(token, this.tokenHashKey);
    const [row] = await this.db
      .select({
        tokenHash: shareLinks.tokenHash,
        noteId: notes.id,
        title: notes.title,
        contentMarkdown: notes.contentMarkdown,
        schemaVersion: notes.schemaVersion,
        updatedAt: notes.updatedAt,
      })
      .from(shareLinks)
      .innerJoin(
        notes,
        and(eq(notes.id, shareLinks.noteId), eq(notes.workspaceId, shareLinks.workspaceId)),
      )
      .innerJoin(
        workspaceMembers,
        and(
          eq(workspaceMembers.workspaceId, shareLinks.workspaceId),
          eq(workspaceMembers.userId, shareLinks.creatorId),
        ),
      )
      .where(
        and(
          eq(shareLinks.tokenHash, candidateHash),
          isNull(shareLinks.revokedAt),
          or(isNull(shareLinks.expiresAt), gt(shareLinks.expiresAt, new Date(now))),
          isNull(notes.deletedAt),
        ),
      )
      .limit(1);

    const storedHash = row?.tokenHash ?? "0".repeat(64);
    const hashMatches = constantTimeShareHashEquals(storedHash, candidateHash);
    if (!row || !hashMatches) notFound();
    return sharedNoteResponseSchema.parse({
      noteId: row.noteId,
      title: row.title,
      contentMarkdown: row.contentMarkdown,
      schemaVersion: row.schemaVersion,
      updatedAt: row.updatedAt.toISOString(),
    });
  }
}
