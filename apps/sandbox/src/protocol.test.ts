import { describe, expect, it, vi } from "vitest";
import { sendToHost, validateOrigin } from "./protocol.js";

describe("validateOrigin", () => {
  it("accepts matching origin", () => {
    const event = { origin: "http://localhost:5173" } as MessageEvent;
    expect(validateOrigin(event, "http://localhost:5173")).toBe(true);
  });

  it("rejects mismatched origin", () => {
    const event = { origin: "http://evil.com" } as MessageEvent;
    expect(validateOrigin(event, "http://localhost:5173")).toBe(false);
  });

  it("rejects empty origin", () => {
    const event = { origin: "" } as MessageEvent;
    expect(validateOrigin(event, "http://localhost:5173")).toBe(false);
  });
});

describe("sendToHost", () => {
  it("sends message with protocol version and id via parent.postMessage", () => {
    const mockPostMessage = vi.fn();
    vi.stubGlobal("parent", { postMessage: mockPostMessage });

    sendToHost(
      { type: "runtime:ready" },
      "http://localhost:5173",
      "session-1",
    );

    expect(mockPostMessage).toHaveBeenCalledWith(
      { v: 1, id: "session-1", type: "runtime:ready" },
      "http://localhost:5173",
    );

    vi.unstubAllGlobals();
  });

  it("never uses wildcard origin", () => {
    const mockPostMessage = vi.fn();
    vi.stubGlobal("parent", { postMessage: mockPostMessage });

    sendToHost(
      { type: "runtime:stopped" },
      "http://localhost:5173",
      "session-1",
    );

    const [, targetOrigin] = mockPostMessage.mock.calls[0] as [unknown, string];
    expect(targetOrigin).not.toBe("*");
    expect(targetOrigin).toBe("http://localhost:5173");

    vi.unstubAllGlobals();
  });
});
