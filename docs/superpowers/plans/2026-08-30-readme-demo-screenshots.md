# README Demo Screenshots Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Capture four deterministic Chrome demo screenshots and present them in a responsive four-cell README gallery.

**Architecture:** Reuse the existing Vite/Playwright web server and route fixtures instead of requiring PostgreSQL, MinIO, or credentials. A dedicated E2E spec drives the existing Workbench tools, while a small demo-only maintenance mount exposes the already-tested administrative panel for the fourth capture without changing production authorization behavior.

**Tech Stack:** Vue 3, Vite 8, Playwright, TypeScript, Markdown, PNG.

## Global Constraints

- Use only same-origin, sanitized fixture responses; never store credentials, cookies, tokens, presigned URLs, provider diagnostics, or real note content.
- Use a fixed 1440×900 viewport and deterministic UUIDs/labels.
- Store images only under `docs/assets/readme/` and reference them with relative paths.
- Keep README edits limited to the demo gallery and its short caption/attribution note.

---

### Task 1: Add deterministic screenshot fixture

**Files:**
- Create: `tests/e2e/readme-demo.spec.ts`
- Create: `apps/web/src/pages/ReadmeDemoPage.vue`
- Modify: `apps/web/src/router/index.ts` to register `/__readme-demo` only when `import.meta.env.DEV` is true

**Interfaces:**
- Consume existing command labels (`Switch to Visual mode`, `Manage assets`, `Search notes`, `Import or export`, `Create read-only share link`) and Phase5 route contracts.
- Produce four files through `page.screenshot({ path })` and fail if any required label is absent.

- [ ] **Step 1: Write the failing capture assertions.**

```ts
import { expect, test } from "@playwright/test";

test.use({ viewport: { width: 1440, height: 900 } });

test("captures the four README demo scenes", async ({ page }) => {
  await page.goto("/workspace/11111111-1111-4111-8111-111111111111?noteId=22222222-2222-4222-8222-222222222222");
  await expect(page.getByRole("button", { name: "Open command palette" })).toBeVisible();
  await expect(page.getByRole("tabpanel", { name: /editor$/u })).toBeVisible();
  await page.screenshot({ path: "docs/assets/readme/01-editor-modes.png", fullPage: false });
});
```

- [ ] **Step 2: Run the capture spec to verify the missing-output failure.**

Run: `pnpm exec playwright test tests/e2e/readme-demo.spec.ts --project=e2e`

Expected: FAIL because the spec and four output files do not yet exist.

- [ ] **Step 3: Implement all four scenes.**

Use one `page.route("**/api/v1/**", ...)` fixture with fixed UUIDs and sanitized response bodies. For each scene, assert the accessible label before capture:

```ts
await openTool(page, "Search notes");
await expect(page.getByRole("dialog", { name: "Search notes" })).toBeVisible();
await page.screenshot({ path: "docs/assets/readme/03-search-transfer.png" });
```

Capture scene 1 from the Workbench, scene 2 from a rendered canonical note containing callout/toggle/tabs/columns, scene 3 from the search/transfer tools, and scene 4 from share plus `ReadmeDemoPage` rendering `Phase5MaintenancePanel` with an injected fixture client. The `/__readme-demo` route is compiled only in development and still uses the panel's capability response; it is not an authorization bypass or production route. Do not include raw API payloads in visible text. The spec must create the directory with `mkdirSync("docs/assets/readme", { recursive: true })` before screenshots.

- [ ] **Step 4: Run the capture spec and inspect file bounds.**

Run: `pnpm exec playwright test tests/e2e/readme-demo.spec.ts --project=e2e`

Expected: 4 tests pass; each PNG is non-empty and `file docs/assets/readme/*.png` reports PNG images at 1440×900 or a bounded crop.

- [ ] **Step 5: Commit the capture fixture and assets.**

```bash
git add tests/e2e/readme-demo.spec.ts apps/web/src/pages/ReadmeDemoPage.vue apps/web/src/router/index.ts docs/assets/readme
git commit -m "docs: capture README product demos"
```

### Task 2: Add the four-cell README gallery

**Files:**
- Modify: `README.md` immediately after `## What is GlyphQuire`
- Create: `tests/e2e/readme-gallery-render.spec.ts`
- Test: `tests/e2e/readme-demo.spec.ts` (reuse the capture assertions)

**Interfaces:**
- Consume `docs/assets/readme/01-editor-modes.png` through `04-sharing-maintenance.png`.
- Produce a GitHub-compatible HTML table with four relative image links and captions.

- [ ] **Step 1: Write the gallery markup.**

```md
## Product Demo

<table>
  <tr>
    <td align="center"><img src="docs/assets/readme/01-editor-modes.png" alt="Visual and Source editing modes" width="100%"><br><sub>Visual / Source editing</sub></td>
    <td align="center"><img src="docs/assets/readme/02-semantic-blocks.png" alt="Semantic Markdown blocks" width="100%"><br><sub>Callout, Toggle, Tabs, Columns</sub></td>
    <td align="center"><img src="docs/assets/readme/03-search-transfer.png" alt="Search and import/export tools" width="100%"><br><sub>Search and transfer</sub></td>
    <td align="center"><img src="docs/assets/readme/04-sharing-maintenance.png" alt="Read-only sharing and maintenance" width="100%"><br><sub>Sharing and maintenance</sub></td>
  </tr>
</table>

_Screenshots are deterministic local-demo captures; they contain no production data._
```

- [ ] **Step 2: Run Markdown formatting and link checks.**

Run: `pnpm format:check && test "$(rg -c 'docs/assets/readme/0[1-4]-.*\\.png' README.md)" -eq 4`

Expected: formatting passes and exactly four image paths are found.

- [ ] **Step 3: Add the desktop/narrow rendering test.**

```ts
import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";

const images = [
  ["docs/assets/readme/01-editor-modes.png", "Visual / Source editing"],
  ["docs/assets/readme/02-semantic-blocks.png", "Callout, Toggle, Tabs, Columns"],
  ["docs/assets/readme/03-search-transfer.png", "Search and transfer"],
  ["docs/assets/readme/04-sharing-maintenance.png", "Sharing and maintenance"],
] as const;

function readmeGalleryHtml(readme: string): string {
  for (const [path, caption] of images) expect(readme).toContain(path);
  return `<table><tr>${images
    .map(([path, caption]) => {
      const data = readFileSync(path).toString("base64");
      return `<td><img src="data:image/png;base64,${data}" alt="${caption}"><br><span>${caption}</span></td>`;
    })
    .join("")}</tr></table>`;
}

for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
  test(`README gallery renders at ${viewport.width}px`, async ({ page }) => {
    await page.setViewportSize(viewport);
    const readme = readFileSync("README.md", "utf8");
    await page.setContent(`<main style="width:100%;overflow-x:hidden"><style>table{width:100%;table-layout:fixed}img{max-width:100%;height:auto}</style>${readmeGalleryHtml(readme)}</main>`);
    await expect(page.locator("main img")).toHaveCount(4);
    await expect(page.locator("main img").first()).toBeVisible();
    for (const [, caption] of images) await expect(page.getByText(caption)).toBeVisible();
    const bounds = await page.locator("main").evaluate((element) => ({
      scrollWidth: element.scrollWidth,
      clientWidth: element.clientWidth,
    }));
    expect(bounds.scrollWidth).toBeLessThanOrEqual(bounds.clientWidth);
  });
}
```

The helper must extract only the checked-in table and render its relative image
paths as local file URLs; it must assert all four captions are visible. This
test is a renderer smoke check, not a claim that GitHub's production renderer
has been replaced.

- [ ] **Step 4: Commit the README gallery.**

```bash
git add README.md tests/e2e/readme-gallery-render.spec.ts
git commit -m "docs: add README product demo gallery"
```

### Task 3: Verify the documentation deliverable

**Files:**
- Test: `tests/e2e/readme-demo.spec.ts`
- Verify: `README.md`, `docs/assets/readme/*.png`

- [ ] **Step 1: Run the complete documentation gate.**

Run: `pnpm exec playwright test tests/e2e/readme-demo.spec.ts --project=e2e && pnpm format:check && git diff --check`

Expected: four capture tests pass, Markdown formatting passes, and the diff is clean.

- [ ] **Step 2: Inspect image metadata and secret safety.**

Run: `file docs/assets/readme/*.png && if rg -n -i 'token=|bearer |presigned|postgresql://|password=|cookie' tests/e2e/readme-demo.spec.ts apps/web/src/pages/ReadmeDemoPage.vue; then exit 1; fi && pnpm exec playwright test tests/e2e/readme-gallery-render.spec.ts --project=e2e`

Expected: all images are PNGs; the search returns no credential, URL, or raw-payload match; the gallery's four links render at both 1440px and a 390px viewport with visible captions and no horizontal overflow.
