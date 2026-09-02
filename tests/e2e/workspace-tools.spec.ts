import { expect, test, type Page, type Route } from "@playwright/test";

const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
const NOTE_ID = "22222222-2222-4222-8222-222222222222";
const SEARCH_NOTE_ID = "33333333-3333-4333-8333-333333333333";
const ASSET_ID = "44444444-4444-4444-8444-444444444444";
const IMPORT_ID = "55555555-5555-4555-8555-555555555555";
const EXPORT_ID = "66666666-6666-4666-8666-666666666666";
const SHARE_ID = "77777777-7777-4777-8777-777777777777";
const SHARE_TOKEN = "workspaceToolsReadOnlyToken_abcdefghijklmnopqrstuvwxyz";
const NOW = "2026-08-30T00:00:00.000Z";

function json(route: Route, status: number, body: unknown): Promise<void> {
  return route.fulfill({
    status,
    contentType: "application/json",
    headers: { "cache-control": "no-store" },
    body: JSON.stringify(body),
  });
}

async function openTool(page: Page, label: string): Promise<void> {
  await page.locator("header").getByRole("button", { name: "Open command palette" }).click();
  const palette = page.getByRole("dialog", { name: "Command palette" });
  await palette.getByRole("textbox", { name: "Filter commands" }).fill(label);
  await page.keyboard.press("Enter");
}

async function openPage(page: Page, label: "Search" | "Shared" | "Transfer"): Promise<void> {
  await page.getByRole("tab", { name: label, exact: true }).click();
  await expect(page.locator(`#workbench-page-${label.toLowerCase()}`)).toBeVisible();
}

test.describe("Workspace tools browser acceptance adapter", () => {
  test("drives upload, search, import/export, share, revoke, and anonymous 404", async ({
    page,
  }) => {
    let revoked = false;
    const observed = new Set<string>();

    await page.route("**/api/v1/**", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      const key = `${request.method()} ${url.pathname}`;
      observed.add(key);

      if (url.pathname === `/api/v1/workspaces/${WORKSPACE_ID}/assets`) {
        expect(request.method()).toBe("POST");
        expect(request.headers()["authorization"]).toBeUndefined();
        expect(request.headers()["x-request-id"]).toMatch(/^[0-9a-f-]{36}$/u);
        expect(request.headers()["idempotency-key"]).toBeTruthy();
        expect(request.headers()["content-type"]).toContain("multipart/form-data");
        return json(route, 201, {
          id: ASSET_ID,
          workspaceId: WORKSPACE_ID,
          originalName: "pixel.png",
          mimeType: "image/png",
          size: 8,
          sha256: "a".repeat(64),
          createdAt: NOW,
          deletedAt: null,
          thumbnailStatus: "pending",
        });
      }
      if (url.pathname === "/api/v1/search") {
        expect(url.searchParams.get("workspaceId")).toBe(WORKSPACE_ID);
        expect(url.searchParams.get("q")).toBe("needle");
        return json(route, 200, {
          items: [
            {
              noteId: SEARCH_NOTE_ID,
              workspaceId: WORKSPACE_ID,
              revision: 2,
              title: "Search result",
              snippet: "Safe plain-text snippet",
              score: 1,
              rankingVersion: "relevance",
              updatedAt: NOW,
            },
          ],
          nextCursor: null,
        });
      }
      if (url.pathname === `/api/v1/workspaces/${WORKSPACE_ID}/import`) {
        expect(request.method()).toBe("POST");
        expect(request.headers()["content-type"]).toContain("multipart/form-data");
        return json(route, 202, {
          id: IMPORT_ID,
          workspaceId: WORKSPACE_ID,
          noteId: NOTE_ID,
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
        expect(request.method()).toBe("POST");
        return json(route, 202, {
          id: EXPORT_ID,
          workspaceId: WORKSPACE_ID,
          status: "completed",
          format: "markdown",
          scope: { type: "workspace", workspaceId: WORKSPACE_ID },
          createdAt: NOW,
          expiresAt: "2026-08-30T01:00:00.000Z",
        });
      }
      if (url.pathname === `/api/v1/notes/${NOTE_ID}/share-links`) {
        expect(request.method()).toBe("POST");
        return json(route, 201, {
          id: SHARE_ID,
          workspaceId: WORKSPACE_ID,
          noteId: NOTE_ID,
          token: SHARE_TOKEN,
          url: `${url.origin}/api/v1/shared/${SHARE_TOKEN}`,
          expiresAt: null,
          createdAt: NOW,
        });
      }
      if (url.pathname === `/api/v1/share-links/${SHARE_ID}`) {
        expect(request.method()).toBe("DELETE");
        revoked = true;
        return route.fulfill({ status: 204, body: "" });
      }
      if (url.pathname === `/api/v1/shared/${SHARE_TOKEN}`) {
        return revoked
          ? json(route, 404, {
              error: {
                code: "SHARE_NOT_FOUND",
                message: "Share link not found",
                requestId: "88888888-8888-4888-8888-888888888888",
              },
            })
          : json(route, 200, {
              noteId: NOTE_ID,
              title: "Read-only projection",
              contentMarkdown: "# Read only",
              schemaVersion: 1,
              updatedAt: NOW,
            });
      }
      return json(route, 404, {
        error: {
          code: "NOTE_NOT_FOUND",
          message: "Not found",
          requestId: "99999999-9999-4999-8999-999999999999",
        },
      });
    });

    // The public workspace route is intentionally unauthenticated. The local
    // demo route supplies the validated session/workspace fixture needed by
    // Workspace tools panels without weakening production route authorization.
    await page.goto("/__readme-demo?scene=modes");

    await openTool(page, "Manage assets");
    const assets = page.getByRole("dialog", { name: "Asset manager" });
    await assets.getByLabel("Asset file").setInputFiles({
      name: "pixel.png",
      mimeType: "image/png",
      buffer: Buffer.from("89504e470d0a1a0a", "hex"),
    });
    await assets.getByRole("button", { name: "Upload asset" }).click();
    await expect(page.getByTestId("source-editor-host").locator(".cm-content")).toContainText(
      `asset://${ASSET_ID}`,
    );
    await expect(assets).toHaveCount(0);

    await openPage(page, "Search");
    const search = page.locator("#workbench-page-search").getByRole("region", {
      name: "Search notes",
    });
    await search.getByRole("searchbox", { name: "Search notes" }).fill("needle");
    await search.getByRole("button", { name: "Run search" }).click();
    await expect(search.getByText("Safe plain-text snippet")).toBeVisible();
    await expect(search.locator("img,script")).toHaveCount(0);

    await openPage(page, "Transfer");
    const transfer = page.locator("#workbench-page-transfer").getByRole("region", {
      name: "Import and export",
    });
    await transfer.getByLabel("Import Markdown or ZIP").setInputFiles({
      name: "bounded.md",
      mimeType: "text/markdown",
      buffer: Buffer.from("# Import", "utf8"),
    });
    await transfer.getByRole("button", { name: "Start import" }).click();
    await expect(transfer.getByText("Import complete")).toBeVisible();
    await transfer.getByRole("button", { name: "Export workspace", exact: true }).click();
    await expect(transfer.getByText("Markdown export ready")).toBeVisible();

    await openPage(page, "Shared");
    const share = page.locator("#workbench-page-shared").getByRole("region", {
      name: "Share link",
    });
    await share.getByRole("button", { name: "Create share link" }).click();
    await expect(share.getByRole("link", { name: "Read-only share link" })).toHaveAttribute(
      "rel",
      /noopener/u,
    );
    await share.getByRole("button", { name: "Revoke share link" }).click();
    await expect(share.getByRole("link", { name: "Read-only share link" })).toHaveCount(0);

    const sharedStatus = await page.evaluate(async (token) => {
      const response = await fetch(`/api/v1/shared/${token}`, { cache: "no-store" });
      return response.status;
    }, SHARE_TOKEN);
    expect(sharedStatus).toBe(404);

    expect(observed).toEqual(
      expect.objectContaining({
        size: expect.any(Number),
      }),
    );
    expect(observed).toContain(`POST /api/v1/workspaces/${WORKSPACE_ID}/assets`);
    expect(observed).toContain("GET /api/v1/search");
    expect(observed).toContain(`POST /api/v1/workspaces/${WORKSPACE_ID}/import`);
    expect(observed).toContain(`POST /api/v1/workspaces/${WORKSPACE_ID}/export`);
    expect(observed).toContain(`DELETE /api/v1/share-links/${SHARE_ID}`);
  });

  test("renders a stable permission denial without provider diagnostics or note content", async ({
    page,
  }) => {
    const secret = "provider-token-do-not-render";
    await page.route("**/api/v1/**", (route) =>
      json(route, 404, {
        error: {
          code: "NOTE_NOT_FOUND",
          message: `storage says ${secret}: # private markdown`,
          requestId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        },
      }),
    );
    // Keep the permission-denial flow on the same authenticated fixture while
    // replacing only its API responses with the denied projection.
    await page.goto("/__readme-demo?scene=modes");
    await openPage(page, "Search");
    const search = page.locator("#workbench-page-search").getByRole("region", {
      name: "Search notes",
    });
    await search.getByRole("searchbox", { name: "Search notes" }).fill("denied");
    await search.getByRole("button", { name: "Run search" }).click();
    await expect(search.getByRole("alert")).toHaveText(
      "You do not have permission, or the item is unavailable.",
    );
    await expect(page.getByText(secret)).toHaveCount(0);
    await expect(page.getByText("# private markdown")).toHaveCount(0);
  });
});
