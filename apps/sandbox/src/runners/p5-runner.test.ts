import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { createP5Runner } from "./p5-runner.js";

// happy-dom has no real <canvas> 2D/WebGL rendering support, so the real p5
// library throws deep inside its internal canvas setup. Mock p5 with a
// minimal stand-in that exercises the same construction/teardown contract
// (`createCanvas` appends a <canvas>, `remove()` tears it down) so these
// tests verify the runner's own wiring rather than p5's rendering internals.
// Real p5 rendering is covered by Playwright E2E tests (Task 9).
vi.mock("p5", () => {
  class MockP5 {
    setup: (() => void) | undefined;
    private container: HTMLElement;
    private canvasEl: HTMLCanvasElement | null = null;

    constructor(sketchFn: (sketch: MockP5) => void, node: HTMLElement) {
      this.container = node;
      sketchFn(this);
      if (this.setup) this.setup();
    }

    createCanvas(width: number, height: number): void {
      this.canvasEl = document.createElement("canvas");
      this.canvasEl.width = width;
      this.canvasEl.height = height;
      this.container.appendChild(this.canvasEl);
    }

    remove(): void {
      if (this.canvasEl) {
        this.canvasEl.remove();
        this.canvasEl = null;
      }
    }
  }

  return { default: MockP5 };
});

describe("createP5Runner", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
  });

  it("execute creates a canvas element inside the container", () => {
    const runner = createP5Runner(container);
    runner.execute("sketch.createCanvas(200, 200);", {
      height: 200,
      network: [],
      autoplay: false,
    });

    expect(container.querySelector("canvas")).not.toBeNull();
    runner.stop();
  });

  it("stop clears the container", () => {
    const runner = createP5Runner(container);
    runner.execute("sketch.createCanvas(200, 200);", {
      height: 200,
      network: [],
      autoplay: false,
    });

    runner.stop();
    expect(container.innerHTML).toBe("");
  });

  it("catches syntax errors and throws", () => {
    const runner = createP5Runner(container);
    expect(() => {
      runner.execute("this is not valid javascript{{{", {
        height: 200,
        network: [],
        autoplay: false,
      });
    }).toThrow();
  });
});
