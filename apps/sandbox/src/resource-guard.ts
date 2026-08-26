import { EXECUTION_TIMEOUT_MS } from "@glyphquire/runtime-protocol";
import { sendToHost } from "./protocol.js";

let timeoutId: ReturnType<typeof setTimeout> | null = null;
let errorHandler: ((event: ErrorEvent) => void) | null = null;
let rejectionHandler: ((event: PromiseRejectionEvent) => void) | null = null;

export function startGuard(hostOrigin: string, sessionId: string, runner: { stop(): void }): void {
  stopGuard();

  timeoutId = setTimeout(() => {
    runner.stop();
    sendToHost(
      {
        type: "runtime:error",
        payload: { message: `Execution timed out after ${EXECUTION_TIMEOUT_MS / 1000}s` },
      },
      hostOrigin,
      sessionId,
    );
    sendToHost({ type: "runtime:stopped" }, hostOrigin, sessionId);
  }, EXECUTION_TIMEOUT_MS);

  errorHandler = (event: ErrorEvent) => {
    sendToHost(
      {
        type: "runtime:error",
        payload: {
          message: event.message || "Unknown error",
          line: event.lineno || undefined,
        },
      },
      hostOrigin,
      sessionId,
    );
  };

  rejectionHandler = (event: PromiseRejectionEvent) => {
    const message = event.reason instanceof Error ? event.reason.message : String(event.reason);
    sendToHost(
      {
        type: "runtime:error",
        payload: { message },
      },
      hostOrigin,
      sessionId,
    );
  };

  window.addEventListener("error", errorHandler);
  window.addEventListener("unhandledrejection", rejectionHandler);
}

export function stopGuard(): void {
  if (timeoutId !== null) {
    clearTimeout(timeoutId);
    timeoutId = null;
  }
  if (errorHandler) {
    window.removeEventListener("error", errorHandler);
    errorHandler = null;
  }
  if (rejectionHandler) {
    window.removeEventListener("unhandledrejection", rejectionHandler);
    rejectionHandler = null;
  }
}
