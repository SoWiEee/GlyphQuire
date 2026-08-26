import { expect, test, type Page } from "@playwright/test";

/**
 * Chrome E2E coverage for the interactive-runtime protocol
 * (`packages/runtime-protocol`, `apps/sandbox`).
 *
 * Scope note: `RuntimeHost.vue` is only reachable through the Milkdown
 * Visual editor node view (apps/web/src/editors/visual/nodes/runtime.ts).
 * Reaching Visual mode from the live route requires a backend-wired
 * `EditorSession` that `WorkbenchPage.vue` does not yet provide — the same
 * gap documented at the top of `editor.spec.ts` and
 * `security-rendering.spec.ts`. There is no route today that lets a test
 * insert a runtime block through the UI and click a `[data-testid=
 * "runtime-play"]` button.
 *
 * Everything that genuinely depends on that missing UI wiring (the code
 * size guard and the per-page iframe limit, both enforced inside
 * `RuntimeHost.vue` itself) is left as an explicit `.skip()` below,
 * pointing at the existing component-level coverage in
 * `apps/web/src/runtime/RuntimeHost.test.ts`.
 *
 * Everything else — the play/stop execution cycle and the 30s timeout
 * guard — is protocol behavior that lives entirely in `apps/sandbox`
 * (`main.ts`, `resource-guard.ts`, the p5/canvas runners) and does not
 * require the host UI at all. These tests drive that sandbox directly:
 * Chrome navigates to the real sandboxed document
 * (`http://127.0.0.1:5174/index.html`) and posts the exact
 * `runtime:init` / `runtime:execute` / `runtime:stop` messages
 * `useRuntimeBridge.ts` would send, then asserts on the sandbox's real
 * DOM output and its real `runtime:*` replies. This exercises the actual
 * p5/canvas runner code and the actual `resource-guard.ts` timeout —
 * not a mock of the protocol.
 *
 * CSP note: `script-src 'self' 'unsafe-eval'` is required because the
 * runners use `new Function(...)`. The sandbox Vite dev server sends CORS
 * headers (`cors: true`) so the opaque-origin iframe can load modules.
 */

const SANDBOX_ORIGIN = "http://127.0.0.1:5174";
const SANDBOX_URL = `${SANDBOX_ORIGIN}/index.html`;
const SKIP_REASON =
  "apps/sandbox dev server is not running on :5174 (start it with `pnpm --filter @glyphquire/sandbox dev`, or `pnpm dev` from the repo root)";

let sandboxAvailable = false;

test.beforeAll(async () => {
  try {
    const res = await fetch(SANDBOX_URL, { signal: AbortSignal.timeout(3000) });
    sandboxAvailable = res.ok;
  } catch {
    sandboxAvailable = false;
  }
});

/** Extends the window with the small message-capture buffer these tests share. */
type SandboxTestWindow = Window & { __gqMessages?: Array<{ type: string; payload?: unknown }> };

async function armMessageCapture(page: Page): Promise<void> {
  await page.evaluate(() => {
    (window as SandboxTestWindow).__gqMessages = [];
    window.addEventListener("message", (event) => {
      (window as SandboxTestWindow).__gqMessages!.push(event.data);
    });
  });
}

async function hasMessageOfType(page: Page, type: string): Promise<boolean> {
  return page.evaluate(
    (t) => ((window as SandboxTestWindow).__gqMessages ?? []).some((m) => m?.type === t),
    type,
  );
}

test.describe("Runtime execution (sandbox protocol, driven directly)", () => {
  test.beforeEach(async ({ page }) => {
    test.skip(!sandboxAvailable, SKIP_REASON);
    await page.goto(SANDBOX_URL);
    await armMessageCapture(page);
  });

  test("canvas runtime: play draws real pixels, stop tears the canvas down", async ({ page }) => {
    const sessionId = "e2e-canvas-play-stop";

    await page.evaluate((id) => {
      window.postMessage(
        {
          v: 1,
          id,
          type: "runtime:init",
          payload: { runtime: "canvas", origin: window.location.origin },
        },
        "*",
      );
    }, sessionId);
    await expect.poll(() => hasMessageOfType(page, "runtime:ready")).toBe(true);

    const source = "ctx.fillStyle = 'rgb(10,20,30)'; ctx.fillRect(0, 0, width, height);";
    await page.evaluate(
      ({ id, src }) => {
        window.postMessage(
          {
            v: 1,
            id,
            type: "runtime:execute",
            payload: { source: src, props: { height: 200, network: [], autoplay: false } },
          },
          "*",
        );
      },
      { id: sessionId, src: source },
    );

    // Real pixel data from the real canvas the sandbox's canvas-runner drew,
    // proving the user code actually executed inside the sandboxed document.
    await expect
      .poll(() =>
        page.evaluate(() => {
          const canvas = document.querySelector<HTMLCanvasElement>("#runtime-root canvas");
          if (!canvas) return null;
          const [r, g, b] = canvas.getContext("2d")!.getImageData(0, 0, 1, 1).data;
          return `${r},${g},${b}`;
        }),
      )
      .toBe("10,20,30");

    await page.evaluate((id) => {
      window.postMessage({ v: 1, id, type: "runtime:stop" }, "*");
    }, sessionId);

    await expect.poll(() => hasMessageOfType(page, "runtime:stopped")).toBe(true);
    await expect
      .poll(() => page.evaluate(() => document.querySelectorAll("#runtime-root canvas").length))
      .toBe(0);
  });

  test("p5 runtime: play creates a p5 canvas", async ({ page }) => {
    const sessionId = "e2e-p5-play";

    await page.evaluate((id) => {
      window.postMessage(
        {
          v: 1,
          id,
          type: "runtime:init",
          payload: { runtime: "p5", origin: window.location.origin },
        },
        "*",
      );
    }, sessionId);
    await expect.poll(() => hasMessageOfType(page, "runtime:ready")).toBe(true);

    const source = "sketch.background(50, 60, 70); sketch.noLoop();";
    await page.evaluate(
      ({ id, src }) => {
        window.postMessage(
          {
            v: 1,
            id,
            type: "runtime:execute",
            payload: { source: src, props: { height: 200, network: [], autoplay: false } },
          },
          "*",
        );
      },
      { id: sessionId, src: source },
    );

    await expect
      .poll(() => page.evaluate(() => document.querySelectorAll("#runtime-root canvas").length))
      .toBe(1);
  });

  test("execution timeout stops a runaway p5 draw loop and reports 'timed out'", async ({
    page,
  }) => {
    // The 30s EXECUTION_TIMEOUT_MS guard uses `setTimeout`, which only fires
    // once the event loop is free. A synchronous `while(true){}` inside
    // canvas/p5 user code would block that same event loop forever and the
    // guard could never run — so a synchronous infinite loop is not a
    // recoverable scenario with the current (non-Worker) execution model.
    // The realistic, recoverable "infinite loop" a creative-coding runtime
    // actually needs to survive is a p5 `draw()` callback that never calls
    // `noLoop()`: p5 drives it via `requestAnimationFrame`, which yields to
    // the event loop every frame, so `resource-guard.ts`'s timer can still
    // fire and call `runner.stop()`.
    test.slow();
    const sessionId = "e2e-p5-timeout";

    await page.evaluate((id) => {
      window.postMessage(
        {
          v: 1,
          id,
          type: "runtime:init",
          payload: { runtime: "p5", origin: window.location.origin },
        },
        "*",
      );
    }, sessionId);
    await expect.poll(() => hasMessageOfType(page, "runtime:ready")).toBe(true);

    const source = "sketch.draw = () => { sketch.background(0); };";
    await page.evaluate(
      ({ id, src }) => {
        window.postMessage(
          {
            v: 1,
            id,
            type: "runtime:execute",
            payload: { source: src, props: { height: 200, network: [], autoplay: false } },
          },
          "*",
        );
      },
      { id: sessionId, src: source },
    );

    await expect
      .poll(
        () =>
          page.evaluate(() => {
            const errorMsg = ((window as SandboxTestWindow).__gqMessages ?? []).find(
              (m) => m?.type === "runtime:error",
            ) as { payload?: { message?: string } } | undefined;
            return errorMsg?.payload?.message ?? "";
          }),
        { timeout: 35_000, intervals: [1000] },
      )
      .toMatch(/timed out/i);

    await expect.poll(() => hasMessageOfType(page, "runtime:stopped")).toBe(true);
  });

  test.skip("code size limit blocks execution of source larger than MAX_CODE_SIZE_BYTES (64KB)", async () => {
    // Blocked: this guard (`checkCodeSize()` in `RuntimeHost.vue`, which
    // reads `MAX_CODE_SIZE_BYTES` from `@glyphquire/runtime-protocol` and
    // sets `codeSizeError` before ever posting `runtime:init`) runs on the
    // host side, before any message reaches the sandbox — the sandbox's
    // own protocol schema (`packages/runtime-protocol/src/messages.ts`)
    // does not itself enforce a size limit, so this cannot be exercised
    // by driving the sandbox directly the way the tests above do. It
    // needs `RuntimeHost.vue` mounted in a real page, which needs the
    // same Visual-editor session wiring described at the top of this
    // file.
    //
    // Already covered at the component level: apps/web/src/runtime/
    // RuntimeHost.test.ts, "rejects code larger than MAX_CODE_SIZE_BYTES"
    // (~line 27) — mounts RuntimeHost with a 70,000-byte source, clicks
    // `[data-testid="runtime-play"]`, and asserts `execute()` is never
    // called.
    //
    // Once a route can mount a runtime block: insert one with >64KB of
    // source, click `[data-testid="runtime-play"]`, and assert
    // `.runtime-error-msg` is visible with text matching /maximum size/i.
  });

  test.skip("the MAX_IFRAMES_PER_PAGE (8) limit blocks starting another runtime while 8 are active", async () => {
    // Blocked for the same reason as the code-size test above:
    // `isAtLimit` / `activeCount` (RuntimeHost.vue ~lines 25, 34, 89-99)
    // are host-side state shared across every `RuntimeHost` instance on
    // one page, which needs multiple runtime blocks mounted in a single
    // reachable page — not possible without the Visual-editor session
    // wiring.
    //
    // Not yet covered at the component level either: RuntimeHost.test.ts
    // currently only covers the idle-placeholder and code-size cases.
    //
    // Once a route can mount 8+ runtime blocks: start 8, then assert the
    // 9th's `[data-testid="runtime-play"]` button is replaced by
    // `.runtime-limit-msg` ("Maximum active runtimes reached...") and
    // stopping one of the 8 makes the 9th startable again.
  });
});
