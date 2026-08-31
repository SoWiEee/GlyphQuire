import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const MAX_DELIVERY_MS = 5 * 60_000;
const evidencePath = process.env.OPERATIONS_ALERT_EVIDENCE_FILE;
const itWithExternalEvidence = evidencePath ? it : it.skip;

interface AlertEvidence {
  event: "BACKUP_FAILED" | "DEAD_LETTER" | "QUEUE_AGE";
  detectedAt: string;
  deliveredAt: string;
  deliveryStatus: number;
  payload: { event: string; errorCode: string; requestId: string };
}

function timestamp(value: unknown): number {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(value)
  ) {
    throw new Error("Invalid alert evidence timestamp");
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error("Invalid alert evidence timestamp");
  return parsed;
}

function validateEvidence(value: unknown): AlertEvidence {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid alert evidence");
  }
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).sort().join(",") !== "deliveredAt,deliveryStatus,detectedAt,event,payload"
  ) {
    throw new Error("Invalid alert evidence shape");
  }
  if (!new Set(["BACKUP_FAILED", "DEAD_LETTER", "QUEUE_AGE"]).has(String(record.event))) {
    throw new Error("Invalid alert event");
  }
  if (
    !Number.isInteger(record.deliveryStatus) ||
    Number(record.deliveryStatus) < 200 ||
    Number(record.deliveryStatus) > 299
  ) {
    throw new Error("Invalid alert delivery status");
  }
  const detectedAt = timestamp(record.detectedAt);
  const deliveredAt = timestamp(record.deliveredAt);
  if (deliveredAt < detectedAt || deliveredAt - detectedAt > MAX_DELIVERY_MS) {
    throw new Error("Alert delivery exceeded five minutes");
  }
  const payload = record.payload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("Invalid alert payload");
  }
  const payloadRecord = payload as Record<string, unknown>;
  if (Object.keys(payloadRecord).sort().join(",") !== "errorCode,event,requestId") {
    throw new Error("Invalid alert payload shape");
  }
  if (
    typeof payloadRecord.event !== "string" ||
    !/^[A-Z_]{3,40}$/u.test(payloadRecord.event) ||
    typeof payloadRecord.errorCode !== "string" ||
    !/^[A-Z_]{3,40}$/u.test(payloadRecord.errorCode) ||
    typeof payloadRecord.requestId !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f-]{27}$/u.test(payloadRecord.requestId)
  ) {
    throw new Error("Invalid sanitized alert payload");
  }
  const serialized = JSON.stringify(payloadRecord);
  if (/(?:secret|token|password|cookie|contentMarkdown|BEGIN [A-Z ]+ KEY)/iu.test(serialized)) {
    throw new Error("Sensitive alert payload");
  }
  return value as AlertEvidence;
}

describe("Alert-delivery evidence gate", () => {
  it("accepts a sanitized delivery at the five-minute boundary", () => {
    const evidence = validateEvidence({
      event: "BACKUP_FAILED",
      detectedAt: "2026-08-30T00:00:00.000Z",
      deliveredAt: "2026-08-30T00:05:00.000Z",
      deliveryStatus: 202,
      payload: {
        event: "BACKUP_FAILED",
        errorCode: "JOB_FAILED",
        requestId: "11111111-1111-4111-8111-111111111111",
      },
    });
    expect(Date.parse(evidence.deliveredAt) - Date.parse(evidence.detectedAt)).toBe(
      MAX_DELIVERY_MS,
    );
  });

  it("rejects late, secret-bearing, or structurally expanded evidence", () => {
    const base = {
      event: "DEAD_LETTER",
      detectedAt: "2026-08-30T00:00:00.000Z",
      deliveredAt: "2026-08-30T00:05:01.000Z",
      deliveryStatus: 200,
      payload: {
        event: "DEAD_LETTER",
        errorCode: "JOB_FAILED",
        requestId: "22222222-2222-4222-8222-222222222222",
      },
    };
    expect(() => validateEvidence(base)).toThrow("exceeded five minutes");
    expect(() =>
      validateEvidence({
        ...base,
        deliveredAt: "2026-08-30T00:01:00.000Z",
        payload: { ...base.payload, token: "must-not-appear" },
      }),
    ).toThrow("Invalid alert payload shape");
  });

  itWithExternalEvidence(
    "validates a captured operator-channel delivery without printing its payload",
    async () => {
      const raw = await readFile(evidencePath!, "utf8");
      if (Buffer.byteLength(raw, "utf8") > 16 * 1024)
        throw new Error("Alert evidence is too large");
      const evidence = validateEvidence(JSON.parse(raw));
      expect(evidence.deliveryStatus).toBeGreaterThanOrEqual(200);
      expect(evidence.deliveryStatus).toBeLessThan(300);
    },
  );
});
