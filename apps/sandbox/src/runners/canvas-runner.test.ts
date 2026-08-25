import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { createCanvasRunner } from "./canvas-runner.js";

describe("createCanvasRunner", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
  });

  it("creates a canvas with specified dimensions", () => {
    const runner = createCanvasRunner(container);
    runner.execute("ctx.fillRect(0, 0, 100, 100);", {
      height: 300,
      network: [],
      autoplay: false,
    });

    const canvas = container.querySelector("canvas");
    expect(canvas).not.toBeNull();
    expect(canvas!.height).toBe(300);
    runner.stop();
  });

  it("stop clears animation and removes canvas", () => {
    const spy = vi.spyOn(globalThis, "cancelAnimationFrame");
    const runner = createCanvasRunner(container);
    runner.execute("", { height: 300, network: [], autoplay: false });
    runner.stop();

    expect(container.querySelector("canvas")).toBeNull();
    spy.mockRestore();
  });
});
