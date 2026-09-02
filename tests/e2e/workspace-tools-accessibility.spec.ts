import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Locator, type Page } from "@playwright/test";

async function openTool(page: Page, label: string): Promise<void> {
  await page.locator("header").getByRole("button", { name: "Open command palette" }).click();
  const palette = page.getByRole("dialog", { name: "Command palette" });
  const filter = palette.getByRole("textbox", { name: "Filter commands" });
  await expect(filter).toBeFocused();
  await filter.fill(label);
  await page.keyboard.press("Enter");
}

async function expectDialogAxeClean(page: Page, label: string): Promise<void> {
  const dialog = page.getByRole("dialog", { name: label });
  await expect(dialog).toBeVisible();
  const results = await new AxeBuilder({ page })
    .include(`[role="dialog"][aria-label="${label}"]`)
    .withTags(["wcag2a", "wcag2aa"])
    .analyze();
  expect(results.violations, JSON.stringify(results.violations, null, 2)).toEqual([]);
}

async function openPage(page: Page, label: "Search" | "Shared" | "Transfer"): Promise<Locator> {
  await page.getByRole("tab", { name: label, exact: true }).click();
  const pageId = label.toLowerCase();
  const surface = page.locator(`#workbench-page-${pageId}`);
  await expect(surface).toBeVisible();
  return surface;
}

test.describe("Workspace tools keyboard and axe acceptance", () => {
  test.beforeEach(async ({ page }) => {
    // The public workspace route is intentionally unauthenticated. The local
    // demo route supplies the validated session/workspace fixture needed by
    // Workspace tools panels without weakening production route authorization.
    await page.goto("/__readme-demo?scene=modes");
  });

  test("workspace tools and primary pages have no scoped WCAG A/AA axe violations", async ({
    page,
  }) => {
    await openTool(page, "Manage assets");
    await expectDialogAxeClean(page, "Asset manager");
    await page.getByRole("button", { name: "Close tools" }).click();

    for (const label of ["Search", "Transfer", "Shared"] as const) {
      const surface = await openPage(page, label);
      const results = await new AxeBuilder({ page })
        .include(`#workbench-page-${label.toLowerCase()}`)
        .withTags(["wcag2a", "wcag2aa"])
        .analyze();
      expect(results.violations, JSON.stringify(results.violations, null, 2)).toEqual([]);
      await expect(surface).toBeVisible();
    }
  });

  test("keyboard-only open, operate, escape, and focus restoration are deterministic", async ({
    page,
  }) => {
    const paletteButton = page
      .locator("header")
      .getByRole("button", { name: "Open command palette" });
    await paletteButton.focus();
    await page.keyboard.press("Enter");
    const palette = page.getByRole("dialog", { name: "Command palette" });
    const filter = palette.getByRole("textbox", { name: "Filter commands" });
    await expect(filter).toBeFocused();
    await filter.fill("Search notes");
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");

    const searchPage = page.locator("#workbench-page-search");
    await expect(searchPage).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog", { name: "Command palette" })).toBeHidden();
    await expect(paletteButton).toBeFocused();
  });

  test("status, errors, and form controls expose names without rendering raw markup", async ({
    page,
  }) => {
    await openTool(page, "Manage assets");
    const dialog = page.getByRole("dialog", { name: "Asset manager" });
    await expect(dialog.getByLabel("Asset file")).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Upload asset" })).toBeDisabled();
    await dialog.getByLabel("Asset file").setInputFiles({
      name: "unsafe.svg",
      mimeType: "image/svg+xml",
      buffer: Buffer.from('<svg onload="alert(1)"/>', "utf8"),
    });
    await expect(dialog.getByRole("alert")).toHaveText(
      "Choose a PNG, JPEG, GIF, or WebP file up to 5 MiB.",
    );
    await expect(dialog.locator("svg,script,img")).toHaveCount(0);
  });
});
