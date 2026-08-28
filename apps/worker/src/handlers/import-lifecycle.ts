import { createHash } from "node:crypto";
import type { JobEnvelope, JobType } from "@glyphquire/api-contract/jobs";
import { imports, type Database, type ImportManifest } from "@glyphquire/database";
import { and, eq, sql } from "drizzle-orm";

const LIFECYCLE_FIELD = "_lifecycle";
const MAX_LEASE_SECONDS = 3_600;
const MILLISECONDS_PER_SECOND = 1_000;

export type ImportLifecycleKind = "import" | "cleanup";

export interface ImportLifecycleOwner {
  kind: ImportLifecycleKind;
  jobId: string;
  attempt: number;
  leaseExpiresAt: string;
}

export function importLeaseSeconds(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > MAX_LEASE_SECONDS) {
    throw new Error("Invalid import lifecycle lease seconds");
  }
  return value;
}

export function createImportLifecycleOwner<TType extends JobType>(
  kind: ImportLifecycleKind,
  job: JobEnvelope<TType>,
  now: number,
  leaseSeconds: number,
): ImportLifecycleOwner {
  if (!Number.isFinite(now)) throw new Error("JOB_FAILED");
  return {
    kind,
    jobId: job.id,
    attempt: job.attempts,
    leaseExpiresAt: new Date(now + leaseSeconds * MILLISECONDS_PER_SECOND).toISOString(),
  };
}

export function readImportLifecycleOwner(
  manifest: ImportManifest,
): ImportLifecycleOwner | undefined {
  const value = (manifest as Record<string, unknown>)[LIFECYCLE_FIELD];
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const owner = value as Record<string, unknown>;
  if (
    (owner.kind !== "import" && owner.kind !== "cleanup") ||
    typeof owner.jobId !== "string" ||
    !Number.isInteger(owner.attempt) ||
    (owner.attempt as number) < 1 ||
    typeof owner.leaseExpiresAt !== "string" ||
    !Number.isFinite(Date.parse(owner.leaseExpiresAt))
  ) {
    return undefined;
  }
  return owner as unknown as ImportLifecycleOwner;
}

export function withImportLifecycleOwner(
  manifest: ImportManifest,
  owner: ImportLifecycleOwner,
): ImportManifest {
  return { ...manifest, [LIFECYCLE_FIELD]: owner };
}

export function withoutImportLifecycleOwner(manifest: ImportManifest): ImportManifest {
  const cleaned = { ...manifest };
  delete cleaned[LIFECYCLE_FIELD];
  return cleaned;
}

export function importLifecycleOwnersEqual(
  left: ImportLifecycleOwner | undefined,
  right: ImportLifecycleOwner,
): boolean {
  return (
    left?.kind === right.kind &&
    left.jobId === right.jobId &&
    left.attempt === right.attempt &&
    left.leaseExpiresAt === right.leaseExpiresAt
  );
}

export function importLifecycleOwnerPredicate(owner: ImportLifecycleOwner) {
  return and(
    sql`${imports.manifest} -> '_lifecycle' ->> 'kind' = ${owner.kind}`,
    sql`${imports.manifest} -> '_lifecycle' ->> 'jobId' = ${owner.jobId}`,
    sql`${imports.manifest} -> '_lifecycle' ->> 'attempt' = ${String(owner.attempt)}`,
    sql`${imports.manifest} -> '_lifecycle' ->> 'leaseExpiresAt' = ${owner.leaseExpiresAt}`,
  );
}

export function importLifecycleUnownedPredicate() {
  return sql`not (${imports.manifest} ? '_lifecycle')`;
}

export function importLifecycleExpiredOwnerPredicate(kind: ImportLifecycleKind, now: number) {
  const leaseCutoff = new Date(now).toISOString();
  return and(
    sql`jsonb_typeof(${imports.manifest} -> '_lifecycle') = 'object'`,
    sql`${imports.manifest} -> '_lifecycle' ->> 'kind' = ${kind}`,
    sql`jsonb_typeof(${imports.manifest} -> '_lifecycle' -> 'jobId') = 'string'`,
    sql`char_length(${imports.manifest} -> '_lifecycle' ->> 'jobId') > 0`,
    sql`jsonb_typeof(${imports.manifest} -> '_lifecycle' -> 'attempt') = 'number'`,
    sql`${imports.manifest} -> '_lifecycle' ->> 'attempt' ~ '^[1-9][0-9]*$'`,
    sql`jsonb_typeof(${imports.manifest} -> '_lifecycle' -> 'leaseExpiresAt') = 'string'`,
    sql`${imports.manifest} -> '_lifecycle' ->> 'leaseExpiresAt'
      ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z$'`,
    sql`case
      when pg_input_is_valid(
        ${imports.manifest} -> '_lifecycle' ->> 'leaseExpiresAt',
        'timestamp with time zone'
      ) then (${imports.manifest} -> '_lifecycle' ->> 'leaseExpiresAt')::timestamptz
        <= ${leaseCutoff}::timestamptz
      else false
    end`,
  );
}

export function importLifecycleLeaseExpired(owner: ImportLifecycleOwner, now: number): boolean {
  return Date.parse(owner.leaseExpiresAt) <= now;
}

function advisoryKeys(importId: string): [number, number] {
  const digest = createHash("sha256")
    .update(`glyphquire:import-lifecycle:${importId}`, "utf8")
    .digest();
  return [digest.readInt32BE(0), digest.readInt32BE(4)];
}

export async function withImportLifecycleLock<T>(
  database: Database,
  importId: string,
  signal: AbortSignal,
  operation: () => Promise<T>,
): Promise<T> {
  if (signal.aborted) throw new Error("JOB_FAILED");
  const reserved = await database.$client.reserve();
  const [firstKey, secondKey] = advisoryKeys(importId);
  let locked = false;
  let failed = false;
  let failure: unknown;
  let result!: T;
  let released = false;
  try {
    const [claim] = await reserved<{ acquired: boolean }[]>`
      select pg_catalog.pg_try_advisory_lock(${firstKey}, ${secondKey}) as acquired
    `;
    locked = claim?.acquired === true;
    if (!locked || signal.aborted) throw new Error("JOB_FAILED");
    result = await operation();
  } catch (error) {
    failed = true;
    failure = error;
  } finally {
    released = !locked;
    if (locked) {
      const [release] = await reserved<{ released: boolean }[]>`
        select pg_catalog.pg_advisory_unlock(${firstKey}, ${secondKey}) as released
      `.catch(() => []);
      released = release?.released === true;
    }
    reserved.release();
  }
  if (!released) throw new Error("JOB_FAILED");
  if (failed) throw failure;
  return result;
}

export function importOwnedProcessingPredicate(
  importId: string,
  workspaceId: string,
  owner: ImportLifecycleOwner,
) {
  return and(
    eq(imports.id, importId),
    eq(imports.workspaceId, workspaceId),
    eq(imports.status, "processing"),
    eq(imports.compensationStatus, "none"),
    importLifecycleOwnerPredicate(owner),
  );
}
