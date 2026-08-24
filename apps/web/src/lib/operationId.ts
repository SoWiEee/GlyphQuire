/**
 * Mints a fresh CAS operation id. Every write that mutates a note (save,
 * rename, delete, restore, checkpoint, conflict resubmit, ...) must carry
 * its own id minted at the moment that specific attempt is dispatched —
 * never a reused or recovered one — so a retried or duplicated request is
 * always distinguishable server-side.
 */
export function newOperationId(): string {
  const randomUUID = globalThis.crypto?.randomUUID;
  if (typeof randomUUID !== "function") {
    throw new Error("Cryptographically random UUID generation is unavailable");
  }
  return randomUUID.call(globalThis.crypto);
}
