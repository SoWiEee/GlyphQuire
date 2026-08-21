import { expect, test } from "@playwright/test";

test("Chrome E2E scaffold loads", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveTitle(/GlyphQuire/i);
});
