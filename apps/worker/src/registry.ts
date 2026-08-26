import type { JobRegistry } from "@glyphquire/queue";

/** Static staged registry; later Phase 5 slices add reviewed handlers by exact JobType key. */
export const jobRegistry: JobRegistry = Object.freeze({});
