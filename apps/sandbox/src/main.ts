import { parseHostMessage, type HostMessage } from "@glyphquire/runtime-protocol";
import { sendToHost, validateOrigin } from "./protocol.js";

let hostOrigin: string | null = null;
let sessionId: string | null = null;
let runtimeType: "p5" | "canvas" | null = null;
let initialized = false;

interface Runner {
  execute(source: string, props: { height: number; network: string[]; autoplay: boolean }): void;
  stop(): void;
}

let activeRunner: Runner | null = null;

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
      handleInit(msg);
      break;
    case "runtime:execute":
      handleExecute(msg);
      break;
    case "runtime:stop":
      handleStop();
      break;
  }
}

function handleInit(msg: Extract<HostMessage, { type: "runtime:init" }>): void {
  if (initialized) return;
  initialized = true;
  hostOrigin = msg.payload.origin;
  sessionId = msg.id;
  runtimeType = msg.payload.runtime;

  loadRunner(runtimeType).then((runner) => {
    activeRunner = runner;
    sendToHost({ type: "runtime:ready" }, hostOrigin!, sessionId!);
  });
}

function handleExecute(msg: Extract<HostMessage, { type: "runtime:execute" }>): void {
  if (!activeRunner || !hostOrigin || !sessionId) return;

  import("./resource-guard.js").then(({ startGuard }) => {
    startGuard(hostOrigin!, sessionId!, activeRunner!);
  });

  activeRunner.execute(msg.payload.source, msg.payload.props);
}

function handleStop(): void {
  if (!activeRunner || !hostOrigin || !sessionId) return;
  activeRunner.stop();

  import("./resource-guard.js").then(({ stopGuard }) => {
    stopGuard();
  });

  sendToHost({ type: "runtime:stopped" }, hostOrigin, sessionId);
}

window.addEventListener("message", handleMessage);
