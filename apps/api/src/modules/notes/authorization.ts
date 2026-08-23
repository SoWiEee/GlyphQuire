import type { WorkspaceRole } from "@glyphquire/database";
import { PublicApiError } from "../../middleware/error-handler.js";

/**
 * Every note lifecycle action a caller can request. "get", "list",
 * "listVersions", and "getVersion" are read-only; the rest mutate note or
 * version state and are restricted to owners and editors.
 */
export type NoteAction =
  | "list"
  | "create"
  | "get"
  | "rename"
  | "softDelete"
  | "restore"
  | "save"
  | "checkpoint"
  | "restoreVersion"
  | "listVersions"
  | "getVersion";

export interface NoteAuthorizationResource {
  readonly role: WorkspaceRole;
}

const MUTATING_ACTIONS: ReadonlySet<NoteAction> = new Set([
  "create",
  "rename",
  "softDelete",
  "restore",
  "save",
  "checkpoint",
  "restoreVersion",
]);

/**
 * Authorizes an actor to perform `action` against `resource`.
 *
 * `resource` is the actor's own membership-scoped lookup result: undefined
 * when no membership row (or no membership-joined note row) was found for
 * this actor, workspace, and resource state. Every caller of this function
 * must have already produced `resource` from a query whose predicate is
 * scoped to `actor`'s membership — this function never re-queries.
 *
 * Unauthorized, cross-workspace, and hidden (soft-deleted, or otherwise
 * state-mismatched) resources are indistinguishable from missing ones: they
 * all throw the same NOTE_NOT_FOUND envelope, so no probe can learn whether
 * a resource exists outside the caller's authorized scope. A viewer
 * attempting a mutating action is treated the same way — the response never
 * signals that the resource exists to a caller who cannot act on it.
 */
export function authorize(
  actor: string,
  action: NoteAction,
  resource: NoteAuthorizationResource | undefined,
): asserts resource is NoteAuthorizationResource {
  if (!actor || !resource) {
    throw new PublicApiError("NOTE_NOT_FOUND", 404);
  }
  if (MUTATING_ACTIONS.has(action) && resource.role !== "owner" && resource.role !== "editor") {
    throw new PublicApiError("NOTE_NOT_FOUND", 404);
  }
}
