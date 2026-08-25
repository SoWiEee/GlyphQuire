import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { ref } from "vue";
import { useRuntimeBridge } from "./useRuntimeBridge.js";

function makeMockIframe(_origin: string): HTMLIFrameElement {
  const contentWindow = {
    postMessage: vi.fn(),
  };
  return { contentWindow } as unknown as HTMLIFrameElement;
}

describe("useRuntimeBridge", () => {
  beforeEach(() => {
    vi.stubGlobal("addEventListener", vi.fn());
    vi.stubGlobal("removeEventListener", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("starts in idle state", () => {
    const iframeRef = ref<HTMLIFrameElement | null>(null);
    const bridge = useRuntimeBridge(iframeRef, "p5");
    expect(bridge.state.value).toBe("idle");
    expect(bridge.error.value).toBeNull();
    bridge.cleanup();
  });

  it("transitions to initializing when iframe is set and loaded", async () => {
    const iframe = makeMockIframe("http://localhost:5174");
    const iframeRef = ref<HTMLIFrameElement | null>(null);
    const bridge = useRuntimeBridge(iframeRef, "p5");

    iframeRef.value = iframe;
    bridge.reset();

    expect(bridge.state.value).toBe("initializing");
    bridge.cleanup();
  });

  it("rejects messages from wrong origin", () => {
    const iframe = makeMockIframe("http://localhost:5174");
    const iframeRef = ref<HTMLIFrameElement | null>(iframe);
    const bridge = useRuntimeBridge(iframeRef, "p5");

    const handler = (globalThis.addEventListener as ReturnType<typeof vi.fn>).mock.calls.find(
      ([event]: [string]) => event === "message",
    )?.[1] as ((event: MessageEvent) => void) | undefined;

    if (handler) {
      handler(
        new MessageEvent("message", {
          origin: "http://evil.com",
          data: { v: 1, id: "x", type: "runtime:ready" },
        }),
      );
    }

    expect(bridge.state.value).not.toBe("ready");
    bridge.cleanup();
  });

  it("cleanup removes event listener", () => {
    const iframeRef = ref<HTMLIFrameElement | null>(null);
    const bridge = useRuntimeBridge(iframeRef, "p5");
    bridge.cleanup();

    expect(globalThis.removeEventListener).toHaveBeenCalledWith(
      "message",
      expect.any(Function),
    );
  });
});
