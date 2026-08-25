import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { startGuard, stopGuard } from "./resource-guard.js";

vi.mock("./protocol.js", () => ({
  sendToHost: vi.fn(),
}));

describe("resource-guard", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    stopGuard();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("calls runner.stop() and sends error after timeout", async () => {
    const { sendToHost } = await import("./protocol.js");
    const runner = { stop: vi.fn() };

    startGuard("http://localhost:5173", "session-1", runner);

    vi.advanceTimersByTime(30_000);

    expect(runner.stop).toHaveBeenCalled();
    expect(sendToHost).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "runtime:error",
        payload: expect.objectContaining({
          message: expect.stringContaining("timed out"),
        }),
      }),
      "http://localhost:5173",
      "session-1",
    );
    expect(sendToHost).toHaveBeenCalledWith(
      expect.objectContaining({ type: "runtime:stopped" }),
      "http://localhost:5173",
      "session-1",
    );
  });

  it("stopGuard cancels the timeout", async () => {
    const runner = { stop: vi.fn() };

    startGuard("http://localhost:5173", "session-1", runner);
    stopGuard();

    vi.advanceTimersByTime(30_000);

    expect(runner.stop).not.toHaveBeenCalled();
  });
});
