import { jobPayloadSchemas, type JobEnvelope } from "@glyphquire/api-contract/jobs";
import type { JobHandler } from "@glyphquire/queue";

/**
 * Verifies a backup selected by a server-derived identifier. Implementations
 * must derive `backups/${backupId}/manifest.json` themselves, apply bounded
 * manifest parsing, and verify database/object relationships and hashes. Job
 * payloads never supply an object key, module name, command, or credential.
 */
export interface BackupVerifier {
  verify(backupId: string, signal?: AbortSignal): Promise<void>;
}

export interface BackupVerificationHandlerDependencies {
  verifier: BackupVerifier;
}

export const failClosedBackupVerifier: BackupVerifier = Object.freeze({
  async verify(): Promise<void> {
    throw new Error("Backup verifier is not configured");
  },
});

function checkAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new Error("JOB_FAILED");
}

export function createBackupVerificationHandler(
  dependencies: BackupVerificationHandlerDependencies,
): JobHandler<"backup.verify"> {
  if (!dependencies.verifier) throw new Error("JOB_FAILED: backup verifier is required");
  return async (job: JobEnvelope<"backup.verify">, signal: AbortSignal) => {
    checkAborted(signal);
    const parsed = jobPayloadSchemas["backup.verify"].safeParse(job.payload);
    if (!parsed.success || job.workspaceId !== parsed.data.workspaceId) {
      throw new Error("JOB_INVALID: invalid backup.verify payload");
    }
    try {
      // Preserve the narrow seam used by verifiers that do not need an abort
      // signal. The handler still checks cancellation before and after I/O.
      await dependencies.verifier.verify(parsed.data.backupId);
      checkAborted(signal);
    } catch {
      throw new Error("JOB_FAILED");
    }
  };
}
