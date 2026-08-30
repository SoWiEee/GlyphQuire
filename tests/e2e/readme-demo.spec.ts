import { mkdirSync } from "node:fs";
import { expect, test, type Page, type Route } from "@playwright/test";

test.use({ viewport: { width: 1440, height: 900 } });

const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
const NOTE_ID = "22222222-2222-4222-8222-222222222222";
const SEARCH_NOTE_ID = "33333333-3333-4333-8333-333333333333";
const IMPORT_ID = "44444444-4444-4444-8444-444444444444";
const EXPORT_ID = "55555555-5555-4555-8555-555555555555";
const NOW = "2026-08-30T00:00:00.000Z";

function apiJson(route: Route, status: number, body: unknown): Promise<void> {
  return route.fulfill({
    status,
    contentType: "application/json",
    headers: { "cache-control": "no-store" },
    body: JSON.stringify(body),
  });
}

async function assertDemoDomSafe(page: import("@playwright/test").Page): Promise<void> {
  const exposed = await page.locator("body").evaluate((body) => ({
    text: body.innerText,
    visibleTextNodes: (() => {
      const values: string[] = [];
      const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
      let current = walker.nextNode();
      while (current) {
        const element = current.parentElement;
        if (element && element.getClientRects().length > 0) values.push(current.nodeValue ?? "");
        current = walker.nextNode();
      }
      return values;
    })(),
    attributes: Array.from(body.querySelectorAll("*")).flatMap((element) =>
      Array.from(element.attributes, (attribute) => attribute.value),
    ),
  }));
  const combined = [exposed.text, ...exposed.visibleTextNodes, ...exposed.attributes].join("\n");
  expect(combined).not.toMatch(
    /(?:token=|bearer |presigned|https?:\/\/|postgresql:\/\/|s3[.-]|password=|cookie|data:|raw markdown|fixture(?: payload| id)?|provider(?: diagnostic| error)|asset:\/\/|glyphquire-spec|eyJ[\w-]{10,}\.[\w-]{10,}\.[\w-]{10,}|(?:api[_-]?key|secret|access[_-]?key)\s*=|(?:^|\n)\s{0,3}(?:#{1,6}\s+\S|```|[-*+]\s+\S|>\s+\S))/imu,
  );
}

async function openTool(page: Page, label: string): Promise<void> {
  await page.getByRole("button", { name: "Open command palette" }).click();
  const palette = page.getByRole("dialog", { name: "Command palette" });
  await palette.getByRole("textbox", { name: "Filter commands" }).fill(label);
  await expect(palette.getByRole("option", { name: label })).toBeVisible();
  await page.keyboard.press("Enter");
}

test("captures the four README demo scenes", async ({ page }) => {
  mkdirSync("docs/assets/readme", { recursive: true });

  await page.route("**/api/v1/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());

    if (url.pathname === "/api/v1/search") {
      return apiJson(route, 200, {
        items: [
          {
            noteId: SEARCH_NOTE_ID,
            workspaceId: WORKSPACE_ID,
            revision: 2,
            title: "Semantic blocks",
            snippet: "A focused result with a plain-text preview.",
            score: 1,
            rankingVersion: "relevance",
            updatedAt: NOW,
          },
        ],
        nextCursor: null,
      });
    }

    if (url.pathname === `/api/v1/workspaces/${WORKSPACE_ID}/import`) {
      return apiJson(route, 202, {
        id: IMPORT_ID,
        workspaceId: WORKSPACE_ID,
        status: "completed",
        progress: {
          completedItems: 1,
          totalItems: 1,
          processedBytes: 8,
          totalBytes: 8,
        },
      });
    }

    if (url.pathname === `/api/v1/workspaces/${WORKSPACE_ID}/export`) {
      return apiJson(route, 202, {
        id: EXPORT_ID,
        workspaceId: WORKSPACE_ID,
        status: "completed",
        format: "markdown",
        scope: { type: "workspace", workspaceId: WORKSPACE_ID },
        createdAt: NOW,
        expiresAt: "2026-08-30T01:00:00.000Z",
      });
    }

    return apiJson(route, 404, {
      error: {
        code: "NOTE_NOT_FOUND",
        message: "Unavailable",
        requestId: "66666666-6666-4666-8666-666666666666",
      },
    });
  });

  await page.goto("/__readme-demo?scene=modes");
  await expect(page.getByRole("button", { name: "Open command palette" })).toBeVisible();
  await expect(page.getByRole("tabpanel", { name: /editor$/u })).toBeVisible();
  await expect(page.getByRole("radiogroup", { name: "Editor mode" })).toBeVisible();
  await expect(page.getByRole("radio", { name: "Source" })).toBeVisible();
  await expect(page.getByRole("radio", { name: "Visual" })).toBeVisible();
  await expect(page.getByRole("radio", { name: "Split" })).toBeVisible();
  await page.getByRole("button", { name: "Open command palette" }).click();
  const palette = page.getByRole("dialog", { name: "Command palette" });
  for (const label of [
    "Switch to Visual mode",
    "Manage assets",
    "Search notes",
    "Import or export",
    "Create read-only share link",
  ]) {
    await expect(palette.getByRole("option", { name: label })).toBeVisible();
  }
  await page.keyboard.press("Escape");
  await assertDemoDomSafe(page);
  await page.screenshot({ path: "docs/assets/readme/01-editor-modes.png", fullPage: false });

  await page.goto("/__readme-demo?scene=semantic");
  await expect(page.getByRole("heading", { name: "Semantic blocks" })).toBeVisible();
  await expect(page.getByTestId("readme-semantic-editor")).toBeVisible();
  for (const block of ["callout", "toggle", "tabs", "columns"]) {
    await expect(page.locator(`[data-glyphquire-node="${block}"]`).first()).toBeVisible();
  }
  await assertDemoDomSafe(page);
  await page.screenshot({ path: "docs/assets/readme/02-semantic-blocks.png", fullPage: false });

  await page.goto("/__readme-demo?scene=tools");
  const search = page.getByRole("region", { name: "Search notes" });
  await expect(search.getByRole("searchbox", { name: "Search notes" })).toBeVisible();
  await search.getByRole("searchbox", { name: "Search notes" }).fill("blocks");
  await search.getByRole("button", { name: "Run search" }).click();
  await expect(search.getByText("A focused result with a plain-text preview.")).toBeVisible();
  const transfer = page.getByRole("region", { name: "Import and export" });
  await expect(transfer).toBeVisible();
  await expect(transfer.getByLabel("Import Markdown or ZIP")).toBeVisible();
  await transfer.getByLabel("Import Markdown or ZIP").setInputFiles({
    name: "demo.md",
    mimeType: "text/markdown",
    buffer: Buffer.from("safe demo", "utf8"),
  });
  await transfer.getByRole("button", { name: "Start import" }).click();
  await expect(transfer.getByText("Import: completed")).toBeVisible();
  await transfer.getByRole("button", { name: "Export workspace", exact: true }).click();
  await expect(transfer.getByText("Export markdown: completed")).toBeVisible();
  await assertDemoDomSafe(page);
  await page.screenshot({ path: "docs/assets/readme/03-search-transfer.png", fullPage: false });

  await page.goto(`/workspace/${WORKSPACE_ID}?noteId=${NOTE_ID}`);
  await openTool(page, "Create read-only share link");
  const share = page.getByRole("dialog", { name: "Share link" });
  await expect(share.getByRole("button", { name: "Create share link" })).toBeVisible();
  await share.getByRole("button", { name: "Close Phase 5 tools" }).click();

  await page.goto("/__readme-demo");
  await expect(page.getByRole("heading", { name: "Sharing and maintenance" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Share link" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Administrative maintenance" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Maintenance", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Start search rebuild" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Run asset cleanup" })).toBeVisible();
  await page.getByRole("button", { name: "Refresh maintenance diagnostics" }).click();
  await expect(page.getByRole("region", { name: "Dead-letter jobs" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Backup verification" })).toBeVisible();
  await assertDemoDomSafe(page);
  await page.screenshot({ path: "docs/assets/readme/04-sharing-maintenance.png", fullPage: false });
});
