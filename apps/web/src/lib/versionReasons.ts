const REASON_LABELS: Record<string, string> = {
  autosave: "Autosave",
  checkpoint: "Checkpoint",
  restore: "Restore",
  migration: "Migration",
  import: "Import",
};

/** Human-readable label for a {@link NoteVersionSummary.reason} value. */
export function describeVersionReason(reason: string): string {
  return REASON_LABELS[reason] ?? reason;
}
