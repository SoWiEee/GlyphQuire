import { PublicApiError } from "../../middleware/error-handler.js";

/**
 * Gates operator-only Phase 5 actions (currently: the bounded one-note
 * search rebuild) behind the exact, opaque `PHASE5_OPERATOR_IDS` allowlist.
 * This is not a workspace membership role — an owner or editor is never
 * implicitly an operator, and there is no way to grant operator access
 * through workspace membership at all. `PHASE5_OPERATOR_IDS` itself is
 * already validated (bounded, deduplicated, non-empty entries) at env-parse
 * time by `phase5EnvSchema`; this authorizer only has to fail closed when
 * the parsed allowlist is empty (misconfigured deployment) or the caller's
 * id is not an exact member.
 *
 * A denial is indistinguishable from any other operator-route failure to
 * the caller (the same public error every time) and the shared error
 * handler's audit log never includes the actor id — only requestId, code,
 * status, method, and routeClass — so a denial can never leak which ids
 * were tried.
 */
export interface OperatorAuthorizer {
  authorize(actorId: string): void;
}

export function createOperatorAuthorizer(operatorIds: readonly string[]): OperatorAuthorizer {
  const allowlist = new Set(operatorIds);
  return {
    authorize(actorId: string): void {
      if (allowlist.size === 0 || !actorId || !allowlist.has(actorId)) {
        throw new PublicApiError("NOTE_NOT_FOUND", 404);
      }
    },
  };
}
