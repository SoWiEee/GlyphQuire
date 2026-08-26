import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  IdempotencyStore,
  type IdempotencyBackend,
  type IdempotencyBackendBeginInput,
  type IdempotencyBackendBeginResult,
  type IdempotencyBackendCompleteInput,
} from "./idempotency.js";

interface MemoryRecord {
  id: string;
  requestHash: string;
  ownerTokenHash: string | null;
  leaseExpiresAt: Date | null;
  responseCiphertext: string | null;
  completedAt: Date | null;
}

class MemoryBackend implements IdempotencyBackend {
  readonly records = new Map<string, MemoryRecord>();
  private readonly idsByScope = new Map<string, string>();
  private sequence = 0;

  async begin(input: IdempotencyBackendBeginInput): Promise<IdempotencyBackendBeginResult> {
    const scope = [input.workspaceId, input.actorId, input.operation, input.key].join("\0");
    const existingId = this.idsByScope.get(scope);
    if (!existingId) {
      const id = `00000000-0000-4000-8000-${String(++this.sequence).padStart(12, "0")}`;
      this.idsByScope.set(scope, id);
      this.records.set(id, {
        id,
        requestHash: input.requestHash,
        ownerTokenHash: input.ownerTokenHash,
        leaseExpiresAt: input.leaseExpiresAt,
        responseCiphertext: null,
        completedAt: null,
      });
      return { kind: "new", recordId: id };
    }

    const record = this.records.get(existingId)!;
    if (record.requestHash !== input.requestHash) return { kind: "conflict" };
    if (record.responseCiphertext !== null) {
      return {
        kind: "replay",
        recordId: record.id,
        responseCiphertext: record.responseCiphertext,
      };
    }
    if (record.leaseExpiresAt !== null && record.leaseExpiresAt.getTime() > input.now.getTime()) {
      return { kind: "in_progress", leaseExpiresAt: record.leaseExpiresAt };
    }

    record.ownerTokenHash = input.ownerTokenHash;
    record.leaseExpiresAt = input.leaseExpiresAt;
    return { kind: "new", recordId: record.id };
  }

  async complete(input: IdempotencyBackendCompleteInput): Promise<boolean> {
    const record = this.records.get(input.recordId);
    if (
      !record ||
      record.responseCiphertext !== null ||
      record.ownerTokenHash !== input.ownerTokenHash ||
      record.leaseExpiresAt === null ||
      record.leaseExpiresAt.getTime() <= input.now.getTime()
    ) {
      return false;
    }
    record.responseCiphertext = input.responseCiphertext;
    record.completedAt = input.now;
    record.ownerTokenHash = null;
    record.leaseExpiresAt = null;
    return true;
  }

  tamper(recordId: string, transform: (ciphertext: string) => string): void {
    const record = this.records.get(recordId)!;
    record.responseCiphertext = transform(record.responseCiphertext!);
  }
}

const responseSchema = z.object({ id: z.string().uuid(), token: z.string() }).strict();
const requestHash = "a".repeat(64);
const encryptionKey = new Uint8Array(32).fill(7);
const workspaceId = "00000000-0000-4000-8000-000000000001";
const baseInput = {
  workspaceId,
  actorId: "opaque-user-id",
  operation: "share.create",
  key: "share-request-1",
  requestHash,
  responseSchema,
};

function fixture() {
  const backend = new MemoryBackend();
  let now = Date.parse("2026-08-26T00:00:00.000Z");
  const store = new IdempotencyStore(backend, {
    encryptionKey,
    leaseSeconds: 60,
    clock: () => now,
  });
  return {
    backend,
    store,
    advance(seconds: number) {
      now += seconds * 1_000;
    },
  };
}

describe("IdempotencyStore", () => {
  it("atomically returns one new lease and one in-progress result", async () => {
    const { backend, store } = fixture();
    const results = await Promise.all([store.begin(baseInput), store.begin(baseInput)]);

    expect(results.map((result) => result.kind).sort()).toEqual(["in_progress", "new"]);
    const owner = results.find((result) => result.kind === "new")!;
    const persisted = backend.records.get(owner.recordId)!;
    expect(persisted.ownerTokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(persisted.ownerTokenHash).not.toBe(owner.leaseToken);
  });

  it("takes over only at the exact 60-second lease boundary", async () => {
    const { store, advance } = fixture();
    const first = await store.begin(baseInput);
    expect(first.kind).toBe("new");
    if (first.kind !== "new") throw new Error("test setup failed");

    advance(59);
    await expect(store.begin(baseInput)).resolves.toEqual({
      kind: "in_progress",
      retryAfterSeconds: 1,
    });
    advance(1);
    const takeover = await store.begin(baseInput);
    expect(takeover).toMatchObject({ kind: "new", recordId: first.recordId });
    if (takeover.kind !== "new") throw new Error("test setup failed");
    expect(takeover.leaseToken).not.toBe(first.leaseToken);

    await expect(
      store.complete(first.recordId, first.leaseToken, { id: workspaceId, token: "old" }),
    ).rejects.toThrow(/lease/i);
  });

  it("encrypts completion and schema-validates replay", async () => {
    const { backend, store } = fixture();
    const begun = await store.begin(baseInput);
    if (begun.kind !== "new") throw new Error("test setup failed");
    const response = { id: workspaceId, token: "plaintext-share-token" };

    await store.complete(begun.recordId, begun.leaseToken, response);
    const persisted = backend.records.get(begun.recordId)!;
    expect(persisted.responseCiphertext).not.toContain(response.token);
    expect(persisted.ownerTokenHash).toBeNull();
    expect(persisted.leaseExpiresAt).toBeNull();
    await expect(store.begin(baseInput)).resolves.toEqual({ kind: "replay", response });
    await expect(store.complete(begun.recordId, begun.leaseToken, response)).rejects.toThrow(
      /lease/i,
    );
  });

  it("returns conflict for the same key with a different request hash", async () => {
    const { store } = fixture();
    await store.begin(baseInput);
    await expect(store.begin({ ...baseInput, requestHash: "b".repeat(64) })).resolves.toEqual({
      kind: "conflict",
    });
  });

  it("rejects tampered ciphertext or tag without exposing persisted data", async () => {
    const { backend, store } = fixture();
    const begun = await store.begin(baseInput);
    if (begun.kind !== "new") throw new Error("test setup failed");
    await store.complete(begun.recordId, begun.leaseToken, {
      id: workspaceId,
      token: "plaintext-share-token",
    });
    const persisted = backend.records.get(begun.recordId)!;
    const rawCiphertext = persisted.responseCiphertext!;
    backend.tamper(begun.recordId, (value) => {
      const envelope = JSON.parse(value) as { tag: string };
      envelope.tag = `${envelope.tag.startsWith("A") ? "B" : "A"}${envelope.tag.slice(1)}`;
      return JSON.stringify(envelope);
    });

    let thrown: unknown;
    try {
      await store.begin(baseInput);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect(String(thrown)).toMatch(/replay/i);
    expect(String(thrown)).not.toContain(rawCiphertext);
    expect(String(thrown)).not.toContain("plaintext-share-token");
  });

  it("rejects replay data that fails the caller schema without returning raw ciphertext", async () => {
    const { backend, store } = fixture();
    const begun = await store.begin(baseInput);
    if (begun.kind !== "new") throw new Error("test setup failed");
    await store.complete(begun.recordId, begun.leaseToken, {
      id: workspaceId,
      token: "plaintext-share-token",
    });
    const rawCiphertext = backend.records.get(begun.recordId)!.responseCiphertext!;

    await expect(
      store.begin({
        ...baseInput,
        responseSchema: z.object({ unexpected: z.literal(true) }).strict(),
      }),
    ).rejects.toSatisfy((error: unknown) => {
      const message = String(error);
      return (
        /replay/i.test(message) &&
        !message.includes(rawCiphertext) &&
        !message.includes("plaintext")
      );
    });
  });
});
