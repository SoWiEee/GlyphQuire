import { PublicApiError } from "../../middleware/error-handler.js";

/**
 * Gates operator-only Phase 5 actions (currently: the bounded one-note
 * search rebuild) behind the exact, opaque `PHASE5_OPERATOR_IDS` allowlist.
 * This is not a workspace membership role — an owner or editor is never
 * implicitly an operator, and there is no way to grant operator access
 * through workspace membership at all. `PHASE5_OPERATOR_IDS` itself is
 * already validated (bounded, deduplicated, non-empty entries) at env-parse
 * time by `phase5EnvSchema`; this authorizer also validates injected values
 * defensively and fails closed when configuration is empty or malformed.
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

export function createOperatorAuthorizer(operatorIds: unknown): OperatorAuthorizer {
  const entries = Array.isArray(operatorIds) ? operatorIds : [];
  const seen = new Set<string>();
  const validConfiguration =
    Array.isArray(operatorIds) &&
    entries.length <= 20 &&
    entries.every((operatorId: unknown) => {
      if (
        typeof operatorId !== "string" ||
        operatorId.length === 0 ||
        /\s/u.test(operatorId) ||
        operatorId.includes("*") ||
        new TextEncoder().encode(operatorId).byteLength > 200 ||
        seen.has(operatorId)
      ) {
        return false;
      }
      seen.add(operatorId);
      return true;
    });
  // `phase5EnvSchema` is the primary parser. This second boundary prevents a
  // malformed programmatic/injected dependency from preserving only its
  // apparently-valid entries and accidentally widening operator access.
  const allowlist = validConfiguration ? seen : new Set<string>();
  return {
    authorize(actorId: string): void {
      if (allowlist.size === 0 || !actorId || !allowlist.has(actorId)) {
        throw new PublicApiError("NOTE_NOT_FOUND", 404);
      }
    },
  };
}
