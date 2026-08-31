import { describe, expect, it } from "vitest";
import { assertRequiredJobsComplete, assertRegistryComplete } from "@glyphquire/queue";
import { type ShareCleanupAuditEvent } from "./handlers/share-cleanup.js";
import { createStructuredShareCleanupAudit, jobRegistry } from "./registry.js";

const event: ShareCleanupAuditEvent = {
  event: "share_link_deleted",
  jobId: "00000000-0000-4000-8000-000000000001",
  workspaceId: "00000000-0000-4000-8000-000000000002",
  shareLinkId: "00000000-0000-4000-8000-000000000003",
  reason: "expired",
};

describe("structured share cleanup audit", () => {
  it("resolves only after the stderr writer acknowledges the record", async () => {
    let acknowledge: ((error?: Error | null) => void) | undefined;
    const audit = createStructuredShareCleanupAudit((_chunk, callback) => {
      acknowledge = callback;
    });
    let settled = false;
    const pending = audit.record(event).then(() => {
      settled = true;
    });

    await Promise.resolve();
    expect(settled).toBe(false);
    acknowledge?.();
    await pending;
    expect(settled).toBe(true);
  });

  it("rejects stream failures so cleanup transactions can roll back", async () => {
    const audit = createStructuredShareCleanupAudit((_chunk, callback) => {
      callback(new Error("audit sink unavailable"));
    });

    await expect(audit.record(event)).rejects.toThrow("audit sink unavailable");
  });
});

describe("static job registry handoff", () => {
  it("satisfies the P0 activation gate and the separate P1 diagnostic", () => {
    expect(() => assertRegistryComplete(jobRegistry)).not.toThrow();
    expect(assertRequiredJobsComplete(jobRegistry)).toEqual({ complete: true, missing: [] });
  });
});
