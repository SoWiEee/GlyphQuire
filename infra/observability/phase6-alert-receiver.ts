import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  ALERT_NAMES,
  PHASE6_ALERT_POLICY,
  sanitizeAlertInput,
  type AlertEvent,
} from "./phase6-alert-runtime.js";

const MAX_BODY_BYTES = 16 * 1024;
const EVIDENCE_PRODUCER = "phase6-observability";
const canonicalUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export interface DeliveredAlertEvent extends AlertEvent {
  deliveredAt: string;
  deliveryStatus: number;
}

export interface Phase6AlertEvidence {
  schemaVersion: 1;
  status: "blocked" | "passed" | "failed";
  producer: typeof EVIDENCE_PRODUCER;
  capturedAt: string;
  deliveryDeadlineSeconds: 300;
  blockingReason?: string;
  events: DeliveredAlertEvent[];
}

export interface AlertReceiverOptions {
  capturePath?: string;
  clock?: () => number;
  deliveryStatus?: number;
}

export interface AlertReceipt {
  accepted: boolean;
  statusCode: number;
  evidence?: Phase6AlertEvidence;
}

function writeJson(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(value));
}

function pathOf(request: IncomingMessage): string {
  try {
    return new URL(request.url ?? "/", "http://127.0.0.1").pathname;
  } catch {
    return "/";
  }
}

async function bodyOf(request: IncomingMessage): Promise<unknown | undefined> {
  let bytes = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.byteLength;
    if (bytes > MAX_BODY_BYTES) return undefined;
    chunks.push(buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return undefined;
  }
}

function emptyEvidence(now: number): Phase6AlertEvidence {
  return {
    schemaVersion: 1,
    status: "blocked",
    producer: EVIDENCE_PRODUCER,
    capturedAt: new Date(now).toISOString(),
    deliveryDeadlineSeconds: 300,
    blockingReason: "external channel capture is required",
    events: [],
  };
}

function isDeliveredEvent(value: unknown): value is DeliveredAlertEvent {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    record.schemaVersion === 1 &&
    (record.phase === "firing" || record.phase === "resolved") &&
    typeof record.alert === "string" &&
    (ALERT_NAMES as readonly string[]).includes(record.alert) &&
    (record.severity === "warning" || record.severity === "critical") &&
    typeof record.detectedAt === "string" &&
    typeof record.emittedAt === "string" &&
    typeof record.deliveredAt === "string" &&
    Number.isInteger(record.deliveryStatus) &&
    Number(record.deliveryStatus) >= 200 &&
    Number(record.deliveryStatus) <= 299 &&
    typeof record.requestId === "string" &&
    canonicalUuid.test(record.requestId) &&
    typeof record.correlationId === "string" &&
    canonicalUuid.test(record.correlationId)
  );
}

function validIncomingEvent(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    (record.phase === "firing" || record.phase === "resolved") &&
    typeof record.alert === "string" &&
    (ALERT_NAMES as readonly string[]).includes(record.alert) &&
    (record.severity === "warning" || record.severity === "critical") &&
    canonicalUuid.test(typeof record.requestId === "string" ? record.requestId : "") &&
    canonicalUuid.test(typeof record.correlationId === "string" ? record.correlationId : "") &&
    (typeof record.detectedAt === "number" || typeof record.detectedAt === "string") &&
    (typeof record.emittedAt === "number" || typeof record.emittedAt === "string")
  );
}

async function readEvidence(path: string, now: number): Promise<Phase6AlertEvidence> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    if (
      parsed &&
      typeof parsed === "object" &&
      !Array.isArray(parsed) &&
      (parsed as Record<string, unknown>).schemaVersion === 1 &&
      Array.isArray((parsed as Record<string, unknown>).events)
    ) {
      const record = parsed as Record<string, unknown>;
      const events = (record.events as unknown[]).filter(isDeliveredEvent);
      return {
        schemaVersion: 1,
        status: "blocked",
        producer: EVIDENCE_PRODUCER,
        capturedAt:
          typeof record.capturedAt === "string" ? record.capturedAt : new Date(now).toISOString(),
        deliveryDeadlineSeconds: 300,
        events,
      };
    }
  } catch {
    // A missing or malformed capture starts a fresh, scrubbed record.
  }
  return emptyEvidence(now);
}

async function writeEvidence(path: string, evidence: Phase6AlertEvidence): Promise<void> {
  const temporaryPath = `${path}.tmp-${process.pid}`;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(temporaryPath, `${JSON.stringify(evidence, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await rename(temporaryPath, path);
}

function eventStatus(events: readonly DeliveredAlertEvent[]): Phase6AlertEvidence["status"] {
  const firingEvents = events.filter((event) => event.phase === "firing");
  const resolved = events.some(
    (event) =>
      event.phase === "resolved" &&
      firingEvents.some(
        (firing) => firing.alert === event.alert && firing.correlationId === event.correlationId,
      ),
  );
  return firingEvents.length > 0 && resolved ? "passed" : "failed";
}

/** Persists one sanitized event and returns only a bounded delivery result. */
export async function receiveAlertEvent(
  input: unknown,
  options: AlertReceiverOptions = {},
): Promise<AlertReceipt> {
  const clock = options.clock ?? Date.now;
  const capturePath = resolve(
    options.capturePath ??
      process.env.PHASE6_ALERT_EVIDENCE_HOST_PATH ??
      "/tmp/phase6-alert-evidence.json",
  );
  const deliveryStatus = options.deliveryStatus ?? 202;
  if (!Number.isInteger(deliveryStatus) || deliveryStatus < 200 || deliveryStatus > 299) {
    throw new Error("Alert receiver delivery status must be a successful HTTP status");
  }
  const now = clock();
  if (!validIncomingEvent(input)) return { accepted: false, statusCode: 400 };
  const event = sanitizeAlertInput(input, now);
  const detectedAt = Date.parse(event.detectedAt);
  if (
    !Number.isFinite(detectedAt) ||
    now < detectedAt ||
    now - detectedAt > PHASE6_ALERT_POLICY.deliveryDeadlineMs
  ) {
    return { accepted: false, statusCode: 422 };
  }
  const delivered: DeliveredAlertEvent = {
    ...event,
    deliveredAt: new Date(now).toISOString(),
    deliveryStatus,
  };
  const evidence = await readEvidence(capturePath, now);
  evidence.events = [...evidence.events, delivered].slice(-20);
  evidence.status = eventStatus(evidence.events);
  if (evidence.status === "passed") delete evidence.blockingReason;
  else evidence.blockingReason = "waiting for firing and recovery events";
  await writeEvidence(capturePath, evidence);
  return { accepted: true, statusCode: deliveryStatus, evidence };
}

/**
 * Receives only the strict sanitized event contract. The provider response is
 * never returned to callers or written to evidence; only the status code and
 * bounded timestamps are retained.
 */
export function createAlertReceiverServer(options: AlertReceiverOptions = {}): Server {
  const clock = options.clock ?? Date.now;
  const capturePath = resolve(
    options.capturePath ??
      process.env.PHASE6_ALERT_EVIDENCE_HOST_PATH ??
      "/tmp/phase6-alert-evidence.json",
  );
  return createServer(async (request, response) => {
    const path = pathOf(request);
    if (request.method === "GET" && (path === "/ready" || path === "/health")) {
      writeJson(response, 200, { status: "ready", service: "phase6-alert-receiver" });
      return;
    }
    if (request.method !== "POST" || path !== "/events") {
      writeJson(response, 404, { error: "not_found" });
      return;
    }
    const input = await bodyOf(request);
    if (input === undefined) {
      writeJson(response, 413, { error: "invalid_event" });
      return;
    }
    const receipt = await receiveAlertEvent(input, { capturePath, clock, deliveryStatus });
    if (!receipt.accepted) {
      writeJson(response, receipt.statusCode, {
        error: receipt.statusCode === 422 ? "delivery_deadline" : "invalid_event",
      });
      return;
    }
    // Do not echo the event or provider response across the transport.
    writeJson(response, receipt.statusCode, { accepted: true });
  });
}

export function startAlertReceiverServer(options: AlertReceiverOptions = {}): Server {
  const port = Number(process.env.PHASE6_ALERT_RECEIVER_PORT ?? 8080);
  const server = createAlertReceiverServer(options);
  server.listen(port, "0.0.0.0");
  return server;
}

const executedPath = process.argv[1];
if (
  executedPath &&
  (import.meta.url === `file://${executedPath}` || import.meta.url.endsWith(`/${executedPath}`))
) {
  startAlertReceiverServer();
}
