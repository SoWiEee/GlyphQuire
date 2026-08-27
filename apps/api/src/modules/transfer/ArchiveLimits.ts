export const MAX_ARCHIVE_BYTES = 25 * 1024 * 1024;
export const MAX_ARCHIVE_FILES = 256;
export const MAX_EXPANDED_BYTES = 100 * 1024 * 1024;
export const MAX_ARCHIVE_ENTRY_BYTES = 5 * 1024 * 1024;

export interface ArchiveLimits {
  maxArchiveBytes: number;
  maxArchiveFiles: number;
  maxExpandedBytes: number;
  maxArchiveEntryBytes: number;
}

export const DEFAULT_ARCHIVE_LIMITS: Readonly<ArchiveLimits> = Object.freeze({
  maxArchiveBytes: MAX_ARCHIVE_BYTES,
  maxArchiveFiles: MAX_ARCHIVE_FILES,
  maxExpandedBytes: MAX_EXPANDED_BYTES,
  maxArchiveEntryBytes: MAX_ARCHIVE_ENTRY_BYTES,
});

const HARD_LIMITS: Readonly<ArchiveLimits> = DEFAULT_ARCHIVE_LIMITS;

export function resolveArchiveLimits(overrides: Partial<ArchiveLimits> = {}): ArchiveLimits {
  const limits = { ...DEFAULT_ARCHIVE_LIMITS, ...overrides };
  for (const key of Object.keys(limits) as (keyof ArchiveLimits)[]) {
    if (!Number.isInteger(limits[key]) || limits[key] < 1 || limits[key] > HARD_LIMITS[key]) {
      throw new Error(`Invalid archive limit: ${key}`);
    }
  }
  return limits;
}
