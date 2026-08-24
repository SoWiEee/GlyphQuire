import { describe, expect, it } from "vitest";
import {
  SNAPSHOT_ABSOLUTE_TRIGGER_BYTES,
  SNAPSHOT_TIME_TRIGGER_MS,
  decideSnapshot,
  utf8ByteLength,
  type SnapshotReason,
} from "./snapshot-policy.js";

const NOW = new Date("2026-01-01T00:00:00.000Z");

describe("decideSnapshot", () => {
  it.each<SnapshotReason>(["checkpoint", "restore", "migration", "import"])(
    "always snapshots for the %s reason regardless of size or time",
    (reason) => {
      const decision = decideSnapshot({
        reason,
        currentBytes: 1,
        snapshotBytes: 1,
        lastSnapshotAt: NOW,
        now: NOW,
      });
      expect(decision).toEqual({ shouldSnapshot: true, trigger: "manual" });
    },
  );

  it("does not snapshot an autosave below every trigger", () => {
    const decision = decideSnapshot({
      reason: "autosave",
      currentBytes: 100,
      snapshotBytes: 0,
      lastSnapshotAt: null,
      now: NOW,
    });
    expect(decision).toEqual({ shouldSnapshot: false, trigger: null });
  });

  describe("10 KiB absolute trigger (no prior snapshot)", () => {
    it("does not trigger one byte under the boundary", () => {
      const decision = decideSnapshot({
        reason: "autosave",
        currentBytes: SNAPSHOT_ABSOLUTE_TRIGGER_BYTES - 1,
        snapshotBytes: 0,
        lastSnapshotAt: null,
        now: NOW,
      });
      expect(decision).toEqual({ shouldSnapshot: false, trigger: null });
    });

    it("triggers exactly at the boundary", () => {
      const decision = decideSnapshot({
        reason: "autosave",
        currentBytes: SNAPSHOT_ABSOLUTE_TRIGGER_BYTES,
        snapshotBytes: 0,
        lastSnapshotAt: null,
        now: NOW,
      });
      expect(decision).toEqual({ shouldSnapshot: true, trigger: "size" });
    });
  });

  describe("20 percent trigger (prior snapshot exists), exact integer comparison", () => {
    // snapshotBytes = 1000 gives a clean integer threshold: deltaBytes >= 200
    // since 200 * 100 = 20000 = 1000 * 20.
    it("does not trigger one byte under the boundary", () => {
      const decision = decideSnapshot({
        reason: "autosave",
        currentBytes: 1000 + 199,
        snapshotBytes: 1000,
        lastSnapshotAt: NOW,
        now: NOW,
      });
      expect(decision).toEqual({ shouldSnapshot: false, trigger: null });
    });

    it("triggers exactly at the boundary", () => {
      const decision = decideSnapshot({
        reason: "autosave",
        currentBytes: 1000 + 200,
        snapshotBytes: 1000,
        lastSnapshotAt: NOW,
        now: NOW,
      });
      expect(decision).toEqual({ shouldSnapshot: true, trigger: "size" });
    });

    it("uses exact integer comparison for a non-round snapshot size (no float rounding)", () => {
      // snapshotBytes = 999 -> threshold delta*100 >= 19980 -> delta >= 199.8,
      // so the smallest integer delta that triggers is 200, not 199 (which a
      // naive `delta >= snapshotBytes * 0.2` with float rounding could blur).
      const justUnder = decideSnapshot({
        reason: "autosave",
        currentBytes: 999 + 199,
        snapshotBytes: 999,
        lastSnapshotAt: NOW,
        now: NOW,
      });
      const atThreshold = decideSnapshot({
        reason: "autosave",
        currentBytes: 999 + 200,
        snapshotBytes: 999,
        lastSnapshotAt: NOW,
        now: NOW,
      });
      expect(justUnder).toEqual({ shouldSnapshot: false, trigger: null });
      expect(atThreshold).toEqual({ shouldSnapshot: true, trigger: "size" });
    });

    it("triggers on a shrinking delta (content removed) using the absolute difference", () => {
      const decision = decideSnapshot({
        reason: "autosave",
        currentBytes: 1000 - 200,
        snapshotBytes: 1000,
        lastSnapshotAt: NOW,
        now: NOW,
      });
      expect(decision).toEqual({ shouldSnapshot: true, trigger: "size" });
    });
  });

  describe("five minute time trigger", () => {
    it("does not trigger one millisecond under the boundary", () => {
      const decision = decideSnapshot({
        reason: "autosave",
        currentBytes: 1000,
        snapshotBytes: 1000,
        lastSnapshotAt: new Date(NOW.getTime() - (SNAPSHOT_TIME_TRIGGER_MS - 1)),
        now: NOW,
      });
      expect(decision).toEqual({ shouldSnapshot: false, trigger: null });
    });

    it("triggers exactly at the boundary", () => {
      const decision = decideSnapshot({
        reason: "autosave",
        currentBytes: 1000,
        snapshotBytes: 1000,
        lastSnapshotAt: new Date(NOW.getTime() - SNAPSHOT_TIME_TRIGGER_MS),
        now: NOW,
      });
      expect(decision).toEqual({ shouldSnapshot: true, trigger: "time" });
    });

    it("does not apply the time trigger when there is no prior snapshot", () => {
      const decision = decideSnapshot({
        reason: "autosave",
        currentBytes: 1,
        snapshotBytes: 0,
        lastSnapshotAt: null,
        now: new Date(NOW.getTime() + SNAPSHOT_TIME_TRIGGER_MS * 10),
      });
      expect(decision).toEqual({ shouldSnapshot: false, trigger: null });
    });
  });

  it("prefers the size trigger label when both size and time thresholds are crossed", () => {
    const decision = decideSnapshot({
      reason: "autosave",
      currentBytes: 1000 + 200,
      snapshotBytes: 1000,
      lastSnapshotAt: new Date(NOW.getTime() - SNAPSHOT_TIME_TRIGGER_MS),
      now: NOW,
    });
    expect(decision).toEqual({ shouldSnapshot: true, trigger: "size" });
  });
});

describe("utf8ByteLength", () => {
  it("counts multi-byte characters by their UTF-8 encoding, not code point count", () => {
    expect(utf8ByteLength("a")).toBe(1);
    expect(utf8ByteLength("é")).toBe(2);
    expect(utf8ByteLength("🙂")).toBe(4);
  });
});
