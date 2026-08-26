import { expect, test } from "@playwright/test";

/**
 * Chrome E2E coverage for the interactive-runtime sandbox's isolation
 * guarantees (spec §21 acceptance criteria): CSP-enforced network denial,
 * cookie/storage isolation via the opaque origin `sandbox="allow-scripts"`
 * (no `allow-same-origin`) produces, and origin-checked postMessage
 * handling.
 *
 * These tests drive `apps/sandbox` directly at `http://127.0.0.1:5174` —
 * they do not need the host web app, matching the task brief's guidance
 * that sandbox security properties are testable independently of the
 * editor UI.
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

test.describe("Runtime security", () => {
  test.beforeEach(() => {
    test.skip(!sandboxAvailable, SKIP_REASON);
  });

  test.skip("the iframe RuntimeHost.vue actually renders carries sandbox='allow-scripts' without allow-same-origin", async () => {
    // Blocked: proving this against the real component needs a page that
    // mounts RuntimeHost.vue, which (see the scope note in
    // tests/e2e/runtime.spec.ts) is only reachable via the Visual editor
    // node view once a backend-wired EditorSession exists. Building a
    // throwaway iframe with the same attribute string here would only
    // prove the test's own fixture is well-formed, not that the shipped
    // component emits it — not meaningful coverage.
    //
    // The invariant instead: apps/web/src/runtime/RuntimeHost.vue's
    // template hardcodes `sandbox="allow-scripts"` as a literal (non-
    // `:sandbox`-bound) attribute — see the `<iframe ... sandbox=
    // "allow-scripts" ...>` line — so it cannot be widened by any prop
    // or state change in that component.
    //
    // Once a route can mount a runtime block: assert
    // `iframe[sandbox]`'s attribute value is exactly `"allow-scripts"`
    // and does not contain `"allow-same-origin"`.
  });

  test("CSP (connect-src 'none') blocks fetch from the sandboxed document", async ({ page }) => {
    await page.goto(SANDBOX_URL);

    const result = await page.evaluate(async () => {
      try {
        await fetch("https://example.com");
        return "allowed";
      } catch {
        return "blocked";
      }
    });
    expect(result).toBe("blocked");
  });

  test("CSP (connect-src 'none') blocks XMLHttpRequest from the sandboxed document", async ({
    page,
  }) => {
    await page.goto(SANDBOX_URL);

    const result = await page.evaluate(() => {
      return new Promise<string>((resolve) => {
        try {
          const xhr = new XMLHttpRequest();
          xhr.open("GET", "https://example.com");
          xhr.onerror = () => resolve("blocked");
          xhr.onload = () => resolve("allowed");
          xhr.send();
        } catch {
          resolve("blocked");
        }
      });
    });
    expect(result).toBe("blocked");
  });

  test("CSP (connect-src 'none') blocks WebSocket from the sandboxed document", async ({
    page,
  }) => {
    await page.goto(SANDBOX_URL);

    // A CSP-blocked WebSocket does NOT throw synchronously at construction
    // — the browser lets `new WebSocket(...)` return normally and denies
    // the connection asynchronously, firing `onerror`/`onclose` instead.
    // Confirmed empirically against this exact CSP (Chromium): the
    // constructor never throws here, so a synchronous try/catch around it
    // would incorrectly report "allowed" for a connection CSP is actually
    // blocking.
    const result = await page.evaluate(() => {
      return new Promise<string>((resolve) => {
        try {
          const ws = new WebSocket("wss://example.com");
          ws.onerror = () => resolve("blocked");
          ws.onopen = () => resolve("allowed");
          setTimeout(() => resolve("blocked"), 3000);
        } catch {
          resolve("blocked");
        }
      });
    });
    expect(result).toBe("blocked");
  });

  test("a document embedded exactly the way RuntimeHost.vue embeds the sandbox (sandbox='allow-scripts', no allow-same-origin) cannot read cookies set on that same origin", async ({
    page,
    context,
    baseURL,
  }) => {
    // Set a cookie scoped to the sandbox's own origin — the worst case for
    // isolation: even a cookie that would normally be visible to
    // http://127.0.0.1:5174 must stay invisible once that document is
    // loaded inside a `sandbox="allow-scripts"` iframe with no
    // `allow-same-origin`, because that combination forces the framed
    // document into a unique, opaque origin with its own (empty) cookie
    // jar — this is the actual browser mechanism GlyphQuire's isolation
    // relies on, not merely cross-port cookie scoping.
    await context.addCookies([
      { name: "host-secret", value: "sensitive-data", url: SANDBOX_ORIGIN },
    ]);

    // Sanity check: loaded as an ordinary top-level document (a real,
    // non-opaque origin), the cookie IS visible — proving the isolation
    // below comes from the sandbox attribute, not from some other cause
    // (e.g. the browser refusing to set the cookie at all).
    await page.goto(SANDBOX_URL);
    const topLevelCookies = await page.evaluate(() => document.cookie);
    expect(topLevelCookies).toContain("host-secret");

    // Now embed it the way RuntimeHost.vue actually does: host the iframe
    // from a normal page on a DIFFERENT origin, exactly matching real
    // production topology (apps/web on 5173 embeds apps/sandbox on 5174).
    // This matters: hosting the iframe from the *sandbox's own* document
    // (e.g. via `page.setContent()`/`about:blank`) is not representative
    // here — that document's own CSP (`default-src 'none'`) makes
    // `frame-src` fall back to `'none'`, so it cannot frame anything at
    // all (including itself), which is a self-inflicted restriction on
    // the parent, not the isolation property under test.
    await page.goto(baseURL ?? "http://127.0.0.1:5173/");
    await page.evaluate((src) => {
      const iframe = document.createElement("iframe");
      iframe.src = src;
      iframe.setAttribute("sandbox", "allow-scripts");
      document.body.appendChild(iframe);
    }, SANDBOX_URL);

    await expect.poll(() => page.frames().some((f) => f.url() === SANDBOX_URL)).toBe(true);
    const frame = page.frames().find((f) => f.url() === SANDBOX_URL)!;

    const framedCookies = await frame.evaluate(() => {
      try {
        return document.cookie;
      } catch {
        // This is the expected path: Chromium throws exactly
        // "The document is sandboxed and lacks the 'allow-same-origin'
        // flag." for `document.cookie` reads inside an opaque-origin
        // frame — confirmed empirically against this exact markup.
        return "<threw: opaque origin>";
      }
    });
    expect(framedCookies).not.toContain("host-secret");
  });

  test("the sandbox ignores a runtime:init declaring an origin that never actually reaches it", async ({
    page,
  }) => {
    // apps/sandbox/src/main.ts trusts the FIRST `runtime:init` message it
    // receives and stores its self-declared `payload.origin` as
    // `hostOrigin`, then replies with `runtime:ready` via
    // `parent.postMessage(msg, hostOrigin)`. The browser's own postMessage
    // contract enforces that `targetOrigin` — a message is only delivered
    // to a window whose ACTUAL origin matches it (or `"*"`). So an init
    // that lies about its origin (here "http://evil.com", while this test
    // window's real origin is http://127.0.0.1:5174) gets accepted by the
    // handler, but the resulting `runtime:ready` reply can never actually
    // be delivered back to this window — it is silently dropped by the
    // browser, not by any application logic. This is deterministic browser
    // behavior, not a race: the reply is never observable here.
    await page.goto(SANDBOX_URL);
    await page.evaluate(() => {
      (window as Window & { __gqReady?: boolean }).__gqReady = false;
      window.addEventListener("message", (event) => {
        if ((event.data as { type?: string } | undefined)?.type === "runtime:ready") {
          (window as Window & { __gqReady?: boolean }).__gqReady = true;
        }
      });
    });

    await page.evaluate(() => {
      window.postMessage(
        {
          v: 1,
          id: "test",
          type: "runtime:init",
          payload: { runtime: "p5", origin: "http://evil.com" },
        },
        "*",
      );
    });

    // Give the async runner-load + reply path time to run (it awaits a
    // dynamic import before replying), then assert it never arrived.
    await page.waitForTimeout(2000);
    const ready = await page.evaluate(() => (window as Window & { __gqReady?: boolean }).__gqReady);
    expect(ready).toBe(false);
  });
});
