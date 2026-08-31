import { readFile } from "node:fs/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "../../apps/api/node_modules/hono/dist/index.js";
import { describe, expect, it, vi } from "vitest";
import {
  RELEASE_ALERT_POLICY,
  ReleaseAlertEvaluator,
  createReleaseAlertEvaluator,
  scheduleReleaseAlertProbes,
  sanitizeReleaseAlertInput,
  type ReleaseAlertEvent,
} from "../../infra/observability/release-alert-runtime.js";
import { receiveReleaseAlertEvent } from "../../infra/observability/release-alert-receiver.js";
import { createHealthRoutes, createReadinessState } from "../../apps/api/src/routes/health.js";
import {
  createErrorHandler,
  type SecurityLogEntry,
} from "../../apps/api/src/middleware/error-handler.js";
import { createSecurityHeadersMiddleware } from "../../apps/api/src/middleware/security.js";
import {
  createMaintenanceScheduler,
  type MaintenanceSchedulerRepository,
} from "../../apps/worker/src/scheduler.js";

const baseTime = Date.parse("2026-08-31T00:00:00.000Z");
const requestId = "11111111-1111-4111-8111-111111111111";
const jobId = "22222222-2222-4222-8222-222222222222";

function eventNames(events: readonly ReleaseAlertEvent[]) {
  return events.map((event) => `${event.phase}:${event.alert}`);
}

describe("Release alert evaluator", () => {
  it("uses a 30-second probe cadence and five-second timeout", () => {
    expect(RELEASE_ALERT_POLICY).toMatchObject({
      probeIntervalMs: 30_000,
      probeTimeoutMs: 5_000,
      rollingWindowMs: 5 * 60_000,
      consecutiveFailures: 3,
      failureRatio: 0.5,
      recoverySuccesses: 3,
      deliveryDeadlineMs: 5 * 60_000,
    });
    expect(new ReleaseAlertEvaluator().policy).toEqual(RELEASE_ALERT_POLICY);
  });

  it("runs the configured probe exactly every 30 seconds and times out at five seconds", async () => {
    vi.useFakeTimers();
    try {
      const evaluator = createReleaseAlertEvaluator({ clock: () => baseTime });
      let probeCalls = 0;
      const stop = scheduleReleaseAlertProbes(evaluator, () => {
        probeCalls += 1;
        return true;
      });
      await vi.advanceTimersByTimeAsync(29_999);
      expect(probeCalls).toBe(0);
      await vi.advanceTimersByTimeAsync(1);
      expect(probeCalls).toBe(1);
      stop();

      const pending = evaluator.runProbe(() => new Promise<boolean>(() => undefined), {
        observedAt: baseTime,
        requestId,
      });
      await vi.advanceTimersByTimeAsync(4_999);
      expect(probeCalls).toBe(1);
      await vi.advanceTimersByTimeAsync(1);
      await expect(pending).resolves.toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("fires after three consecutive probe failures and recovers after three successes", () => {
    let now = baseTime;
    const evaluator = createReleaseAlertEvaluator({ clock: () => now });

    expect(evaluator.observeProbe({ ok: false, observedAt: now, requestId })).toEqual([]);
    now += 30_000;
    expect(evaluator.observeProbe({ ok: false, observedAt: now, requestId })).toEqual([]);
    now += 30_000;
    const firing = evaluator.observeProbe({ ok: false, observedAt: now, requestId });
    expect(eventNames(firing)).toEqual(["firing:probe_failure"]);
    expect(firing[0]).toMatchObject({ requestId, correlationId: requestId, severity: "critical" });

    now += 30_000;
    expect(evaluator.observeProbe({ ok: true, observedAt: now, requestId })).toEqual([]);
    now += 30_000;
    expect(evaluator.observeProbe({ ok: true, observedAt: now, requestId })).toEqual([]);
    now += 30_000;
    const recovery = evaluator.observeProbe({ ok: true, observedAt: now, requestId });
    expect(eventNames(recovery)).toEqual(["resolved:probe_failure"]);
  });

  it("keeps an incident correlation id across generated probe retries", () => {
    let now = baseTime;
    const ids = [
      "33333333-3333-4333-8333-333333333333",
      "44444444-4444-4444-8444-444444444444",
      "55555555-5555-4555-8555-555555555555",
      "66666666-6666-4666-8666-666666666666",
      "77777777-7777-4777-8777-777777777777",
      "88888888-8888-4888-8888-888888888888",
    ];
    const evaluator = createReleaseAlertEvaluator({
      clock: () => now,
      requestIdFactory: () => ids.shift() ?? requestId,
    });
    evaluator.observeProbe({ ok: false, observedAt: now });
    now += 30_000;
    evaluator.observeProbe({ ok: false, observedAt: now });
    now += 30_000;
    const firing = evaluator.observeProbe({ ok: false, observedAt: now });
    now += 30_000;
    evaluator.observeProbe({ ok: true, observedAt: now });
    now += 30_000;
    evaluator.observeProbe({ ok: true, observedAt: now });
    now += 30_000;
    const recovery = evaluator.observeProbe({ ok: true, observedAt: now });

    expect(firing[0]?.correlationId).toBe(recovery[0]?.correlationId);
  });

  it("fires for a 50-percent failure ratio in a rolling five-minute window", () => {
    let now = baseTime;
    const evaluator = createReleaseAlertEvaluator({ clock: () => now });
    evaluator.observeProbe({ ok: true, observedAt: now, requestId });
    now += 30_000;
    evaluator.observeProbe({ ok: false, observedAt: now, requestId });
    now += 30_000;
    evaluator.observeProbe({ ok: true, observedAt: now, requestId });
    now += 30_000;
    const events = evaluator.observeProbe({ ok: false, observedAt: now, requestId });

    expect(eventNames(events)).toEqual(["firing:probe_failure"]);
    expect(events[0]?.observedValue).toBe(0.5);
  });

  it.each([
    ["backup_failure", undefined],
    ["dead_letter", jobId],
    ["oldest_queue_age", undefined],
  ] as const)("fires %s immediately", (alert, relatedJobId) => {
    const evaluator = createReleaseAlertEvaluator({ clock: () => baseTime });
    const events = evaluator.observeCondition({
      alert,
      healthy: false,
      observedAt: baseTime,
      requestId,
      jobId: relatedJobId,
    });

    expect(eventNames(events)).toEqual([`firing:${alert}`]);
    expect(events[0]).toMatchObject({
      requestId,
      correlationId: requestId,
      ...(relatedJobId ? { jobId: relatedJobId } : {}),
    });
  });

  it("emits warning at 80 percent and critical at 90 percent database and disk use", () => {
    const evaluator = createReleaseAlertEvaluator({ clock: () => baseTime });
    expect(
      evaluator.observeCapacity({ resource: "database", utilization: 0.8, observedAt: baseTime }),
    ).toMatchObject([{ phase: "firing", alert: "database_capacity", severity: "warning" }]);
    expect(
      evaluator.observeCapacity({ resource: "database", utilization: 0.9, observedAt: baseTime }),
    ).toMatchObject([{ phase: "firing", alert: "database_capacity", severity: "critical" }]);
    expect(
      evaluator.observeCapacity({ resource: "disk", utilization: 0.8, observedAt: baseTime }),
    ).toMatchObject([{ phase: "firing", alert: "disk_capacity", severity: "warning" }]);
    expect(
      evaluator.observeCapacity({ resource: "disk", utilization: 0.9, observedAt: baseTime }),
    ).toMatchObject([{ phase: "firing", alert: "disk_capacity", severity: "critical" }]);
  });

  it("sanitizes secrets, URLs, bodies, and provider responses before transport", () => {
    const event = sanitizeReleaseAlertInput({
      alert: "dead_letter",
      phase: "firing",
      severity: "critical",
      requestId,
      correlationId: requestId,
      jobId,
      token: "TOKEN_SENTINEL",
      password: "PASSWORD_SENTINEL",
      url: "https://operator:secret@example.test/hook",
      body: "# PRIVATE MARKDOWN_SENTINEL",
      providerResponse: "PROVIDER_SENTINEL",
    });

    const serialized = JSON.stringify(event);
    expect(event).toMatchObject({
      alert: "dead_letter",
      requestId,
      correlationId: requestId,
      jobId,
    });
    expect(serialized).not.toMatch(
      /TOKEN_SENTINEL|PASSWORD_SENTINEL|PRIVATE MARKDOWN|PROVIDER_SENTINEL|https:/u,
    );
  });
});

describe("Release API operational seams", () => {
  it("removes new traffic on readiness failure and exposes bounded metrics", async () => {
    let restartActions = 0;
    const readiness = createReadinessState({ onHealthFailure: () => (restartActions += 1) });
    const app = new Hono().route("/api", createHealthRoutes(readiness));

    expect((await app.request("http://localhost/api/ready")).status).toBe(200);
    readiness.setReady(false);
    const response = await app.request("http://localhost/api/ready");
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ status: "not_ready", acceptTraffic: false });
    expect((await app.request("http://localhost/api/metrics")).status).toBe(200);
    expect(await (await app.request("http://localhost/api/metrics")).text()).toContain(
      "glyphquire_readiness",
    );
    readiness.setHealthy(false);
    expect(restartActions).toBe(1);
    expect(readiness.restartRequested).toBe(true);
  });

  it("keeps operational errors correlated and scrubbed", async () => {
    const entries: SecurityLogEntry[] = [];
    const app = new Hono()
      .use("*", createSecurityHeadersMiddleware())
      .onError(
        createErrorHandler({
          error(entry) {
            entries.push(entry);
          },
        }),
      )
      .get("/error", () => {
        throw new Error(
          "postgres://user:PASSWORD_SENTINEL@db.internal/private?token=TOKEN_SENTINEL",
        );
      });

    const response = await app.request(`http://localhost/error`, {
      headers: { "x-request-id": requestId },
    });
    const serialized = JSON.stringify(entries);
    expect(response.status).toBe(503);
    expect(entries[0]).toMatchObject({ requestId, correlationId: requestId });
    expect(serialized).not.toMatch(/PASSWORD_SENTINEL|TOKEN_SENTINEL|db\.internal|postgres:/u);
  });
});

describe("Release evidence and worker alert wiring", () => {
  it("delivers firing and recovery events within five minutes without echoing payloads", async () => {
    const directory = await mkdtemp(join(tmpdir(), "glyphquire-release-alert-"));
    const capturePath = join(directory, "alert-evidence.json");
    let now = baseTime;
    try {
      const firing = await receiveReleaseAlertEvent(
        {
          phase: "firing",
          alert: "backup_failure",
          severity: "critical",
          detectedAt: baseTime,
          emittedAt: baseTime,
          requestId,
          correlationId: requestId,
          body: "PRIVATE_MARKDOWN_SENTINEL",
          token: "TOKEN_SENTINEL",
        },
        { capturePath, clock: () => now },
      );
      expect(firing.statusCode).toBe(202);
      now += 3 * 60_000;
      const recovery = await receiveReleaseAlertEvent(
        {
          phase: "resolved",
          alert: "backup_failure",
          severity: "critical",
          detectedAt: baseTime,
          emittedAt: now,
          requestId,
          correlationId: requestId,
        },
        { capturePath, clock: () => now },
      );
      expect(recovery.statusCode).toBe(202);
      const evidence = JSON.parse(await readFile(capturePath, "utf8")) as {
        status: string;
        events: Array<{
          phase: string;
          deliveredAt: string;
          detectedAt: string;
          deliveryStatus: number;
        }>;
      };
      expect(evidence.status).toBe("passed");
      expect(evidence.events).toHaveLength(2);
      expect(evidence.events.map((event) => event.phase)).toEqual(["firing", "resolved"]);
      expect(evidence.events.every((event) => event.deliveryStatus === 202)).toBe(true);
      expect(
        Date.parse(evidence.events[1]!.deliveredAt) - Date.parse(evidence.events[1]!.detectedAt),
      ).toBeLessThanOrEqual(5 * 60_000);
      expect(JSON.stringify(evidence)).not.toMatch(/PRIVATE_MARKDOWN|TOKEN_SENTINEL|body|token/iu);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("does not pair recovery from an unrelated alert incident", async () => {
    const directory = await mkdtemp(join(tmpdir(), "glyphquire-release-alert-mismatch-"));
    const capturePath = join(directory, "alert-evidence.json");
    try {
      await receiveReleaseAlertEvent(
        {
          phase: "firing",
          alert: "backup_failure",
          severity: "critical",
          detectedAt: baseTime,
          emittedAt: baseTime,
          requestId,
          correlationId: requestId,
        },
        { capturePath, clock: () => baseTime },
      );
      const unrelated = "33333333-3333-4333-8333-333333333333";
      const receipt = await receiveReleaseAlertEvent(
        {
          phase: "resolved",
          alert: "disk_capacity",
          severity: "critical",
          detectedAt: baseTime,
          emittedAt: baseTime,
          requestId: unrelated,
          correlationId: unrelated,
        },
        { capturePath, clock: () => baseTime },
      );
      expect(receipt.evidence?.status).toBe("failed");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("keeps the evidence schema strict and the checked-in instance sanitized", async () => {
    const schema = JSON.parse(
      await readFile("docs/evidence/release/alert-evidence.schema.json", "utf8"),
    ) as { additionalProperties?: boolean; required?: string[] };
    expect(schema.additionalProperties).toBe(false);
    expect(schema.required).toEqual(
      expect.arrayContaining(["schemaVersion", "status", "producer", "capturedAt", "events"]),
    );
    const evidencePath =
      process.env.RELEASE_ALERT_EVIDENCE_FILE ?? "docs/evidence/release/alert-evidence.json";
    const evidence = JSON.parse(await readFile(evidencePath, "utf8")) as {
      status: string;
      events: unknown[];
    };
    expect(["blocked", "passed", "failed"]).toContain(evidence.status);
    expect(Array.isArray(evidence.events)).toBe(true);
    expect(JSON.stringify(evidence)).not.toMatch(
      /secret|token|password|cookie|https?:|markdown|body|provider/iu,
    );
  });

  it("requires the built immutable alert-runtime image instead of mounting source", async () => {
    const compose = await readFile("infra/observability/docker-compose.release.yml", "utf8");
    expect(compose).toContain("RELEASE_ALERT_RUNTIME_REPOSITORY");
    expect(compose).toContain("RELEASE_ALERT_RUNTIME_DIGEST");
    expect(compose).not.toContain("RELEASE_ALERT_RUNTIME_IMAGE");
    expect(compose).not.toMatch(/command:[\s\S]{0,160}- node\s+- --experimental-strip-types/u);
    expect(compose).not.toContain("node:22.12.0-bookworm-slim@");
    expect(compose).not.toContain("./:/app:ro");
  });

  it("preserves stable correlation ids when the scheduler records a purge alert", async () => {
    const deletionId = "33333333-3333-4333-8333-333333333333";
    const workspaceId = "44444444-4444-4444-8444-444444444444";
    const repository: MaintenanceSchedulerRepository = {
      listWorkspaceIds: async () => [],
      listDueWorkspaceDeletions: async () => [
        {
          deletionId,
          targetWorkspaceId: workspaceId,
          routingWorkspaceId: workspaceId,
          status: "failed",
          confirmedAt: new Date(baseTime),
          executeAfter: new Date(baseTime),
          updatedAt: new Date(baseTime),
        },
      ],
      listDueAccountDeletions: async () => [],
    };
    const records: unknown[] = [];
    const scheduler = createMaintenanceScheduler({
      repository,
      dispatcher: { enqueue: async () => ({ id: jobId, duplicate: false }) },
      alert: { record: async (event) => records.push(event) },
      batchSizes: {
        importCleanup: 1,
        shareCleanup: 1,
        exportCleanup: 1,
        assetCleanup: 1,
        idempotencyCleanup: 1,
        versionCleanup: 1,
      },
      deletionDeadlineDays: 30,
    });

    await scheduler.run(baseTime, new AbortController().signal);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      event: "lifecycle_purge_attention",
      deletionId,
      requestId: expect.stringMatching(/^[0-9a-f-]{36}$/u),
      correlationId: expect.stringMatching(/^[0-9a-f-]{36}$/u),
    });
    expect(records[0]).toMatchObject({
      requestId: (records[0] as { correlationId: string }).correlationId,
    });
  });
});
