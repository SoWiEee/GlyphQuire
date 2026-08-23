/**
 * Pure decision logic for when an autosave should produce a new immutable
 * `note_versions` row (a "snapshot"), versus merely updating the note's live
 * `content_markdown`.
 *
 * Deltas are always measured against the latest immutable snapshot, never
 * against the most recent autosave write to the live note row. That keeps
 * the trigger stable regardless of how many un-snapshotted autosaves have
 * happened in between: an editor typing continuously accumulates delta
 * against the same baseline until a snapshot actually lands.
 */

export type SnapshotReason = "autosave" | "checkpoint" | "restore" | "migration" | "import";

export type SnapshotTrigger = "manual" | "size" | "time";

export interface SnapshotDecision {
  readonly shouldSnapshot: boolean;
  readonly trigger: SnapshotTrigger | null;
}

export interface SnapshotPolicyInput {
  /** Why this write is happening. Every non-autosave reason forces a snapshot. */
  readonly reason: SnapshotReason;
  /** UTF-8 byte length of the content being written now. */
  readonly currentBytes: number;
  /**
   * UTF-8 byte length of the latest immutable snapshot's content, or 0 when
   * no snapshot exists yet for this note.
   */
  readonly snapshotBytes: number;
  /** Creation time of the latest immutable snapshot, or null when none exists. */
  readonly lastSnapshotAt: Date | null;
  /** Current time, injected for deterministic testing. */
  readonly now: Date;
}

/** Reasons other than "autosave" always produce a snapshot ("manual" trigger). */
const FORCED_SNAPSHOT_REASONS: ReadonlySet<SnapshotReason> = new Set([
  "checkpoint",
  "restore",
  "migration",
  "import",
]);

/** Elapsed time since the last snapshot that alone forces a new one. */
export const SNAPSHOT_TIME_TRIGGER_MS = 5 * 60 * 1000;

/** Absolute delta, in bytes, that forces a snapshot when no prior snapshot exists. */
export const SNAPSHOT_ABSOLUTE_TRIGGER_BYTES = 10 * 1024;

/** Numerator of the percentage-of-snapshot delta trigger (20%). */
export const SNAPSHOT_PERCENT_TRIGGER_NUMERATOR = 20;
const PERCENT_DENOMINATOR = 100;

export function utf8ByteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

/**
 * Decides whether a write should produce a new immutable version row.
 *
 * The size trigger uses exact integer arithmetic
 * (`deltaBytes * 100 >= snapshotBytes * 20`) so no floating-point rounding
 * can shift the boundary. When there is no prior snapshot the percentage
 * trigger is meaningless (division by zero), so an absolute 10 KiB delta
 * trigger is used instead.
 */
export function decideSnapshot(input: SnapshotPolicyInput): SnapshotDecision {
  if (FORCED_SNAPSHOT_REASONS.has(input.reason)) {
    return { shouldSnapshot: true, trigger: "manual" };
  }

  const deltaBytes = Math.abs(input.currentBytes - input.snapshotBytes);
  const sizeTriggered =
    input.snapshotBytes > 0
      ? deltaBytes * PERCENT_DENOMINATOR >= input.snapshotBytes * SNAPSHOT_PERCENT_TRIGGER_NUMERATOR
      : deltaBytes >= SNAPSHOT_ABSOLUTE_TRIGGER_BYTES;

  if (sizeTriggered) {
    return { shouldSnapshot: true, trigger: "size" };
  }

  if (input.lastSnapshotAt) {
    const elapsedMs = input.now.getTime() - input.lastSnapshotAt.getTime();
    if (elapsedMs >= SNAPSHOT_TIME_TRIGGER_MS) {
      return { shouldSnapshot: true, trigger: "time" };
    }
  }

  return { shouldSnapshot: false, trigger: null };
}
