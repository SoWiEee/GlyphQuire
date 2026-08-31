import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";

export const PHASE6_ALERT_POLICY = Object.freeze({
  probeIntervalMs: 30_000,
  probeTimeoutMs: 5_000,
  rollingWindowMs: 5 * 60_000,
  consecutiveFailures: 3,
  failureRatio: 0.5,
  recoverySuccesses: 3,
  deliveryDeadlineMs: 5 * 60_000,
  warningUtilization: 0.8,
  criticalUtilization: 0.9,
});

export const ALERT_NAMES = [
  "probe_failure",
  "backup_failure",
  "dead_letter",
  "oldest_queue_age",
  "database_capacity",
  "disk_capacity",
] as const;

export type AlertName = (typeof ALERT_NAMES)[number];
export type AlertPhase = "firing" | "resolved";
export type AlertSeverity = "warning" | "critical";

export interface AlertEvent {
  schemaVersion: 1;
  phase: AlertPhase;
  alert: AlertName;
  severity: AlertSeverity;
  detectedAt: string;
  emittedAt: string;
  requestId: string;
  correlationId: string;
  jobId?: string;
  observedValue?: number;
  threshold?: number;
}

export interface ProbeObservation {
  ok: boolean;
  observedAt?: number;
  requestId?: string;
  correlationId?: string;
}

export interface ConditionObservation {
  alert: Exclude<AlertName, "probe_failure" | "database_capacity" | "disk_capacity">;
  healthy: boolean;
  observedAt?: number;
  requestId?: string;
  correlationId?: string;
  jobId?: string;
  severity?: AlertSeverity;
  observedValue?: number;
  threshold?: number;
}

export interface CapacityObservation {
  resource: "database" | "disk";
  utilization: number;
  observedAt?: number;
  requestId?: string;
  correlationId?: string;
}

export interface Phase6AlertEvaluatorOptions {
  clock?: () => number;
  emit?: (event: AlertEvent) => void | Promise<void>;
  requestIdFactory?: () => string;
}

interface AlertState {
  phase: "idle" | "firing";
  detectedAt?: number;
  consecutiveSuccesses: number;
  severity: AlertSeverity;
}

interface ProbeSample {
  ok: boolean;
  observedAt: number;
}

const canonicalUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const canonicalJobId = canonicalUuid;

function validId(value: unknown, fallback: string): string {
  return typeof value === "string" && canonicalUuid.test(value) ? value : fallback;
}

function finiteTimestamp(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

function isoTimestamp(value: number): string {
  return new Date(value).toISOString();
}

function stateFor(states: Map<AlertName, AlertState>, alert: AlertName): AlertState {
  const existing = states.get(alert);
  if (existing) return existing;
  const state: AlertState = {
    phase: "idle",
    consecutiveSuccesses: 0,
    severity: "critical",
  };
  states.set(alert, state);
  return state;
}

function safeSeverity(value: unknown, fallback: AlertSeverity): AlertSeverity {
  return value === "warning" || value === "critical" ? value : fallback;
}

function safeAlert(value: unknown): AlertName | undefined {
  return typeof value === "string" && (ALERT_NAMES as readonly string[]).includes(value)
    ? (value as AlertName)
    : undefined;
}

function safeNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= 1_000_000
    ? value
    : undefined;
}

/**
 * Selects only the transport contract. Unknown fields are intentionally
 * discarded, so credentials, URLs, bodies, and provider diagnostics cannot
 * cross the alert boundary even when a caller passes an arbitrary object.
 */
export function sanitizeAlertInput(value: unknown, now = Date.now()): AlertEvent {
  const input = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const requestFallback = randomUUID();
  const requestId = validId(input.requestId, requestFallback);
  const correlationId = validId(input.correlationId, requestId);
  const alert = safeAlert(input.alert) ?? "probe_failure";
  const phase: AlertPhase = input.phase === "resolved" ? "resolved" : "firing";
  const severity = safeSeverity(
    input.severity,
    alert.endsWith("capacity") ? "warning" : "critical",
  );
  const detectedAt = finiteTimestamp(input.detectedAt, now);
  const emittedAt = finiteTimestamp(input.emittedAt, now);
  const event: AlertEvent = {
    schemaVersion: 1,
    phase,
    alert,
    severity,
    detectedAt: isoTimestamp(detectedAt),
    emittedAt: isoTimestamp(emittedAt),
    requestId,
    correlationId,
  };

  if (typeof input.jobId === "string" && canonicalJobId.test(input.jobId)) {
    event.jobId = input.jobId;
  }
  const observedValue = safeNumber(input.observedValue);
  if (observedValue !== undefined) event.observedValue = observedValue;
  const threshold = safeNumber(input.threshold);
  if (threshold !== undefined) event.threshold = threshold;
  return event;
}

function publish(emitter: Phase6AlertEvaluatorOptions["emit"], event: AlertEvent): void {
  if (!emitter) return;
  try {
    void Promise.resolve(emitter(event)).catch(() => undefined);
  } catch {
    // Alert transport failure must not turn a health probe into a process crash.
  }
}

/**
 * Stateful evaluator used by the local evaluator process and by deterministic
 * tests. It intentionally accepts observations rather than reaching into an
 * application or provider, keeping the policy portable across deployments.
 */
export class Phase6AlertEvaluator {
  readonly policy = PHASE6_ALERT_POLICY;
  private readonly clock: () => number;
  private readonly emit: Phase6AlertEvaluatorOptions["emit"];
  private readonly requestIdFactory: () => string;
  private readonly states = new Map<AlertName, AlertState>();
  private readonly probeSamples: ProbeSample[] = [];

  constructor(options: Phase6AlertEvaluatorOptions = {}) {
    this.clock = options.clock ?? Date.now;
    this.emit = options.emit;
    this.requestIdFactory = options.requestIdFactory ?? randomUUID;
  }

  observeProbe(observation: ProbeObservation): AlertEvent[] {
    const observedAt = finiteTimestamp(observation.observedAt, this.clock());
    const requestId = validId(observation.requestId, this.requestIdFactory());
    const correlationId = validId(observation.correlationId, requestId);
    this.probeSamples.push({ ok: observation.ok === true, observedAt });
    const cutoff = observedAt - this.policy.rollingWindowMs;
    while (this.probeSamples[0] && this.probeSamples[0].observedAt < cutoff) {
      this.probeSamples.shift();
    }

    const state = stateFor(this.states, "probe_failure");
    const previous = this.probeSamples.at(-2);
    if (observation.ok) {
      state.consecutiveSuccesses += 1;
    } else {
      state.consecutiveSuccesses = 0;
    }

    const consecutiveFailures = observation.ok
      ? 0
      : previous && !previous.ok
        ? this.countTrailingFailures()
        : 1;
    const failures = this.probeSamples.filter((sample) => !sample.ok).length;
    const failureRatio = failures / this.probeSamples.length;
    // Require four samples before a ratio alert so one or two transient
    // observations cannot preempt the explicit three-consecutive rule.
    const rollingFailure =
      this.probeSamples.length >= 4 && failureRatio >= this.policy.failureRatio;
    const events: AlertEvent[] = [];

    if (
      !observation.ok &&
      state.phase === "idle" &&
      (consecutiveFailures >= this.policy.consecutiveFailures || rollingFailure)
    ) {
      state.phase = "firing";
      state.detectedAt = observedAt;
      state.severity = "critical";
      events.push(
        this.event({
          alert: "probe_failure",
          phase: "firing",
          severity: "critical",
          detectedAt: observedAt,
          emittedAt: observedAt,
          requestId,
          correlationId,
          observedValue: failureRatio,
          threshold: this.policy.failureRatio,
        }),
      );
    } else if (
      observation.ok &&
      state.phase === "firing" &&
      state.consecutiveSuccesses >= this.policy.recoverySuccesses
    ) {
      const detectedAt = state.detectedAt ?? observedAt;
      state.phase = "idle";
      state.detectedAt = undefined;
      state.consecutiveSuccesses = 0;
      events.push(
        this.event({
          alert: "probe_failure",
          phase: "resolved",
          severity: state.severity,
          detectedAt,
          emittedAt: observedAt,
          requestId,
          correlationId,
        }),
      );
    }
    events.forEach((event) => publish(this.emit, event));
    return events;
  }

  /** Record an immediate backup, dead-letter, or queue-age condition. */
  observeCondition(observation: ConditionObservation): AlertEvent[] {
    const observedAt = finiteTimestamp(observation.observedAt, this.clock());
    const requestId = validId(observation.requestId, this.requestIdFactory());
    const correlationId = validId(observation.correlationId, requestId);
    const state = stateFor(this.states, observation.alert);
    const events: AlertEvent[] = [];
    if (!observation.healthy && state.phase === "idle") {
      state.phase = "firing";
      state.detectedAt = observedAt;
      state.consecutiveSuccesses = 0;
      state.severity = observation.severity ?? "critical";
      events.push(
        this.event({
          alert: observation.alert,
          phase: "firing",
          severity: state.severity,
          detectedAt: observedAt,
          emittedAt: observedAt,
          requestId,
          correlationId,
          jobId: observation.jobId,
          observedValue: observation.observedValue,
          threshold: observation.threshold,
        }),
      );
    } else if (observation.healthy && state.phase === "firing") {
      state.consecutiveSuccesses += 1;
      if (state.consecutiveSuccesses >= this.policy.recoverySuccesses) {
        const detectedAt = state.detectedAt ?? observedAt;
        state.phase = "idle";
        state.detectedAt = undefined;
        state.consecutiveSuccesses = 0;
        events.push(
          this.event({
            alert: observation.alert,
            phase: "resolved",
            severity: state.severity,
            detectedAt,
            emittedAt: observedAt,
            requestId,
            correlationId,
            jobId: observation.jobId,
          }),
        );
      }
    } else if (!observation.healthy) {
      state.consecutiveSuccesses = 0;
    }
    events.forEach((event) => publish(this.emit, event));
    return events;
  }

  observeCapacity(observation: CapacityObservation): AlertEvent[] {
    if (
      !Number.isFinite(observation.utilization) ||
      observation.utilization < 0 ||
      observation.utilization > 1
    ) {
      throw new Error("Capacity utilization must be between zero and one");
    }
    const alert: AlertName = `${observation.resource}_capacity`;
    const observedAt = finiteTimestamp(observation.observedAt, this.clock());
    const requestId = validId(observation.requestId, this.requestIdFactory());
    const correlationId = validId(observation.correlationId, requestId);
    const state = stateFor(this.states, alert);
    const severity: AlertSeverity =
      observation.utilization >= this.policy.criticalUtilization ? "critical" : "warning";
    const threshold =
      severity === "critical" ? this.policy.criticalUtilization : this.policy.warningUtilization;
    const events: AlertEvent[] = [];

    if (observation.utilization >= this.policy.warningUtilization) {
      if (state.phase === "idle") {
        state.phase = "firing";
        state.detectedAt = observedAt;
        state.consecutiveSuccesses = 0;
        state.severity = severity;
        events.push(
          this.event({
            alert,
            phase: "firing",
            severity,
            detectedAt: observedAt,
            emittedAt: observedAt,
            requestId,
            correlationId,
            observedValue: observation.utilization,
            threshold,
          }),
        );
      } else if (state.severity !== severity) {
        state.severity = severity;
        events.push(
          this.event({
            alert,
            phase: "firing",
            severity,
            detectedAt: state.detectedAt ?? observedAt,
            emittedAt: observedAt,
            requestId,
            correlationId,
            observedValue: observation.utilization,
            threshold,
          }),
        );
      }
      state.consecutiveSuccesses = 0;
    } else if (state.phase === "firing") {
      state.consecutiveSuccesses += 1;
      if (state.consecutiveSuccesses >= this.policy.recoverySuccesses) {
        const detectedAt = state.detectedAt ?? observedAt;
        state.phase = "idle";
        state.detectedAt = undefined;
        state.consecutiveSuccesses = 0;
        events.push(
          this.event({
            alert,
            phase: "resolved",
            severity: state.severity,
            detectedAt,
            emittedAt: observedAt,
            requestId,
            correlationId,
          }),
        );
      }
    }
    events.forEach((event) => publish(this.emit, event));
    return events;
  }

  /** Run one probe with the policy timeout and feed its result into the state machine. */
  async runProbe(
    probe: () => boolean | Promise<boolean>,
    options: { requestId?: string; correlationId?: string; observedAt?: number } = {},
  ): Promise<AlertEvent[]> {
    const observedAt = finiteTimestamp(options.observedAt, this.clock());
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        Promise.resolve().then(probe),
        new Promise<false>((resolve) => {
          timeout = setTimeout(() => resolve(false), this.policy.probeTimeoutMs);
        }),
      ]);
      return this.observeProbe({
        ok: result === true,
        observedAt,
        requestId: options.requestId,
        correlationId: options.correlationId,
      });
    } catch {
      return this.observeProbe({
        ok: false,
        observedAt,
        requestId: options.requestId,
        correlationId: options.correlationId,
      });
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
    }
  }

  private countTrailingFailures(): number {
    let count = 0;
    for (let index = this.probeSamples.length - 1; index >= 0; index -= 1) {
      if (this.probeSamples[index]?.ok) break;
      count += 1;
    }
    return count;
  }

  private event(input: Record<string, unknown>): AlertEvent {
    return sanitizeAlertInput(input, this.clock());
  }
}

export function createPhase6AlertEvaluator(options: Phase6AlertEvaluatorOptions = {}) {
  return new Phase6AlertEvaluator(options);
}

export function schedulePhase6Probes(
  evaluator: Phase6AlertEvaluator,
  probe: () => boolean | Promise<boolean>,
): () => void {
  const interval = setInterval(() => {
    void evaluator.runProbe(probe);
  }, PHASE6_ALERT_POLICY.probeIntervalMs);
  return () => clearInterval(interval);
}

export interface AlertRuntimeServerOptions {
  mode?: "evaluator" | "router";
  port?: number;
  upstreamUrl?: string;
  receiverUrl?: string;
  evaluator?: Phase6AlertEvaluator;
  probeUrl?: string;
}

const MAX_EVENT_BODY_BYTES = 16 * 1024;

function writeJson(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  response.end(JSON.stringify(value));
}

function requestPath(request: IncomingMessage): string {
  try {
    return new URL(request.url ?? "/", "http://127.0.0.1").pathname;
  } catch {
    return "/";
  }
}

async function readJson(request: IncomingMessage): Promise<unknown | undefined> {
  let bytes = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.byteLength;
    if (bytes > MAX_EVENT_BODY_BYTES) return undefined;
    chunks.push(buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return undefined;
  }
}

async function forwardEvent(url: string | undefined, event: AlertEvent): Promise<void> {
  if (!url) return;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return;
  }
  if (!/^https?:$/u.test(parsed.protocol) || parsed.username || parsed.password || parsed.hash)
    return;
  try {
    await fetch(parsed, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(sanitizeAlertInput(event)),
    });
  } catch {
    // The next evaluator tick or receiver health check is the retry boundary.
  }
}

/** Creates the evaluator/router HTTP process used by Compose and smoke tests. */
export function createAlertRuntimeServer(options: AlertRuntimeServerOptions = {}): Server {
  const mode = options.mode ?? "evaluator";
  const evaluator =
    options.evaluator ??
    createPhase6AlertEvaluator({
      emit: (event) => forwardEvent(options.upstreamUrl ?? options.receiverUrl, event),
    });
  return createServer(async (request, response) => {
    const path = requestPath(request);
    if (request.method === "GET" && (path === "/ready" || path === "/health")) {
      writeJson(response, 200, { status: "ready", service: `phase6-alert-${mode}` });
      return;
    }
    if (request.method === "GET" && path === "/metrics") {
      response.writeHead(200, {
        "content-type": "text/plain; version=0.0.4",
        "cache-control": "no-store",
      });
      response.end(
        "glyphquire_alert_runtime_ready 1\n" +
          `glyphquire_alert_probe_interval_seconds ${PHASE6_ALERT_POLICY.probeIntervalMs / 1_000}\n` +
          `glyphquire_alert_probe_timeout_seconds ${PHASE6_ALERT_POLICY.probeTimeoutMs / 1_000}\n`,
      );
      return;
    }
    if (request.method !== "POST" || (path !== "/probe" && path !== "/events")) {
      writeJson(response, 404, { error: "not_found" });
      return;
    }
    const value = await readJson(request);
    if (value === undefined) {
      writeJson(response, 413, { error: "invalid_event" });
      return;
    }
    if (path === "/probe") {
      const input = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
      const events = await evaluator.runProbe(() => input.ok === true, {
        requestId: typeof input.requestId === "string" ? input.requestId : undefined,
        correlationId: typeof input.correlationId === "string" ? input.correlationId : undefined,
      });
      writeJson(response, 202, { accepted: true, events });
      return;
    }
    const event = sanitizeAlertInput(value);
    await forwardEvent(options.receiverUrl ?? options.upstreamUrl, event);
    writeJson(response, 202, { accepted: true });
  });
}

export function startAlertRuntimeServer(options: AlertRuntimeServerOptions = {}): Server {
  const port = options.port ?? Number(process.env.PHASE6_ALERT_RUNTIME_PORT ?? 8080);
  const evaluator =
    options.evaluator ??
    createPhase6AlertEvaluator({
      emit: (event) => forwardEvent(options.upstreamUrl ?? options.receiverUrl, event),
    });
  const server = createAlertRuntimeServer({ ...options, evaluator });
  if (options.mode !== "router") {
    const probeUrl = options.probeUrl ?? process.env.PHASE6_ALERT_PROBE_URL;
    if (probeUrl) {
      let parsedProbeUrl: URL | undefined;
      try {
        const candidate = new URL(probeUrl);
        if (
          /^https?:$/u.test(candidate.protocol) &&
          !candidate.username &&
          !candidate.password &&
          !candidate.hash
        ) {
          parsedProbeUrl = candidate;
        }
      } catch {
        parsedProbeUrl = undefined;
      }
      if (parsedProbeUrl) {
        const stopProbes = schedulePhase6Probes(evaluator, async () => {
          try {
            const response = await fetch(parsedProbeUrl!);
            return response.ok;
          } catch {
            return false;
          }
        });
        server.once("close", stopProbes);
      }
    }
  }
  server.listen(port, "0.0.0.0");
  return server;
}

function cliMode(): "evaluator" | "router" {
  const argument = process.argv.find((value) => value.startsWith("--mode="));
  return argument?.slice("--mode=".length) === "router" ? "router" : "evaluator";
}

const executedPath = process.argv[1];
if (
  executedPath &&
  (import.meta.url === `file://${executedPath}` || import.meta.url.endsWith(`/${executedPath}`))
) {
  startAlertRuntimeServer({
    mode: cliMode(),
    upstreamUrl: process.env.PHASE6_ALERT_ROUTER_URL,
    receiverUrl: process.env.PHASE6_ALERT_RECEIVER_URL,
    probeUrl: process.env.PHASE6_ALERT_PROBE_URL,
  });
}
