import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  API_ERROR_CODES,
  JOB_TYPES,
  MAX_JOB_PAYLOAD_BYTES,
  P0_JOB_TYPES,
  P1_JOB_TYPES,
  assetResponseSchema,
  decodeCursor,
  encodeCursor,
  exportResultSchema,
  idempotencyKeySchema,
  importJobResultSchema,
  jobEnvelopeSchema,
  jobPayloadSchemas,
  searchQuerySchema,
  searchResponseSchema,
  shareLinkResponseSchema,
  sharedNoteResponseSchema,
} from "./index.js";

const uuid = () => randomUUID();
const workspaceId = uuid();

const payloads = {
  "search.index": { workspaceId, noteId: uuid(), revision: 1, operationId: uuid() },
  "search.remove": { workspaceId, noteId: uuid(), revision: 1, operationId: uuid() },
  "search.rebuild": { workspaceId, scope: "note", noteId: uuid(), batchSize: 1 },
  "asset.cleanup": { workspaceId, assetId: uuid() },
  "asset.orphan_cleanup": { workspaceId, batchSize: 100 },
  "asset.thumbnail": { workspaceId, assetId: uuid() },
  import: { workspaceId, importId: uuid(), actorId: "opaque-auth-id", baseRevision: 1 },
  "import.cleanup": { workspaceId, scope: "one", importId: uuid() },
  export: { workspaceId, exportId: uuid() },
  "export.expire": { workspaceId, batchSize: 100 },
  "share.cleanup": { workspaceId, scope: "one", shareLinkId: uuid() },
  "version.retention": { workspaceId, scope: "note", noteId: uuid(), batchSize: 1 },
  "idempotency.cleanup": { workspaceId, batchSize: 100 },
  "backup.verify": { workspaceId: null, backupId: uuid() },
  "workspace.purge": { workspaceId, deletionId: uuid() },
  "account.purge": {
    workspaceId: null,
    accountDeletionId: uuid(),
    accountId: "opaque-account-id",
  },
} as const;

describe("Workspace services public contracts", () => {
  it("exports the exact job type and activation sets", () => {
    expect(JOB_TYPES).toEqual([
      "search.index",
      "search.remove",
      "search.rebuild",
      "asset.cleanup",
      "asset.orphan_cleanup",
      "asset.thumbnail",
      "import",
      "import.cleanup",
      "export",
      "export.expire",
      "share.cleanup",
      "version.retention",
      "idempotency.cleanup",
      "backup.verify",
      "workspace.purge",
      "account.purge",
    ]);
    expect(P0_JOB_TYPES).toEqual([
      "search.index",
      "search.remove",
      "search.rebuild",
      "asset.cleanup",
      "import",
      "import.cleanup",
      "export",
      "export.expire",
      "share.cleanup",
      "version.retention",
      "workspace.purge",
      "account.purge",
      "backup.verify",
    ]);
    expect(P1_JOB_TYPES).toEqual([
      "asset.thumbnail",
      "asset.orphan_cleanup",
      "idempotency.cleanup",
    ]);
  });

  it("accepts every exact version-1 payload and rejects extra keys", () => {
    for (const type of JOB_TYPES) {
      expect(jobPayloadSchemas[type].safeParse(payloads[type])).toMatchObject({ success: true });
      expect(
        jobPayloadSchemas[type].safeParse({ ...payloads[type], objectKey: "attacker/key" }),
      ).toMatchObject({ success: false });
    }
  });

  it("rejects prototype-polluted payloads at each public payload boundary", () => {
    const polluted = Object.assign(
      Object.create({ objectKey: "attacker/key" }) as Record<string, unknown>,
      payloads["search.index"],
    );

    expect(jobPayloadSchemas["search.index"].safeParse(polluted)).toMatchObject({
      success: false,
    });
  });

  it("enforces the exact discriminated branches and scan bounds", () => {
    expect(
      jobPayloadSchemas["search.rebuild"].safeParse({
        workspaceId,
        scope: "workspace",
        batchSize: 1,
      }).success,
    ).toBe(true);
    expect(
      jobPayloadSchemas["search.rebuild"].safeParse({
        workspaceId,
        scope: "workspace",
        noteId: uuid(),
        batchSize: 1,
      }).success,
    ).toBe(false);
    expect(
      jobPayloadSchemas["search.rebuild"].safeParse({
        workspaceId,
        scope: "note",
        noteId: uuid(),
        batchSize: 2,
      }).success,
    ).toBe(false);
    for (const type of ["asset.orphan_cleanup", "export.expire", "idempotency.cleanup"] as const) {
      expect(jobPayloadSchemas[type].safeParse({ workspaceId, batchSize: 0 }).success).toBe(false);
      expect(jobPayloadSchemas[type].safeParse({ workspaceId, batchSize: 101 }).success).toBe(
        false,
      );
    }
  });

  it("rejects non-UUID resources and invalid positive counters", () => {
    expect(
      jobPayloadSchemas["search.index"].safeParse({
        workspaceId: "not-a-uuid",
        noteId: uuid(),
        revision: 1,
        operationId: uuid(),
      }).success,
    ).toBe(false);
    expect(
      jobPayloadSchemas["search.index"].safeParse({
        ...payloads["search.index"],
        revision: 0,
      }).success,
    ).toBe(false);
  });

  it("rejects an envelope with unknown type, extra keys, oversized payload, or pollution", () => {
    expect(jobEnvelopeSchema.safeParse({ type: "shell.exec" })).toMatchObject({ success: false });
    expect(
      jobEnvelopeSchema.safeParse({
        id: uuid(),
        workspaceId,
        type: "search.index",
        version: 1,
        attempts: 1,
        createdAt: new Date().toISOString(),
        payload: payloads["search.index"],
        extra: 1,
      }),
    ).toMatchObject({ success: false });

    const polluted = Object.assign(
      Object.create({ objectKey: "attacker/key" }),
      payloads["search.index"],
    );
    expect(
      jobEnvelopeSchema.safeParse({
        id: uuid(),
        workspaceId,
        type: "search.index",
        version: 1,
        attempts: 1,
        createdAt: new Date().toISOString(),
        payload: polluted,
      }),
    ).toMatchObject({ success: false });

    expect(
      jobEnvelopeSchema.safeParse({
        id: uuid(),
        workspaceId,
        type: "import",
        version: 1,
        attempts: 1,
        createdAt: new Date().toISOString(),
        payload: {
          ...payloads.import,
          actorId: "x".repeat(MAX_JOB_PAYLOAD_BYTES + 1),
        },
      }),
    ).toMatchObject({ success: false });
  });

  it("requires a positive claimed attempt and matching workspace routing hint", () => {
    const valid = {
      id: uuid(),
      workspaceId,
      type: "asset.cleanup",
      version: 1,
      attempts: 1,
      createdAt: new Date().toISOString(),
      payload: payloads["asset.cleanup"],
    };
    expect(jobEnvelopeSchema.safeParse(valid).success).toBe(true);
    expect(jobEnvelopeSchema.safeParse({ ...valid, attempts: 0 }).success).toBe(false);
    expect(jobEnvelopeSchema.safeParse({ ...valid, workspaceId: uuid() }).success).toBe(false);
    expect(jobEnvelopeSchema.safeParse({ ...valid, version: 2 }).success).toBe(false);

    expect(
      jobEnvelopeSchema.safeParse({
        ...valid,
        workspaceId,
        type: "backup.verify",
        payload: payloads["backup.verify"],
      }).success,
    ).toBe(false);
  });

  it("round-trips only canonical bounded cursor encodings", () => {
    const value = { createdAt: "2026-08-26T12:34:56.000Z", id: uuid() };
    const encoded = encodeCursor(value);
    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeCursor(encoded)).toEqual(value);
    expect(() => decodeCursor(`${encoded}=`)).toThrow(/cursor/i);
    expect(() => decodeCursor("eyJpZCI6Im5vdC1jYW5vbmljYWwifQ")).toThrow(/cursor/i);
  });

  it("bounds idempotency keys by UTF-8 length and a safe visible charset", () => {
    expect(idempotencyKeySchema.safeParse("upload_01J.valid-key~1").success).toBe(true);
    expect(idempotencyKeySchema.safeParse("").success).toBe(false);
    expect(idempotencyKeySchema.safeParse("contains whitespace").success).toBe(false);
    expect(idempotencyKeySchema.safeParse("x".repeat(201)).success).toBe(false);
    expect(idempotencyKeySchema.safeParse("界").success).toBe(false);
  });

  it("exports strict asset/search/transfer/share schemas", () => {
    const now = new Date().toISOString();
    expect(
      assetResponseSchema.safeParse({
        id: uuid(),
        workspaceId,
        originalName: "diagram.png",
        mimeType: "image/png",
        size: 123,
        sha256: "a".repeat(64),
        createdAt: now,
        deletedAt: null,
        thumbnailStatus: "metadata_only",
      }).success,
    ).toBe(true);
    expect(
      assetResponseSchema.safeParse({
        id: uuid(),
        workspaceId,
        originalName: "diagram.png",
        mimeType: "image/png",
        size: 123,
        sha256: "a".repeat(64),
        createdAt: now,
        deletedAt: null,
        thumbnailStatus: "failed",
        thumbnailUrl: "https://example.test/forbidden",
      }).success,
    ).toBe(false);

    const readyThumbnail = {
      id: uuid(),
      workspaceId,
      originalName: "diagram.png",
      mimeType: "image/png",
      size: 123,
      sha256: "a".repeat(64),
      createdAt: now,
      deletedAt: null,
      thumbnailStatus: "ready",
      thumbnailMimeType: "image/webp",
      thumbnailWidth: 320,
      thumbnailHeight: 200,
      thumbnailBytes: 12_345,
    };
    expect(assetResponseSchema.safeParse(readyThumbnail).success).toBe(true);
    expect(
      assetResponseSchema.safeParse({
        ...readyThumbnail,
        thumbnailUrl: "https://example.test/authorized-thumbnail",
      }).success,
    ).toBe(true);
    expect(
      assetResponseSchema.safeParse({
        ...readyThumbnail,
        thumbnailMimeType: undefined,
      }).success,
    ).toBe(false);

    expect(
      searchQuerySchema.safeParse({ workspaceId, q: "GlyphQuire", pageSize: 100 }).success,
    ).toBe(true);
    expect(searchResponseSchema.safeParse({ items: [], nextCursor: null }).success).toBe(true);
    expect(
      importJobResultSchema.safeParse({
        id: uuid(),
        workspaceId,
        status: "pending",
        progress: { completedItems: 0, totalItems: 0, processedBytes: 0, totalBytes: 0 },
      }).success,
    ).toBe(true);
    expect(
      exportResultSchema.safeParse({
        id: uuid(),
        workspaceId,
        status: "pending",
        format: "markdown",
        scope: { type: "workspace", workspaceId },
        createdAt: now,
        expiresAt: now,
      }).success,
    ).toBe(true);
    expect(
      shareLinkResponseSchema.safeParse({
        id: uuid(),
        workspaceId,
        noteId: uuid(),
        token: "x".repeat(43),
        url: "https://example.test/api/v1/shared/token",
        expiresAt: null,
        createdAt: now,
      }).success,
    ).toBe(true);
    expect(
      sharedNoteResponseSchema.safeParse({
        noteId: uuid(),
        title: "Read only",
        contentMarkdown: "# Read only",
        schemaVersion: 1,
        updatedAt: now,
      }).success,
    ).toBe(true);
  });

  it("exports every stable workspace-services error code", () => {
    expect(API_ERROR_CODES).toEqual(
      expect.arrayContaining([
        "ASSET_INVALID",
        "SEARCH_UNAVAILABLE",
        "IMPORT_INVALID",
        "EXPORT_FAILED",
        "SHARE_NOT_FOUND",
        "JOB_INVALID",
        "JOB_FAILED",
      ]),
    );
  });
});
