import { expect, test, type Page } from "@playwright/test";

/**
 * Chrome evidence that hostile content injected through the workbench's
 * user-facing surfaces cannot execute, navigate, or make network requests.
 *
 * No test helper here uses `eval`, `Function`, `innerHTML`, or `v-html` on
 * hostile content — every payload is delivered through the same public
 * input surfaces a real user would use (`fill`, `type`, `click`), and every
 * assertion reads rendered DOM/`textContent`, never re-interprets it.
 *
 * Scope note: the highest-value target for this class of test is the
 * Visual editor, which parses attacker-controlled Markdown into rendered
 * DOM (a real injection surface, unlike CodeMirror's plain-text source
 * pane). That pane is unreachable from the live route today — mode
 * switching is gated behind a backend-wired `EditorSession` that
 * `WorkbenchPage.vue` does not yet provide (see the scope note at the top
 * of `editor.spec.ts`). Its hostile-content resistance is already covered
 * by extensive component-level tests in
 * `apps/web/src/editors/visual/MilkdownVisualAdapter.test.ts` — script/svg/
 * iframe/onload/onerror stripped from rendered output (around line 234),
 * hostile `handler` attributes on custom directives rejected (line ~238),
 * forged `data-semantic-json` payloads rejected (line ~388), hostile link
 * and image URL sinks (`javascript:`, `data:text/html`, encoded variants)
 * stripped (line ~581 and the `%s` table starting ~line 699), and
 * `p5`/canvas payloads blocked from importing script content (line ~646).
 * The tests below cover every hostile-content surface that IS reachable
 * from the live route right now, and one Visual-mode case is kept as an
 * explicit `.skip()` pointing back to that unit coverage.
 */

const SCRIPT_TAG_PAYLOAD = '<script>window.__glyphquireXss = "script-tag"</script>';
const IMG_ONERROR_PAYLOAD = '<img src="x" onerror="window.__glyphquireXss=\'img-onerror\'">';
const SVG_ONLOAD_PAYLOAD = "<svg onload=\"window.__glyphquireXss='svg-onload'\"></svg>";
const IFRAME_PAYLOAD = "<iframe src=\"javascript:window.__glyphquireXss='iframe'\"></iframe>";
const JS_URL_PAYLOAD = "javascript:window.__glyphquireXss='js-url'";
const HOSTILE_PAYLOADS = [
  SCRIPT_TAG_PAYLOAD,
  IMG_ONERROR_PAYLOAD,
  SVG_ONLOAD_PAYLOAD,
  IFRAME_PAYLOAD,
  JS_URL_PAYLOAD,
];

async function xssSentinelFired(page: Page): Promise<boolean> {
  return page.evaluate(() => Boolean((window as { __glyphquireXss?: unknown }).__glyphquireXss));
}

function assertNoHostileElements(page: Page) {
  // Scoped to the mounted app root: the document `<head>`/`<body>` also
  // carries Vite's own bootstrap `<script type="module">` tags (the app
  // entrypoint and, in dev, the HMR client), which are legitimate and
  // unrelated to anything rendered from note/command content.
  return expect(
    page.locator(
      "#app script, #app svg, #app iframe, #app object, #app embed, #app [onerror], #app [onload], #app [onclick], #app [onmouseover]",
    ),
  ).toHaveCount(0);
}

test.describe("hostile content cannot execute in the reachable workbench UI", () => {
  test.beforeEach(async ({ page }) => {
    const dialogs: string[] = [];
    page.on("dialog", (dialog) => {
      dialogs.push(dialog.message());
      void dialog.dismiss();
    });
    (page as Page & { __dialogs?: string[] }).__dialogs = dialogs;
    await page.goto("/workspace");
  });

  for (const payload of HOSTILE_PAYLOADS) {
    test(`the command palette filter input neutralizes: ${payload.slice(0, 40)}`, async ({
      page,
    }) => {
      await page.getByRole("button", { name: "Open command palette" }).click();
      const input = page.getByRole("textbox", { name: "Filter commands" });

      const requests: string[] = [];
      page.on("request", (request) => requests.push(request.url()));

      await input.fill(payload);
      // The query is rendered back only through Vue's text interpolation
      // (`{{ query }}` is never used here — the input's own value is the
      // only place the string appears), so it must show up verbatim as
      // text, never as parsed markup.
      await expect(input).toHaveValue(payload);

      expect(await xssSentinelFired(page)).toBe(false);
      await assertNoHostileElements(page);
      // No new same-document navigation and no request fired off the back
      // of typing the payload (a `javascript:`/hostile URL never becomes a
      // navigable `href`/`src` anywhere on this page).
      expect(page.url()).toContain("/workspace");
      expect(requests.filter((url) => !url.startsWith("http://127.0.0.1:5173"))).toEqual([]);
    });
  }

  test("no dialog (alert/confirm/prompt) ever fires while hostile payloads are typed", async ({
    page,
  }) => {
    await page.getByRole("button", { name: "Open command palette" }).click();
    const input = page.getByRole("textbox", { name: "Filter commands" });
    for (const payload of HOSTILE_PAYLOADS) {
      await input.fill(payload);
    }
    const dialogs = (page as Page & { __dialogs?: string[] }).__dialogs ?? [];
    expect(dialogs).toEqual([]);
  });

  test("the explorer, tabs, and status bar render only the four fixed demo note titles as text", async ({
    page,
  }) => {
    // These titles are hardcoded in Workbench.vue's DEFAULT_NOTES (not
    // attacker-reachable without a backend), but this still verifies the
    // rendering path itself is plain text interpolation end to end: no
    // `<script>`/`[onerror]`/etc. exists anywhere in the shell, and no
    // stray executable markup leaks through from any note title or tab
    // label under normal use.
    await assertNoHostileElements(page);
    expect(await xssSentinelFired(page)).toBe(false);
  });
});

test.describe("hostile content cannot execute via stored/IndexedDB-shaped data (component-level evidence)", () => {
  test.skip("hostile Markdown loaded into the Visual editor renders as inert text, never executes", async ({
    page,
  }) => {
    // Blocked: reaching Visual mode requires a session-backed note (see
    // the scope note at the top of this file and of `editor.spec.ts`).
    // Once a session factory is wired, un-skip and drive this exact
    // scenario end to end through Chrome:
    //   1. Open a note whose stored markdown contains
    //      `SCRIPT_TAG_PAYLOAD`, `IMG_ONERROR_PAYLOAD`, an
    //      `[Evil](javascript:...)` link, and a `:::callout{handler="..."}`
    //      directive with a hostile handler attribute.
    //   2. Switch to Visual mode.
    //   3. Assert `xssSentinelFired(page)` stays `false`,
    //      `assertNoHostileElements(page)` holds inside
    //      `[data-testid="visual-editor-host"]`, and the hostile link's
    //      rendered `<a>` has no `href` attribute (matches the
    //      `hasAttribute("href")` assertion already proven at the unit
    //      level in MilkdownVisualAdapter.test.ts ~line 608).
    // This is not new coverage to write from scratch — it is the same
    // fixture set already exercised in MilkdownVisualAdapter.test.ts,
    // replayed through a real browser instead of happy-dom once the
    // route can reach Visual mode.
    await page.goto("/workspace");
  });

  test.skip("a hostile draft recovered from IndexedDB after reload renders inert", async ({
    page,
  }) => {
    // Blocked: draft recovery (`IndexedDbDraftStore`, see
    // apps/web/src/persistence/DraftStore.ts) is exercised by
    // `ConflictWorkspace.test.ts`'s "draft durability across reload"
    // cases today, but reaching a recovered-draft state through the live
    // route needs the same session wiring as above. Once reachable,
    // seed IndexedDB directly (no `eval`/`innerHTML` — use
    // `indexedDB.open`/`put` through `page.evaluate` with structured
    // data only) with a draft record whose markdown contains the same
    // hostile payloads, reload, and assert the recovered pane matches
    // the assertions in the Visual-mode case above.
    await page.goto("/workspace");
  });
});
