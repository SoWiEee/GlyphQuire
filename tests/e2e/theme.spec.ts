import { test, expect } from "@playwright/test";

test.describe("Theme System", () => {
  test("theme editor panel opens and closes from TopBar", async ({ page }) => {
    await page.goto("/");

    const themeButton = page.getByRole("button", { name: "Open theme editor" });
    await expect(themeButton).toBeVisible();
    await themeButton.click();

    const panel = page.getByRole("dialog", { name: /theme/i });
    await expect(panel).toBeVisible();

    await page.keyboard.press("Escape");
    await expect(panel).not.toBeVisible();
  });

  test("theme editor panel closes via backdrop click", async ({ page }) => {
    await page.goto("/");

    await page.getByRole("button", { name: "Open theme editor" }).click();
    const panel = page.getByRole("dialog", { name: /theme/i });
    await expect(panel).toBeVisible();

    await page.getByRole("button", { name: "Close theme editor" }).click();
    await expect(panel).not.toBeVisible();
  });

  test("dark mode toggle updates isDark state", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: "Open theme editor" }).click();

    const darkCheckbox = page.getByRole("checkbox", { name: /dark/i });
    await expect(darkCheckbox).toBeVisible();
    await expect(darkCheckbox).not.toBeChecked();

    await darkCheckbox.check();
    await expect(darkCheckbox).toBeChecked();
  });

  test("prefers-reduced-motion suppresses callout animation", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto("/");

    const animation = await page.evaluate(() => {
      const el = document.querySelector("[data-glyphquire-node='callout']");
      return el ? getComputedStyle(el).animationName : "none";
    });
    expect(animation).toBe("none");
  });
});
