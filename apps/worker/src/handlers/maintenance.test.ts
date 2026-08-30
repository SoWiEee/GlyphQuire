import { randomUUID } from "node:crypto";
import type { JobEnvelope, JobType } from "@glyphquire/api-contract/jobs";
import type { EnqueueJobInput } from "@glyphquire/queue";
import { describe, expect, it, vi } from "vitest";
import { createAccountPurgeHandler } from "./account-purge.js";
import { createAssetOrphanCleanupHandler } from "./asset-orphan-cleanup.js";
import {
  createBackupVerificationHandler,
  failClosedBackupVerifier,
} from "./backup-verification.js";
import { createExportExpiryHandler } from "./export-expiry.js";
import { createIdempotencyCleanupHandler } from "./idempotency-cleanup.js";
import { createVersionRetentionHandler } from "./version-retention.js";
import { createWorkspacePurgeHandler } from "./workspace-purge.js";
import { createWorkspaceSearchRebuildHandler } from "./workspace-search-rebuild.js";

const now = Date.parse("2026-08-26T12:00:00.000Z");
const day = 86_400_000;

function envelope<TType extends JobType>(
  type: TType,
  workspaceId: string | null,
  payload: JobEnvelope<TType>["payload"],
): JobEnvelope<TType> {
  return {
    id: randomUUID(),
    workspaceId,
    type,
    version: 1,
    attempts: 1,
    createdAt: new Date(now).toISOString(),
    payload,
  };
}

function dispatcher() {
  const enqueued: EnqueueJobInput<JobType>[] = [];
  return {
    enqueued,
    async enqueue<TType extends JobType>(input: EnqueueJobInput<TType>) {
      enqueued.push(input as EnqueueJobInput<JobType>);
      return { id: randomUUID(), duplicate: false };
    },
  };
}

describe("bounded maintenance handlers", () => {
  it("expires exports exactly at expiry and emits one deterministic continuation", async () => {
    const workspaceId = randomUUID();
    const rows = [0, 1].map((offset) => ({
      id: randomUUID(),
      workspaceId,
      createdAt: new Date(now - day + offset),
      expiresAt: new Date(now),
      status: "completed" as const,
      hasArtifact: true,
    }));
    const removed: string[] = [];
    const repository = {
      listEligible: vi.fn().mockResolvedValue(rows),
      expireIfEligible: vi.fn(async (input, deleteArtifact: () => Promise<void>) => {
        await deleteArtifact();
        removed.push(input.exportId);
        return true;
      }),
    };
    const queue = dispatcher();
    const storage = { delete: vi.fn().mockResolvedValue(undefined) };
    const handler = createExportExpiryHandler({
      repository,
      storage,
      dispatcher: queue,
      clock: () => now,
    });
    const job = envelope("export.expire", workspaceId, { workspaceId, batchSize: 2 });

    await handler(job, new AbortController().signal);

    expect(removed).toEqual(rows.map((row) => row.id));
    expect(storage.delete).toHaveBeenCalledWith(
      `workspace/${workspaceId}/exports/${rows[0]!.id}/artifact`,
    );
    expect(queue.enqueued).toHaveLength(1);
    expect(queue.enqueued[0]).toMatchObject({
      type: "export.expire",
      payload: { workspaceId, batchSize: 2, cursor: expect.any(String) },
    });
  });

  it("keeps orphan assets before grace or while live and records the deleting job at grace", async () => {
    const workspaceId = randomUUID();
    const assetId = randomUUID();
    const deletedAt = new Date(now - 30 * day);
    const row = {
      id: assetId,
      workspaceId,
      createdAt: new Date(now - 31 * day),
      deletedAt,
      hasThumbnail: true,
    };
    let live = true;
    const audit = { record: vi.fn().mockResolvedValue(undefined) };
    const repository = {
      listCandidates: vi.fn().mockResolvedValue([row]),
      deleteIfUnreferenced: vi.fn(async (_input, deleteObjects: () => Promise<void>) => {
        if (live) return false;
        await deleteObjects();
        return true;
      }),
    };
    const storage = { delete: vi.fn().mockResolvedValue(undefined) };
    const handler = createAssetOrphanCleanupHandler({
      repository,
      storage,
      dispatcher: dispatcher(),
      audit,
      graceDays: 30,
      clock: () => now,
    });
    const job = envelope("asset.orphan_cleanup", workspaceId, {
      workspaceId,
      batchSize: 10,
    });

    await handler(job, new AbortController().signal);
    expect(storage.delete).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();

    live = false;
    await handler(job, new AbortController().signal);
    expect(storage.delete).toHaveBeenCalledWith(
      `workspace/${workspaceId}/assets/${assetId}/original`,
    );
    expect(storage.delete).toHaveBeenCalledWith(
      `workspace/${workspaceId}/assets/${assetId}/thumbnail.webp`,
    );
    expect(audit.record).toHaveBeenCalledWith({
      event: "asset_orphan_deleted",
      jobId: job.id,
      workspaceId,
      assetId,
    });
  });

  it("retains every active-note version and deletes only the exact 30-day soft-delete cutoff", async () => {
    const workspaceId = randomUUID();
    const activeVersion = {
      id: randomUUID(),
      noteId: randomUUID(),
      workspaceId,
      createdAt: new Date(now - 40 * day),
      noteDeletedAt: null,
    };
    const eligibleVersion = {
      ...activeVersion,
      id: randomUUID(),
      noteId: randomUUID(),
      noteDeletedAt: new Date(now - 30 * day),
    };
    const deleted: string[] = [];
    const repository = {
      listEligible: vi.fn().mockResolvedValue([eligibleVersion]),
      deleteIfEligible: vi.fn(async (input) => {
        deleted.push(input.versionId);
        return true;
      }),
    };
    const audit = { record: vi.fn().mockResolvedValue(undefined) };
    const handler = createVersionRetentionHandler({
      repository,
      dispatcher: dispatcher(),
      audit,
      retentionDays: 30,
      clock: () => now,
    });
    const job = envelope("version.retention", workspaceId, {
      workspaceId,
      scope: "workspace",
      batchSize: 100,
    });

    await handler(job, new AbortController().signal);

    expect(repository.listEligible).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId, cutoff: new Date(now - 30 * day) }),
    );
    expect(deleted).toEqual([eligibleVersion.id]);
    expect(deleted).not.toContain(activeVersion.id);
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ event: "note_version_deleted", jobId: job.id }),
    );
  });

  it("deletes only completed idempotency records at the 30-day cutoff", async () => {
    const workspaceId = randomUUID();
    const completed = {
      id: randomUUID(),
      workspaceId,
      createdAt: new Date(now - 40 * day),
      completedAt: new Date(now - 30 * day),
    };
    const repository = {
      listEligible: vi.fn().mockResolvedValue([completed]),
      deleteIfCompletedBefore: vi.fn().mockResolvedValue(true),
    };
    const handler = createIdempotencyCleanupHandler({
      repository,
      dispatcher: dispatcher(),
      retentionDays: 30,
      clock: () => now,
    });
    const job = envelope("idempotency.cleanup", workspaceId, {
      workspaceId,
      batchSize: 100,
    });

    await handler(job, new AbortController().signal);

    expect(repository.listEligible).toHaveBeenCalledWith(
      expect.objectContaining({ cutoff: new Date(now - 30 * day) }),
    );
    expect(repository.deleteIfCompletedBefore).toHaveBeenCalledWith({
      recordId: completed.id,
      workspaceId,
      cutoff: new Date(now - 30 * day),
    });
  });

  it("surfaces backup verification failure only as JOB_FAILED", async () => {
    const backupId = randomUUID();
    const verifier = {
      verify: vi.fn().mockRejectedValue(new Error("s3://bucket?credential=secret")),
    };
    const handler = createBackupVerificationHandler({ verifier });
    const job = envelope("backup.verify", null, { workspaceId: null, backupId });

    await expect(handler(job, new AbortController().signal)).rejects.toThrow(/^JOB_FAILED$/);
    expect(verifier.verify).toHaveBeenCalledWith(backupId);
  });

  it("rejects non-canonical backup identifiers before invoking the fail-closed verifier", async () => {
    const verifier = { verify: vi.fn(failClosedBackupVerifier.verify) };
    const handler = createBackupVerificationHandler({ verifier });
    const job = envelope("backup.verify", null, {
      workspaceId: null,
      backupId: randomUUID().toUpperCase(),
    });

    await expect(handler(job, new AbortController().signal)).rejects.toThrow(/^JOB_INVALID:/);
    expect(verifier.verify).not.toHaveBeenCalled();
  });

  it("turns an orphan audit sink failure into retryable JOB_FAILED without continuing", async () => {
    const workspaceId = randomUUID();
    const assetId = randomUUID();
    const repository = {
      listCandidates: vi.fn().mockResolvedValue([
        {
          id: assetId,
          workspaceId,
          createdAt: new Date(now - 31 * day),
          deletedAt: new Date(now - 30 * day),
          hasThumbnail: false,
        },
      ]),
      deleteIfUnreferenced: vi.fn(
        async (_input, deleteObjects: () => Promise<void>, recordAudit?: () => Promise<void>) => {
          await deleteObjects();
          await recordAudit?.();
          return true;
        },
      ),
    };
    const handler = createAssetOrphanCleanupHandler({
      repository,
      storage: { delete: vi.fn().mockResolvedValue(undefined) },
      dispatcher: dispatcher(),
      audit: { record: vi.fn().mockRejectedValue(new Error("stderr secret=value")) },
      graceDays: 30,
      clock: () => now,
    });
    const job = envelope("asset.orphan_cleanup", workspaceId, {
      workspaceId,
      batchSize: 10,
    });

    await expect(handler(job, new AbortController().signal)).rejects.toThrow(/^JOB_FAILED$/);
  });

  it("rebuilds a workspace in bounded cursor batches", async () => {
    const workspaceId = randomUUID();
    const note = {
      noteId: randomUUID(),
      workspaceId,
      revision: 2,
      title: "Title",
      contentMarkdown: "# Heading\n\nBody",
      deletedAt: null,
      createdAt: new Date(now - day),
    };
    const queue = dispatcher();
    const repository = { listNotes: vi.fn().mockResolvedValue([note]) };
    const searchPort = {
      indexNoteIfCurrent: vi.fn().mockResolvedValue(undefined),
      removeNoteIfCurrent: vi.fn().mockResolvedValue(undefined),
      removeNoteIfMissing: vi.fn().mockResolvedValue(undefined),
    };
    const handler = createWorkspaceSearchRebuildHandler({
      repository,
      searchPort,
      dispatcher: queue,
    });
    const job = envelope("search.rebuild", workspaceId, {
      workspaceId,
      scope: "workspace",
      batchSize: 1,
    });

    await handler(job, new AbortController().signal);

    expect(searchPort.indexNoteIfCurrent).toHaveBeenCalledWith(
      expect.objectContaining({ noteId: note.noteId, workspaceId, revision: 2 }),
    );
    expect(queue.enqueued[0]).toMatchObject({
      type: "search.rebuild",
      payload: { workspaceId, scope: "workspace", batchSize: 1, cursor: expect.any(String) },
    });
  });
});

describe("destructive lifecycle handlers", () => {
  it("does not enter the backup gate or purge transaction before the exact grace boundary", async () => {
    const workspaceId = randomUUID();
    const deletionId = randomUUID();
    const repository = {
      inspect: vi.fn().mockResolvedValue({
        deletionId,
        targetWorkspaceId: workspaceId,
        status: "pending" as const,
        executeAfter: new Date(now + 1),
      }),
      purge: vi.fn(),
      markFailed: vi.fn(),
    };
    const backupGate = { assertReady: vi.fn() };
    const handler = createWorkspacePurgeHandler({
      repository,
      storage: { delete: vi.fn() },
      backupGate,
      clock: () => now,
    });
    const job = envelope("workspace.purge", workspaceId, { workspaceId, deletionId });

    await expect(handler(job, new AbortController().signal)).rejects.toThrow(/^JOB_FAILED$/);
    expect(backupGate.assertReady).not.toHaveBeenCalled();
    expect(repository.purge).not.toHaveBeenCalled();
  });

  it("keeps the final-workspace coordinator retryable across a crash before acknowledgement", async () => {
    const workspaceId = randomUUID();
    const deletionId = randomUUID();
    const storage = { delete: vi.fn().mockResolvedValue(undefined) };
    let attempts = 0;
    const repository = {
      inspect: vi.fn().mockResolvedValue({
        deletionId,
        targetWorkspaceId: workspaceId,
        status: "pending" as const,
        executeAfter: new Date(now),
      }),
      purge: vi.fn(async (_input, deleteObjects: (targets: unknown) => Promise<void>) => {
        await deleteObjects({
          assetIds: [randomUUID()],
          thumbnailAssetIds: [],
          importIds: [],
          importResources: [],
          exportIds: [],
        });
        attempts += 1;
        if (attempts === 1) throw new Error("connection lost before commit");
        return "completed" as const;
      }),
      markFailed: vi.fn().mockResolvedValue(undefined),
    };
    const backupGate = { assertReady: vi.fn().mockResolvedValue(undefined) };
    const handler = createWorkspacePurgeHandler({
      repository,
      storage,
      backupGate,
      clock: () => now,
    });
    const job = envelope("workspace.purge", workspaceId, { workspaceId, deletionId });

    await expect(handler(job, new AbortController().signal)).rejects.toThrow("JOB_FAILED");
    expect(repository.markFailed).toHaveBeenCalledWith(deletionId, "JOB_FAILED");
    await expect(handler({ ...job, attempts: 2 }, new AbortController().signal)).resolves.toBe(
      undefined,
    );
    expect(repository.purge).toHaveBeenCalledTimes(2);
    expect(backupGate.assertReady).toHaveBeenCalledTimes(2);
  });

  it("purges a zero-workspace account and treats a completed coordinator as idempotent", async () => {
    const accountDeletionId = randomUUID();
    const accountId = "opaque-account-id";
    const repository = {
      inspect: vi
        .fn()
        .mockResolvedValueOnce({
          accountDeletionId,
          accountId,
          status: "pending" as const,
          executeAfter: new Date(now),
          workspaceDeletionIds: [],
        })
        .mockResolvedValueOnce({
          accountDeletionId,
          accountId,
          status: "completed" as const,
          executeAfter: new Date(now),
          workspaceDeletionIds: [],
        }),
      purge: vi.fn().mockResolvedValue("completed" as const),
      markFailed: vi.fn().mockResolvedValue(undefined),
    };
    const handler = createAccountPurgeHandler({
      repository,
      backupGate: { assertReady: vi.fn().mockResolvedValue(undefined) },
      clock: () => now,
    });
    const job = envelope("account.purge", null, {
      workspaceId: null,
      accountDeletionId,
      accountId,
    });

    await handler(job, new AbortController().signal);
    await handler({ ...job, attempts: 2 }, new AbortController().signal);

    expect(repository.purge).toHaveBeenCalledTimes(1);
  });

  it("keeps an account while any coordinated workspace purge remains incomplete", async () => {
    const accountDeletionId = randomUUID();
    const accountId = "opaque-account-id";
    const repository = {
      inspect: vi.fn().mockResolvedValue({
        accountDeletionId,
        accountId,
        status: "pending" as const,
        executeAfter: new Date(now),
        workspaceDeletionIds: [randomUUID()],
        allWorkspacePurgesComplete: false,
      }),
      purge: vi.fn(),
      markFailed: vi.fn(),
    };
    const backupGate = { assertReady: vi.fn() };
    const handler = createAccountPurgeHandler({ repository, backupGate, clock: () => now });
    const job = envelope("account.purge", null, {
      workspaceId: null,
      accountDeletionId,
      accountId,
    });

    await expect(handler(job, new AbortController().signal)).rejects.toThrow(/^JOB_FAILED$/);
    expect(backupGate.assertReady).not.toHaveBeenCalled();
    expect(repository.purge).not.toHaveBeenCalled();
  });
});
