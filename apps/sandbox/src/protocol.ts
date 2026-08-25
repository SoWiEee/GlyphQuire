import { PROTOCOL_VERSION, type SandboxMessage } from "@glyphquire/runtime-protocol";

export function validateOrigin(event: MessageEvent, allowedOrigin: string): boolean {
  return event.origin !== "" && event.origin === allowedOrigin;
}

// A plain `Omit<SandboxMessage, "v" | "id">` collapses the discriminated
// union to only its common keys (dropping each variant's own `payload`)
// because `Omit` is not distributive. Distribute it manually so callers can
// still pass variant-specific payloads (e.g. `runtime:error`).
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
type SandboxMessageBody = DistributiveOmit<SandboxMessage, "v" | "id">;

export function sendToHost(
  message: SandboxMessageBody,
  targetOrigin: string,
  sessionId: string,
): void {
  const full = { ...message, v: PROTOCOL_VERSION, id: sessionId } as SandboxMessage;
  parent.postMessage(full, targetOrigin);
}
