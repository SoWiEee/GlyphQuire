import { describe, expect, it, vi } from "vitest";
import { mount } from "@vue/test-utils";
import RuntimeHost from "./RuntimeHost.vue";

vi.mock("./useRuntimeBridge.js", () => ({
  useRuntimeBridge: vi.fn(() => ({
    state: { value: "idle" },
    error: { value: null },
    iframeHeight: { value: 400 },
    execute: vi.fn(),
    stop: vi.fn(),
    reset: vi.fn(),
    cleanup: vi.fn(),
  })),
}));

describe("RuntimeHost", () => {
  it("renders placeholder when idle", () => {
    const wrapper = mount(RuntimeHost, {
      props: { runtime: "p5", source: "sketch.background(0);" },
    });

    expect(wrapper.find("[data-testid='runtime-placeholder']").exists()).toBe(true);
    expect(wrapper.find("iframe").exists()).toBe(false);
  });

  it("rejects code larger than MAX_CODE_SIZE_BYTES", async () => {
    const { useRuntimeBridge } = await import("./useRuntimeBridge.js");
    const mockExecute = vi.fn();
    (useRuntimeBridge as ReturnType<typeof vi.fn>).mockReturnValue({
      state: { value: "ready" },
      error: { value: null },
      iframeHeight: { value: 400 },
      execute: mockExecute,
      stop: vi.fn(),
      reset: vi.fn(),
      cleanup: vi.fn(),
    });

    const oversizedSource = "x".repeat(70_000);
    const wrapper = mount(RuntimeHost, {
      props: { runtime: "p5", source: oversizedSource },
    });

    await wrapper.find("[data-testid='runtime-play']").trigger("click");
    expect(mockExecute).not.toHaveBeenCalled();
  });
});
