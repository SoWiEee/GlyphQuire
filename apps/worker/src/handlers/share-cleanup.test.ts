import { randomUUID } from "node:crypto";
import { decodeCursor } from "@glyphquire/api-contract/jobs";
import type { EnqueueJobInput } from "@glyphquire/queue";
import { describe, expect, it } from "vitest";
import {
  createShareCleanupHandler,
  type ShareCleanupAuditEvent,
  type ShareCleanupRepository,
  type ShareCleanupRow,
} from "./share-cleanup.js";

const NOW = Date.parse("2026-08-29T12:00:00.000Z");
const GRACE_SECONDS = 3_600;
const CUTOFF = NOW - GRACE_SECONDS * 1_000;

class MemoryRepository implements ShareCleanupRepository {
  readonly rows = new Map<string, ShareCleanupRow>();
  beforeDelete: ((row: ShareCleanupRow) => void) | undefined;
  deleteFailure: Error | undefined;

  async load(shareLinkId: string): Promise<ShareCleanupRow | undefined> {
    const row = this.rows.get(shareLinkId);
    return row ? { ...row } : undefined;
  }

  async listEligible(input: {
    workspaceId: string;
    cutoff: Date;
    cursor?: { createdAt: string; id: string };
    limit: number;
  }): Promise<ShareCleanupRow[]> {
    return [...this.rows.values()]
      .filter((row) => row.workspaceId === input.workspaceId && eligible(row, input.cutoff))
      .filter((row) => {
        if (!input.cursor) return true;
        const created = row.createdAt.toISOString();
        return (
          created > input.cursor.createdAt ||
          (created === input.cursor.createdAt && row.id > input.cursor.id)
        );
      })
      .sort(
        (left, right) =>
          left.createdAt.getTime() - right.createdAt.getTime() || left.id.localeCompare(right.id),
      )
      .slice(0, input.limit)
      .map((row) => ({ ...row }));
  }

  async deleteIfEligible(input: {
    shareLinkId: string;
    workspaceId: string;
    cutoff: Date;
    beforeDelete?: (reason: "expired" | "revoked") => Promise<void>;
    afterDelete?: (reason: "expired" | "revoked") => Promise<void>;
  }): Promise<"expired" | "revoked" | null> {
    const row = this.rows.get(input.shareLinkId);
    if (!row || row.workspaceId !== input.workspaceId) return null;
    this.beforeDelete?.(row);
    const current = this.rows.get(input.shareLinkId);
    if (!current || current.workspaceId !== input.workspaceId || !eligible(current, input.cutoff)) {
      return null;
    }
    const reason = current.revokedAt === null ? "expired" : "revoked";
    await input.beforeDelete?.(reason);
    if (this.deleteFailure) throw this.deleteFailure;
    const previous = { ...current };
    this.rows.delete(current.id);
    try {
      await input.afterDelete?.(reason);
    } catch (error) {
      this.rows.set(previous.id, previous);
      throw error;
    }
    return reason;
  }
}

function eligible(row: ShareCleanupRow, cutoff: Date): boolean {
  const terminal = row.revokedAt ?? row.expiresAt;
  return terminal !== null && terminal.getTime() <= cutoff.getTime();
}

class CaptureDispatcher {
  readonly enqueued: EnqueueJobInput<"share.cleanup">[] = [];

  async enqueue(input: EnqueueJobInput<"share.cleanup">) {
    this.enqueued.push(input);
    return { id: randomUUID(), duplicate: false };
  }
}

function row(input: Partial<ShareCleanupRow> = {}): ShareCleanupRow {
  return {
    id: randomUUID(),
    workspaceId: randomUUID(),
    createdAt: new Date(NOW - 10_000),
    expiresAt: new Date(CUTOFF),
    revokedAt: null,
    ...input,
  };
}

function job(
  workspaceId: string,
  payload:
    | { scope: "one"; shareLinkId: string }
    | { scope: "expired"; batchSize: number; cursor?: string },
) {
  return {
    id: randomUUID(),
    workspaceId,
    type: "share.cleanup" as const,
    version: 1 as const,
    attempts: 1,
    createdAt: new Date(NOW).toISOString(),
    payload: { workspaceId, ...payload },
  };
}

function handlerFixture(repository = new MemoryRepository()) {
  const dispatcher = new CaptureDispatcher();
  const audit: ShareCleanupAuditEvent[] = [];
  const handler = createShareCleanupHandler({
    repository,
    dispatcher,
    graceSeconds: GRACE_SECONDS,
    clock: () => NOW,
    audit: { record: async (event) => void audit.push(event) },
  });
  return { repository, dispatcher, audit, handler };
}

describe("share.cleanup handler", () => {
  it("refuses to activate without an audit sink", () => {
    expect(() =>
      createShareCleanupHandler({
        repository: new MemoryRepository(),
        dispatcher: new CaptureDispatcher(),
        audit: undefined as never,
      }),
    ).toThrow(/^JOB_FAILED: share cleanup audit is required$/u);
  });

  it("preserves active, just-expired, and pre-grace links, then deletes at and after grace", async () => {
    const workspaceId = randomUUID();
    const cases = [
      { label: "before expiry", expiresAt: NOW + 1, deleted: false },
      { label: "at expiry", expiresAt: NOW, deleted: false },
      { label: "after expiry before grace", expiresAt: CUTOFF + 1, deleted: false },
      { label: "at grace", expiresAt: CUTOFF, deleted: true },
      { label: "after grace", expiresAt: CUTOFF - 1, deleted: true },
    ];

    for (const testCase of cases) {
      const { repository, handler } = handlerFixture();
      const candidate = row({
        workspaceId,
        expiresAt: new Date(testCase.expiresAt),
      });
      repository.rows.set(candidate.id, candidate);
      await handler(
        job(workspaceId, { scope: "one", shareLinkId: candidate.id }),
        new AbortController().signal,
      );
      expect(repository.rows.has(candidate.id), testCase.label).toBe(!testCase.deleted);
    }
  });

  it("uses revoked_at as the grace source and does not let an older expiry bypass revocation grace", async () => {
    const { repository, handler } = handlerFixture();
    const workspaceId = randomUUID();
    const recentlyRevoked = row({
      workspaceId,
      expiresAt: new Date(CUTOFF - 60_000),
      revokedAt: new Date(CUTOFF + 1),
    });
    const revocationAtGrace = row({
      workspaceId,
      expiresAt: null,
      revokedAt: new Date(CUTOFF),
    });
    repository.rows.set(recentlyRevoked.id, recentlyRevoked);
    repository.rows.set(revocationAtGrace.id, revocationAtGrace);

    await handler(
      job(workspaceId, { scope: "one", shareLinkId: recentlyRevoked.id }),
      new AbortController().signal,
    );
    await handler(
      job(workspaceId, { scope: "one", shareLinkId: revocationAtGrace.id }),
      new AbortController().signal,
    );

    expect(repository.rows.has(recentlyRevoked.id)).toBe(true);
    expect(repository.rows.has(revocationAtGrace.id)).toBe(false);
  });

  it("is idempotent and records a stable job id without token material", async () => {
    const { repository, handler, audit } = handlerFixture();
    const workspaceId = randomUUID();
    const candidate = row({ workspaceId, revokedAt: new Date(CUTOFF), expiresAt: null });
    repository.rows.set(candidate.id, candidate);
    const cleanupJob = job(workspaceId, { scope: "one", shareLinkId: candidate.id });

    await handler(cleanupJob, new AbortController().signal);
    await handler({ ...cleanupJob, attempts: 2 }, new AbortController().signal);

    expect(repository.rows.has(candidate.id)).toBe(false);
    expect(audit).toEqual([
      {
        event: "share_link_delete_intent",
        jobId: cleanupJob.id,
        workspaceId,
        shareLinkId: candidate.id,
        reason: "revoked",
      },
      {
        event: "share_link_deleted",
        jobId: cleanupJob.id,
        workspaceId,
        shareLinkId: candidate.id,
        reason: "revoked",
      },
    ]);
    expect(JSON.stringify(audit)).not.toMatch(/token|hash/iu);
  });

  it("keeps an eligible link retryable when the audit sink fails before deletion", async () => {
    const repository = new MemoryRepository();
    const dispatcher = new CaptureDispatcher();
    const audit: ShareCleanupAuditEvent[] = [];
    let auditAttempts = 0;
    const handler = createShareCleanupHandler({
      repository,
      dispatcher,
      graceSeconds: GRACE_SECONDS,
      clock: () => NOW,
      audit: {
        async record(event) {
          auditAttempts += 1;
          if (auditAttempts === 1) throw new Error("token=must-not-escape");
          audit.push(event);
        },
      },
    });
    const workspaceId = randomUUID();
    const candidate = row({ workspaceId, expiresAt: new Date(CUTOFF) });
    repository.rows.set(candidate.id, candidate);
    const cleanupJob = job(workspaceId, { scope: "one", shareLinkId: candidate.id });

    await expect(handler(cleanupJob, new AbortController().signal)).rejects.toThrow(
      /^JOB_FAILED$/u,
    );
    expect(repository.rows.has(candidate.id)).toBe(true);
    expect(audit).toEqual([]);

    await expect(
      handler({ ...cleanupJob, attempts: 2 }, new AbortController().signal),
    ).resolves.toBeUndefined();
    expect(repository.rows.has(candidate.id)).toBe(false);
    expect(auditAttempts).toBe(3);
    expect(audit).toEqual([
      {
        event: "share_link_delete_intent",
        jobId: cleanupJob.id,
        workspaceId,
        shareLinkId: candidate.id,
        reason: "expired",
      },
      {
        event: "share_link_deleted",
        jobId: cleanupJob.id,
        workspaceId,
        shareLinkId: candidate.id,
        reason: "expired",
      },
    ]);
    expect(JSON.stringify(audit)).not.toMatch(/token|hash/iu);
  });

  it("records only retryable intent when deletion fails after auditing intent", async () => {
    const { repository, handler, audit } = handlerFixture();
    const workspaceId = randomUUID();
    const candidate = row({ workspaceId, expiresAt: new Date(CUTOFF) });
    repository.rows.set(candidate.id, candidate);
    repository.deleteFailure = new Error("token=must-not-escape");
    const cleanupJob = job(workspaceId, { scope: "one", shareLinkId: candidate.id });

    await expect(handler(cleanupJob, new AbortController().signal)).rejects.toThrow(
      /^JOB_FAILED$/u,
    );
    expect(repository.rows.has(candidate.id)).toBe(true);
    expect(audit).toEqual([
      {
        event: "share_link_delete_intent",
        jobId: cleanupJob.id,
        workspaceId,
        shareLinkId: candidate.id,
        reason: "expired",
      },
    ]);

    repository.deleteFailure = undefined;
    await expect(
      handler({ ...cleanupJob, attempts: 2 }, new AbortController().signal),
    ).resolves.toBeUndefined();
    expect(repository.rows.has(candidate.id)).toBe(false);
    expect(audit).toEqual([
      {
        event: "share_link_delete_intent",
        jobId: cleanupJob.id,
        workspaceId,
        shareLinkId: candidate.id,
        reason: "expired",
      },
      {
        event: "share_link_delete_intent",
        jobId: cleanupJob.id,
        workspaceId,
        shareLinkId: candidate.id,
        reason: "expired",
      },
      {
        event: "share_link_deleted",
        jobId: cleanupJob.id,
        workspaceId,
        shareLinkId: candidate.id,
        reason: "expired",
      },
    ]);
    expect(JSON.stringify(audit)).not.toMatch(/token|hash/iu);
  });

  it("rolls back deletion when the post-delete audit fails", async () => {
    const repository = new MemoryRepository();
    const dispatcher = new CaptureDispatcher();
    const audit: ShareCleanupAuditEvent[] = [];
    let auditAttempts = 0;
    const handler = createShareCleanupHandler({
      repository,
      dispatcher,
      graceSeconds: GRACE_SECONDS,
      clock: () => NOW,
      audit: {
        async record(event) {
          auditAttempts += 1;
          if (auditAttempts === 2) throw new Error("audit sink unavailable");
          audit.push(event);
        },
      },
    });
    const workspaceId = randomUUID();
    const candidate = row({ workspaceId, expiresAt: new Date(CUTOFF) });
    repository.rows.set(candidate.id, candidate);
    const cleanupJob = job(workspaceId, { scope: "one", shareLinkId: candidate.id });

    await expect(handler(cleanupJob, new AbortController().signal)).rejects.toThrow(
      /^JOB_FAILED$/u,
    );
    expect(repository.rows.has(candidate.id)).toBe(true);
    expect(audit).toEqual([
      {
        event: "share_link_delete_intent",
        jobId: cleanupJob.id,
        workspaceId,
        shareLinkId: candidate.id,
        reason: "expired",
      },
    ]);

    await expect(
      handler({ ...cleanupJob, attempts: 2 }, new AbortController().signal),
    ).resolves.toBeUndefined();
    expect(repository.rows.has(candidate.id)).toBe(false);
    expect(audit).toEqual([
      {
        event: "share_link_delete_intent",
        jobId: cleanupJob.id,
        workspaceId,
        shareLinkId: candidate.id,
        reason: "expired",
      },
      {
        event: "share_link_delete_intent",
        jobId: cleanupJob.id,
        workspaceId,
        shareLinkId: candidate.id,
        reason: "expired",
      },
      {
        event: "share_link_deleted",
        jobId: cleanupJob.id,
        workspaceId,
        shareLinkId: candidate.id,
        reason: "expired",
      },
    ]);
  });

  it("rejects a targeted cross-workspace source mismatch", async () => {
    const { repository, handler } = handlerFixture();
    const candidate = row({ expiresAt: new Date(CUTOFF) });
    repository.rows.set(candidate.id, candidate);

    await expect(
      handler(
        job(randomUUID(), { scope: "one", shareLinkId: candidate.id }),
        new AbortController().signal,
      ),
    ).rejects.toThrow(/JOB_INVALID.*source mismatch/iu);
    expect(repository.rows.has(candidate.id)).toBe(true);
  });

  it("atomically rechecks current eligibility after the pre-delete audit", async () => {
    const { repository, handler, audit } = handlerFixture();
    const workspaceId = randomUUID();
    const candidate = row({ workspaceId, expiresAt: new Date(CUTOFF) });
    repository.rows.set(candidate.id, candidate);
    repository.beforeDelete = (loaded) => {
      repository.rows.set(loaded.id, { ...loaded, expiresAt: new Date(NOW + 60_000) });
    };
    const cleanupJob = job(workspaceId, { scope: "expired", batchSize: 1 });

    await handler(cleanupJob, new AbortController().signal);

    expect(repository.rows.has(candidate.id)).toBe(true);
    expect(audit).toHaveLength(0);
  });

  it("scans deterministically within the batch bound and emits one typed continuation", async () => {
    const { repository, handler, dispatcher } = handlerFixture();
    const workspaceId = randomUUID();
    const first = row({
      id: "00000000-0000-4000-8000-000000000001",
      workspaceId,
      createdAt: new Date(NOW - 3_000),
    });
    const second = row({
      id: "00000000-0000-4000-8000-000000000002",
      workspaceId,
      createdAt: new Date(NOW - 2_000),
    });
    const third = row({
      id: "00000000-0000-4000-8000-000000000003",
      workspaceId,
      createdAt: new Date(NOW - 1_000),
    });
    for (const candidate of [first, second, third]) repository.rows.set(candidate.id, candidate);

    await handler(
      job(workspaceId, { scope: "expired", batchSize: 2 }),
      new AbortController().signal,
    );

    expect([...repository.rows.keys()]).toEqual([third.id]);
    expect(dispatcher.enqueued).toHaveLength(1);
    const continuation = dispatcher.enqueued[0]!;
    expect(continuation).toMatchObject({
      workspaceId,
      type: "share.cleanup",
      payload: { workspaceId, scope: "expired", batchSize: 2 },
    });
    const continuationPayload = continuation.payload as {
      cursor: string;
    };
    expect(decodeCursor(continuationPayload.cursor)).toEqual({
      createdAt: second.createdAt.toISOString(),
      id: second.id,
    });

    await handler(
      job(workspaceId, {
        scope: "expired",
        batchSize: 2,
        cursor: continuationPayload.cursor,
      }),
      new AbortController().signal,
    );
    expect(repository.rows.size).toBe(0);
  });

  it("rejects out-of-contract batches/cursors and honors cancellation", async () => {
    const { handler } = handlerFixture();
    const workspaceId = randomUUID();
    await expect(
      handler(
        job(workspaceId, { scope: "expired", batchSize: 101 }) as never,
        new AbortController().signal,
      ),
    ).rejects.toThrow(/JOB_INVALID/iu);
    await expect(
      handler(
        job(workspaceId, { scope: "expired", batchSize: 1, cursor: "not-a-cursor" }),
        new AbortController().signal,
      ),
    ).rejects.toThrow(/JOB_INVALID/iu);

    const controller = new AbortController();
    controller.abort();
    await expect(
      handler(job(workspaceId, { scope: "expired", batchSize: 1 }), controller.signal),
    ).rejects.toThrow(/JOB_FAILED/iu);
  });
});
