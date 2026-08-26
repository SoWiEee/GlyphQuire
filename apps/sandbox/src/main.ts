import { parseHostMessage, type HostMessage } from "@glyphquire/runtime-protocol";
import { sendToHost, validateOrigin } from "./protocol.js";
import type { Runner } from "./types.js";
import type { startGuard, stopGuard } from "./resource-guard.js";

let hostOrigin: string | null = null;
let sessionId: string | null = null;
let initialized = false;

let activeRunner: Runner | null = null;
let guardModule: { startGuard: typeof startGuard; stopGuard: typeof stopGuard } | null = null;

async function loadRunner(type: "p5" | "canvas"): Promise<Runner> {
  if (type === "p5") {
    const mod = await import("./runners/p5-runner.js");
    return mod.createP5Runner(document.getElementById("runtime-root")!);
  }
  const mod = await import("./runners/canvas-runner.js");
  return mod.createCanvasRunner(document.getElementById("runtime-root")!);
}

function handleMessage(event: MessageEvent): void {
  if (hostOrigin !== null && !validateOrigin(event, hostOrigin)) return;

  const msg = parseHostMessage(event.data);
  if (msg === null) return;
  if (sessionId !== null && msg.id !== sessionId) return;

  switch (msg.type) {
    case "runtime:init":
      handleInit(msg, event);
      break;
    case "runtime:execute":
      handleExecute(msg);
      break;
    case "runtime:stop":
      handleStop();
      break;
  }
}

function handleInit(
  msg: Extract<HostMessage, { type: "runtime:init" }>,
  event: MessageEvent,
): void {
  if (initialized) return;
  if (event.origin !== msg.payload.origin) return;
  initialized = true;
  hostOrigin = msg.payload.origin;
  sessionId = msg.id;

  loadRunner(msg.payload.runtime).then((runner) => {
    activeRunner = runner;
    sendToHost({ type: "runtime:ready" }, hostOrigin!, sessionId!);
  });
}

async function handleExecute(
  msg: Extract<HostMessage, { type: "runtime:execute" }>,
): Promise<void> {
  if (!activeRunner || !hostOrigin || !sessionId) return;

  guardModule = await import("./resource-guard.js");
  guardModule.startGuard(hostOrigin, sessionId, activeRunner);

  try {
    activeRunner.execute(msg.payload.source, msg.payload.props);
  } catch (err) {
    guardModule.stopGuard();
    const message = err instanceof Error ? err.message : String(err);
    sendToHost({ type: "runtime:error", payload: { message } }, hostOrigin, sessionId);
    sendToHost({ type: "runtime:stopped" }, hostOrigin, sessionId);
  }
}

function handleStop(): void {
  if (!activeRunner || !hostOrigin || !sessionId) return;
  activeRunner.stop();

  if (guardModule) {
    guardModule.stopGuard();
  }

  sendToHost({ type: "runtime:stopped" }, hostOrigin, sessionId);
}

window.addEventListener("message", handleMessage);
