import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import {
  defaultDarkTheme,
  defaultTheme,
  type ThemeTokens,
} from "../../packages/theme-engine/src/tokens.js";

const DESKTOP_VIEWPORT = { width: 1440, height: 900 };
const MOBILE_VIEWPORT = { width: 390, height: 844 };
const SHELL_ROUTE = "/workspace";
const DEMO_ROUTE = "/__readme-demo?scene=modes";

// EditorTabs currently keeps its close control inside the tab element. The
// existing accessibility suite tracks this known axe finding separately; the
// Task 6 smoke fails closed for every other critical or serious violation.
const KNOWN_AXE_FINDINGS = new Set(["nested-interactive"]);

async function dispatchShortcut(page: Page, modifier: "Control" | "Meta"): Promise<void> {
  await page.evaluate((key) => {
    window.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "k",
        bubbles: true,
        cancelable: true,
        ctrlKey: key === "Control",
        metaKey: key === "Meta",
      }),
    );
  }, modifier);
}

function paletteButton(page: Page) {
  return page.locator("header").getByRole("button", { name: "Open command palette" });
}

function relativeLuminance(hex: string): number {
  const value = hex.replace(/^#/, "");
  if (!/^[0-9a-f]{6}$/iu.test(value)) throw new Error(`Expected a six-digit color: ${hex}`);
  const channels = [0, 2, 4].map((offset) => Number.parseInt(value.slice(offset, offset + 2), 16));
  return channels
    .map((channel) => channel / 255)
    .map((channel) => (channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4))
    .reduce((sum, channel, index) => sum + channel * [0.2126, 0.7152, 0.0722][index], 0);
}

function contrastRatio(first: string, second: string): number {
  const firstLuminance = relativeLuminance(first);
  const secondLuminance = relativeLuminance(second);
  const lighter = Math.max(firstLuminance, secondLuminance);
  const darker = Math.min(firstLuminance, secondLuminance);
  return (lighter + 0.05) / (darker + 0.05);
}

function expectThemeContrast(theme: ThemeTokens): void {
  const pairs: ReadonlyArray<readonly [string, string, number]> = [
    [theme.color.foreground, theme.color.surface, 4.5],
    [theme.color.muted, theme.color.surface, 4.5],
    [theme.color.accentContrast, theme.color.accent, 4.5],
    [theme.color.border, theme.color.surface, 3],
    [theme.color.accent, theme.color.surface, 3],
  ];
  for (const [foreground, background, minimum] of pairs) {
    expect(contrastRatio(foreground, background)).toBeGreaterThanOrEqual(minimum);
  }
}

async function criticalAxeFindings(page: Page): Promise<string[]> {
  const result = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
  const unexpected = result.violations.filter(
    (violation) =>
      (violation.impact === "critical" || violation.impact === "serious") &&
      !KNOWN_AXE_FINDINGS.has(violation.id),
  );
  return unexpected.map((violation) => `${violation.id}:${violation.impact ?? "unknown"}`);
}

test.describe("Task 6 workbench UI acceptance", () => {
  test("keeps the desktop keyboard flow and compact shell usable", async ({ page }) => {
    const axeFindings: string[] = [];
    await page.setViewportSize(DESKTOP_VIEWPORT);
    await page.goto(SHELL_ROUTE);

    await test.step("desktop Paper Canvas shell and no-identity semantics", async () => {
      const shell = page.locator(".gq-workbench-shell");
      await expect(shell).toBeVisible();
      await expect(page.getByRole("navigation", { name: "Notes explorer" })).toBeVisible();
      await expect(page.getByRole("tablist", { name: "Open notes" })).toBeVisible();
      await expect(page.getByRole("tabpanel", { name: "Welcome editor" })).toBeVisible();
      await expect(page.getByTestId("context-rail")).toHaveCount(0);

      const editorSurface = page.getByTestId("source-editor-host");
      await expect(editorSurface).toContainText("Welcome to GlyphQuire");
      await expect(editorSurface.locator(".cm-content")).toHaveAttribute(
        "aria-label",
        "Note source markdown",
      );

      const toolbar = page.getByRole("navigation", { name: "Editor toolbar" });
      for (const label of ["Bold", "Italic", "Heading", "Bullet list", "Link"]) {
        await expect(toolbar.getByRole("button", { name: label })).toBeDisabled();
      }

      await expect(page.getByRole("button", { name: "Open shared links" })).toBeDisabled();
      await expect(page.getByRole("button", { name: "Open account menu" })).toHaveCount(0);

      const status = page.locator('[data-status="unavailable"]').last();
      await expect(status).toContainText("Unavailable");
      await expect(status.locator('[data-status-icon="unavailable"]')).toHaveText("×");
      const statusColor = await status
        .locator('[data-status-icon="unavailable"]')
        .evaluate((element) => getComputedStyle(element).color);
      expect(statusColor).toMatch(/^rgb/iu);

      axeFindings.push(...(await criticalAxeFindings(page)));
    });

    await test.step("desktop ContextRail stays hidden until a compact trigger is used", async () => {
      await expect(page.getByTestId("context-rail")).toHaveCount(0);
      await expect(page.getByRole("button", { name: "Open context tools" })).toHaveCount(0);
    });

    await test.step("command palette keyboard navigation and focus restoration", async () => {
      const opener = paletteButton(page);
      await opener.focus();
      await dispatchShortcut(page, "Control");

      const palette = page.getByRole("dialog", { name: "Command palette" });
      const filter = palette.getByRole("textbox", { name: "Filter commands" });
      await expect(filter).toBeFocused();
      const options = palette.getByRole("option");
      await expect(options.first()).toHaveAttribute("aria-selected", "true");
      await page.keyboard.press("ArrowDown");
      await expect(options.nth(1)).toHaveAttribute("aria-selected", "true");
      await page.keyboard.press("Escape");
      await expect(palette).toBeHidden();
      await expect(opener).toBeFocused();

      await opener.click();
      await palette.getByRole("textbox", { name: "Filter commands" }).fill("Roadmap");
      await page.keyboard.press("Enter");
      await expect(palette).toBeHidden();
      await expect(page.getByRole("tab", { name: "Roadmap" })).toHaveAttribute(
        "aria-selected",
        "true",
      );
      await expect(opener).toBeFocused();
    });

    await test.step("writable fixture routes toolbar and slash edits through Markdown", async () => {
      await page.goto(DEMO_ROUTE);
      const source = page.getByTestId("source-editor-host");
      const content = source.locator(".cm-content");
      const originalMarkdown = await content.innerText();

      await content.click();
      await page.keyboard.press("Control+a");
      await page
        .getByRole("navigation", { name: "Editor toolbar" })
        .getByRole("button", { name: "Bold" })
        .click();
      await expect(content).toContainText("**");
      for (const line of originalMarkdown.split("\n").filter(Boolean)) {
        await expect(content).toContainText(line);
      }

      await page.goto(DEMO_ROUTE);
      const resetContent = page.getByTestId("source-editor-host").locator(".cm-content");
      const resetMarkdown = await resetContent.innerText();
      await resetContent.click();
      await page.keyboard.press("Control+End");
      await page.keyboard.press("Enter");
      await page.keyboard.type("/");

      const blockPalette = page.getByRole("dialog", { name: "Command palette" });
      await expect(blockPalette).toBeVisible();
      await expect(blockPalette.getByRole("option")).toHaveCount(4);
      await expect(blockPalette.getByRole("option").first()).toContainText("Heading");
      await expect(blockPalette.getByText("Switch to Visual mode")).toHaveCount(0);
      await page.keyboard.press("ArrowDown");
      await page.keyboard.press("Enter");
      await expect(blockPalette).toBeHidden();

      const afterBlockCommand = await resetContent.innerText();
      expect(afterBlockCommand.startsWith(resetMarkdown)).toBe(true);
      expect(afterBlockCommand).not.toMatch(/(^|\n)\/(?:\n|$)/u);
    });

    await test.step("light and dark token contrast and command palette axe scan", async () => {
      expectThemeContrast(defaultTheme);
      expectThemeContrast(defaultDarkTheme);

      await page.goto(SHELL_ROUTE);
      await paletteButton(page).click();
      await expect(page.getByRole("dialog", { name: "Command palette" })).toBeVisible();
      axeFindings.push(...(await criticalAxeFindings(page)));
    });

    await test.step("390px drawers keep the editor scrollable", async () => {
      await page.setViewportSize(MOBILE_VIEWPORT);
      await page.goto(SHELL_ROUTE);

      const explorerSlot = page.locator(".gq-explorer-slot");
      await expect(explorerSlot).toHaveClass(/gq-explorer-slot--open/u);
      const explorerWidth = await explorerSlot.evaluate(
        (element) => element.getBoundingClientRect().width,
      );
      expect(explorerWidth).toBeLessThanOrEqual(MOBILE_VIEWPORT.width * 0.88 + 1);

      const editorSurface = page.getByTestId("source-editor-host");
      await expect(editorSurface).toBeVisible();
      await expect(editorSurface).toHaveCSS("overflow", "auto");

      const explorerTrigger = page.getByRole("button", { name: "Open explorer" });
      await explorerTrigger.focus();
      await page.keyboard.press("Enter");
      await expect(explorerSlot).not.toHaveClass(/gq-explorer-slot--open/u);
      await explorerTrigger.focus();
      await page.keyboard.press("Enter");

      const contextTrigger = page.getByRole("button", { name: "Open context tools" });
      await contextTrigger.focus();
      await page.keyboard.press("Enter");
      const rail = page.getByTestId("context-rail");
      await expect(rail).toHaveAttribute("role", "dialog");
      await expect(rail).toHaveAttribute("aria-modal", "true");
      const railWidth = await rail.evaluate((element) => element.getBoundingClientRect().width);
      expect(railWidth).toBeLessThanOrEqual(MOBILE_VIEWPORT.width * 0.88 + 1);
      axeFindings.push(...(await criticalAxeFindings(page)));
      await rail.getByRole("button", { name: "Close context tools" }).click();
    });

    expect(axeFindings).toEqual([]);
  });
});
