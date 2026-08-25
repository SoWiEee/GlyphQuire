import { ref, type Ref } from "vue";
import {
  parseSandboxMessage,
  PROTOCOL_VERSION,
  MAX_MESSAGE_RATE,
  RESIZE_MIN_HEIGHT,
  RESIZE_MAX_HEIGHT,
  type HostMessage,
} from "@glyphquire/runtime-protocol";
import { SANDBOX_ORIGIN } from "./runtime-config.js";

export type BridgeState = "idle" | "initializing" | "ready" | "executing" | "stopped" | "error";

export interface RuntimeBridge {
  state: Ref<BridgeState>;
  error: Ref<{ message: string; line?: number } | null>;
  iframeHeight: Ref<number>;
  execute(source: string, props: { height: number; network: string[]; autoplay: boolean }): void;
  stop(): void;
  reset(): void;
  cleanup(): void;
}

export function useRuntimeBridge(
  iframeRef: Ref<HTMLIFrameElement | null>,
  runtime: "p5" | "canvas",
): RuntimeBridge {
  const state = ref<BridgeState>("idle");
  const error = ref<{ message: string; line?: number } | null>(null);
  const iframeHeight = ref(400);

  let sessionId: string | null = null;
  const messageTimestamps: number[] = [];

  function sendToSandbox(msg: HostMessage): void {
    iframeRef.value?.contentWindow?.postMessage(msg, SANDBOX_ORIGIN);
  }

  function isRateLimited(): boolean {
    const now = Date.now();
    messageTimestamps.push(now);
    const windowStart = now - 1000;
    while (messageTimestamps.length > 0 && messageTimestamps[0]! < windowStart) {
      messageTimestamps.shift();
    }
    return messageTimestamps.length > MAX_MESSAGE_RATE;
  }

  function handleMessage(event: MessageEvent): void {
    if (event.origin !== SANDBOX_ORIGIN) return;

    const msg = parseSandboxMessage(event.data);
    if (msg === null) return;
    if (sessionId !== null && msg.id !== sessionId) return;

    if (isRateLimited()) {
      if (sessionId !== null) {
        sendToSandbox({ v: PROTOCOL_VERSION, id: sessionId, type: "runtime:stop" });
      }
      state.value = "error";
      error.value = { message: "Message rate limit exceeded" };
      return;
    }

    switch (msg.type) {
      case "runtime:ready":
        state.value = "ready";
        break;
      case "runtime:resize":
        iframeHeight.value = Math.max(
          RESIZE_MIN_HEIGHT,
          Math.min(RESIZE_MAX_HEIGHT, msg.payload.height),
        );
        break;
      case "runtime:error":
        state.value = "error";
        error.value = { message: msg.payload.message, line: msg.payload.line };
        break;
      case "runtime:stopped":
        if (state.value !== "error") {
          state.value = "stopped";
        }
        break;
    }
  }

  window.addEventListener("message", handleMessage);

  function execute(
    source: string,
    props: { height: number; network: string[]; autoplay: boolean },
  ): void {
    if (state.value !== "ready" || sessionId === null) return;
    state.value = "executing";
    error.value = null;
    sendToSandbox({
      v: PROTOCOL_VERSION,
      id: sessionId,
      type: "runtime:execute",
      payload: { source, props },
    });
  }

  function stop(): void {
    if (state.value !== "executing" || sessionId === null) return;
    sendToSandbox({ v: PROTOCOL_VERSION, id: sessionId, type: "runtime:stop" });
  }

  function reset(): void {
    sessionId = crypto.randomUUID();
    state.value = "initializing";
    error.value = null;
    messageTimestamps.length = 0;

    sendToSandbox({
      v: PROTOCOL_VERSION,
      id: sessionId,
      type: "runtime:init",
      payload: { runtime, origin: window.location.origin },
    });
  }

  function cleanup(): void {
    window.removeEventListener("message", handleMessage);
    if (state.value === "executing") {
      stop();
    }
    sessionId = null;
  }

  return { state, error, iframeHeight, execute, stop, reset, cleanup };
}
