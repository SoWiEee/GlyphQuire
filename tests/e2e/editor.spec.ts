import { expect, test, type Page } from "@playwright/test";

/**
 * Fires the same `keydown` shape a real Ctrl/Cmd+K keypress would produce.
 * Chrome reserves that combination for the omnibox at the browser-process
 * level, so `page.keyboard.press()` never reaches the page — dispatching
 * the event directly on `window` is the standard Playwright workaround for
 * browser-reserved shortcuts and still exercises the app's own listener.
 */
async function dispatchShortcut(page: Page, modifierKey: "Control" | "Meta"): Promise<void> {
  await page.evaluate((modifier) => {
    const init: KeyboardEventInit = {
      key: "k",
      bubbles: true,
      cancelable: true,
      ctrlKey: modifier === "Control",
      metaKey: modifier === "Meta",
    };
    window.dispatchEvent(new KeyboardEvent("keydown", init));
  }, modifierKey);
}

/**
 * Chrome E2E coverage for the Phase 2 workbench shell.
 *
 * Scope note: `WorkbenchPage.vue` currently mounts `Workbench.vue` without a
 * `sessionFactory` prop (see apps/web/src/pages/WorkbenchPage.vue and
 * apps/web/src/components/workbench/Workbench.vue `activateSession()`).
 * Without a factory the workbench never opens an `EditorSession`, so:
 *   - `SourceEditor` stays `read-only` (its own default is also `read-only`,
 *     see apps/web/src/components/source/SourceEditor.vue).
 *   - `onModeChange` no-ops (`if (!session) return;`), so the Visual/Split
 *     mode buttons cannot change the active pane yet.
 * Those two behaviors depend on the app wiring a real `NoteClient`-backed
 * session to the route, which needs a running API + database (out of scope
 * for this task per the Task 13 brief's scoping note). Tests below cover
 * every workbench behavior that does NOT depend on that wiring — shell
 * rendering, tab management, and the command palette — and the two gated
 * behaviors are captured as explicit `.skip()` cases with reproduction
 * steps so they can be un-skipped the moment session wiring lands.
 */

test.describe("workbench shell", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/workspace");
  });

  test("renders the shell with the default note open", async ({ page }) => {
    await expect(page.getByRole("heading", { level: 1 })).toHaveCount(0);
    await expect(page.getByText("GlyphQuire").first()).toBeVisible();

    // Explorer lists all demo notes.
    const explorer = page.getByRole("navigation", { name: "Notes explorer" });
    await expect(explorer.getByRole("button", { name: "Welcome" })).toBeVisible();
    await expect(explorer.getByRole("button", { name: "Roadmap" })).toBeVisible();
    await expect(explorer.getByRole("button", { name: "Scratch" })).toBeVisible();

    // The first note is open by default with its markdown rendered read-only.
    await expect(page.getByRole("tab", { name: "Welcome" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    const sourceHost = page.getByTestId("source-editor-host");
    await expect(sourceHost).toBeVisible();
    await expect(sourceHost).toContainText("Welcome to GlyphQuire");

    // Status bar reflects the active note.
    const statusBar = page.getByRole("status");
    await expect(statusBar.getByLabel("Active note")).toHaveText("Welcome");
    await expect(statusBar.getByLabel("Editor mode")).toHaveText("Source");
  });

  test("mode radiogroup exposes Source, Visual, and Split", async ({ page }) => {
    const modeGroup = page.getByRole("radiogroup", { name: "Editor mode" });
    await expect(modeGroup.getByRole("radio", { name: "Source" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    await expect(modeGroup.getByRole("radio", { name: "Visual" })).toHaveAttribute(
      "aria-checked",
      "false",
    );
    await expect(modeGroup.getByRole("radio", { name: "Split" })).toHaveAttribute(
      "aria-checked",
      "false",
    );
  });
});

test.describe("tab management", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/workspace");
  });

  test("opening a second note from the explorer adds and activates a tab", async ({ page }) => {
    const tabs = page.getByRole("tablist", { name: "Open notes" });
    await expect(tabs.getByRole("tab")).toHaveCount(1);

    await page
      .getByRole("navigation", { name: "Notes explorer" })
      .getByRole("button", {
        name: "Roadmap",
      })
      .click();

    await expect(tabs.getByRole("tab")).toHaveCount(2);
    await expect(tabs.getByRole("tab", { name: "Roadmap" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await expect(tabs.getByRole("tab", { name: "Welcome" })).toHaveAttribute(
      "aria-selected",
      "false",
    );
    await expect(page.getByTestId("source-editor-host")).toContainText("Roadmap");
    await expect(page.getByRole("status").getByLabel("Active note")).toHaveText("Roadmap");
  });

  test("clicking an open tab switches the active note without closing others", async ({ page }) => {
    const explorer = page.getByRole("navigation", { name: "Notes explorer" });
    await explorer.getByRole("button", { name: "Roadmap" }).click();
    await explorer.getByRole("button", { name: "Scratch" }).click();

    const tabs = page.getByRole("tablist", { name: "Open notes" });
    await expect(tabs.getByRole("tab")).toHaveCount(3);

    await tabs.getByRole("tab", { name: "Welcome" }).click();
    await expect(tabs.getByRole("tab", { name: "Welcome" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await expect(tabs.getByRole("tab")).toHaveCount(3);
  });

  test("closing a tab removes it and activates a remaining tab", async ({ page }) => {
    const explorer = page.getByRole("navigation", { name: "Notes explorer" });
    await explorer.getByRole("button", { name: "Roadmap" }).click();

    const tabs = page.getByRole("tablist", { name: "Open notes" });
    await expect(tabs.getByRole("tab")).toHaveCount(2);

    await tabs
      .getByRole("tab", { name: "Roadmap" })
      .getByRole("button", {
        name: "Close Roadmap",
      })
      .click();

    await expect(tabs.getByRole("tab")).toHaveCount(1);
    await expect(tabs.getByRole("tab", { name: "Welcome" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    // The note stays in the explorer even though its tab was closed.
    await expect(explorer.getByRole("button", { name: "Roadmap" })).toBeVisible();
  });

  test("closing every tab shows the empty-tabs affordance", async ({ page }) => {
    const tabs = page.getByRole("tablist", { name: "Open notes" });
    await tabs
      .getByRole("tab", { name: "Welcome" })
      .getByRole("button", {
        name: "Close Welcome",
      })
      .click();

    await expect(tabs.getByRole("tab")).toHaveCount(0);
    await expect(page.getByText("No notes open — pick one from the Explorer.")).toBeVisible();
    await expect(page.getByText("Open a note from the Explorer to start editing.")).toBeVisible();
  });
});

test.describe("command palette", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/workspace");
  });

  test("opens via the toolbar button and closes on Escape, restoring focus", async ({ page }) => {
    const openButton = page.locator("header").getByRole("button", { name: "Open command palette" });
    await openButton.click();

    const dialog = page.getByRole("dialog", { name: "Command palette" });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("textbox", { name: "Filter commands" })).toBeFocused();

    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(openButton).toBeFocused();
  });

  test("opens via the Cmd/Ctrl+K shortcut from anywhere on the page", async ({ page }) => {
    // Ctrl+K / Cmd+K is a reserved Chrome browser shortcut (focus the
    // omnibox) that the browser process intercepts before it ever reaches
    // the page, so `page.keyboard.press("Control+k")` cannot exercise it
    // through Playwright. Dispatching the same KeyboardEvent shape directly
    // on `window` still exercises the app's real `onGlobalKeydown` listener
    // in Workbench.vue with no shortcuts and no touch of user content.
    //
    // Wait for the toolbar (rendered by the same Workbench mount that
    // registers the listener) before dispatching — Workbench.vue's
    // `onMounted` runs a tick after its template is first painted, so
    // dispatching immediately after `goto()` can race the listener
    // registration and silently no-op.
    await page
      .locator("header")
      .getByRole("button", { name: "Open command palette" })
      .waitFor({ state: "visible" });
    await dispatchShortcut(page, "Control");

    const dialog = page.getByRole("dialog", { name: "Command palette" });
    await expect(dialog).toBeVisible();

    // The same shortcut toggles it closed again.
    await dispatchShortcut(page, "Control");
    await expect(dialog).toBeHidden();
  });

  test("filters commands by label as the query changes", async ({ page }) => {
    await page.locator("header").getByRole("button", { name: "Open command palette" }).click();
    const dialog = page.getByRole("dialog", { name: "Command palette" });
    const listbox = dialog.getByRole("listbox", { name: "Commands" });

    await expect(listbox.getByRole("option")).toHaveCount(5); // toggle-mode + 3 notes + close-tab
    await dialog.getByRole("textbox", { name: "Filter commands" }).fill("Roadmap");
    await expect(listbox.getByRole("option")).toHaveCount(1);
    await expect(listbox.getByRole("option")).toHaveText(/Open "Roadmap"/);
  });

  test("running a command from the list closes the palette", async ({ page }) => {
    await page.locator("header").getByRole("button", { name: "Open command palette" }).click();
    const dialog = page.getByRole("dialog", { name: "Command palette" });
    await dialog.getByRole("textbox", { name: "Filter commands" }).fill("Scratch");
    await dialog.getByRole("option", { name: /Open "Scratch"/ }).click();

    await expect(dialog).toBeHidden();
    await expect(
      page.getByRole("tablist", { name: "Open notes" }).getByRole("tab", { name: "Scratch" }),
    ).toHaveAttribute("aria-selected", "true");
  });

  test("closes when clicking the backdrop", async ({ page }) => {
    await page.locator("header").getByRole("button", { name: "Open command palette" }).click();
    const dialog = page.getByRole("dialog", { name: "Command palette" });
    await expect(dialog).toBeVisible();
    // Click outside the dialog panel but inside the fixed overlay.
    await page.mouse.click(5, 5);
    await expect(dialog).toBeHidden();
  });
});

test.describe("editing (requires backend-wired session)", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/workspace");
  });

  test.skip("typing in the source editor updates the document and word count", async ({ page }) => {
    // Blocked: WorkbenchPage.vue passes no `sessionFactory` to Workbench,
    // so `sourceReadOnly` stays `true` (Workbench.vue) and SourceEditor's
    // own `readOnly` default is also `true` (SourceEditor.vue). CodeMirror
    // is therefore mounted read-only and rejects keystrokes. Once the
    // route wires a real `EditorSession` (an `EditorSessionImpl` backed by
    // `NoteClient` against a running API), un-skip this and assert typed
    // text appears in `[data-testid="source-editor-host"] .cm-content`
    // and the status bar word count updates.
    const sourceHost = page.getByTestId("source-editor-host");
    await sourceHost.click();
    await page.keyboard.type(" extra words here");
    await expect(sourceHost).toContainText("extra words here");
  });

  test.skip("the mode toggle switches the active editor pane between Source, Visual, and Split", async ({
    page,
  }) => {
    // Blocked: `onModeChange` in Workbench.vue is `if (!session) return;`
    // — with no session, clicking Visual/Split emits `update:mode` but the
    // pane never switches. Once a session is wired, un-skip and assert
    // `[data-testid="visual-editor-host"]` becomes visible after clicking
    // the Visual radio, and both panes render side by side for Split.
    await page.getByRole("radio", { name: "Visual" }).click();
    await expect(page.getByTestId("visual-editor-host")).toBeVisible();
  });
});
