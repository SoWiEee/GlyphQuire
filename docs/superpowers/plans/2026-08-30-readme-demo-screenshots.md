# README Demo Screenshots Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Capture four deterministic Chrome demo screenshots and present them in a responsive four-cell README gallery.

**Architecture:** Reuse the existing Vite/Playwright web server and route fixtures instead of requiring PostgreSQL, MinIO, or credentials. A dedicated E2E spec drives the existing Workbench tools, while a small demo-only maintenance mount exposes the already-tested administrative panel for the fourth capture without changing production authorization behavior.

**Tech Stack:** Vue 3, Vite 8, Playwright, TypeScript, Markdown, PNG.

## Global Constraints

- Use only same-origin, sanitized fixture responses; never store credentials, cookies, tokens, presigned URLs, provider diagnostics, or real note content.
- Use a fixed 1440×900 viewport and deterministic UUIDs/labels.
- Store exactly four images at `docs/assets/readme/01-editor-modes.png`,
  `02-semantic-blocks.png`, `03-search-transfer.png`, and
  `04-sharing-maintenance.png`; do not stage the directory as a wildcard.
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
- Before every screenshot, run `assertDemoDomSafe(page)` over `body.innerText`, all
  visible text nodes, and every attribute value; reject secrets, cookies, token
  formats, provider diagnostics, URLs, raw Markdown, and fixture payloads.

- [ ] **Step 1: Write the failing capture assertions.**

````ts
import { deflateSync, inflateSync } from "node:zlib";
import { expect, test } from "@playwright/test";

test.use({ viewport: { width: 1440, height: 900 } });

async function assertDemoDomSafe(page: import("@playwright/test").Page): Promise<void> {
  const exposed = await page.locator("body").evaluate((body) => ({
    text: body.innerText,
    attributes: Array.from(body.querySelectorAll("*")).flatMap((element) =>
      Array.from(element.attributes, (attribute) => attribute.value),
    ),
  }));
  const combined = [exposed.text, ...exposed.attributes].join("\n");
  expect(combined).not.toMatch(
    /(?:token=|bearer |presigned|https?:\/\/|file:\/\/|mailto:|postgresql:\/\/|s3[.-]|password=|cookie|data:|raw markdown|fixture(?: payload| id)?|provider(?: diagnostic| error)|accessdenied|signaturedoesnotmatch|asset:\/\/|glyphquire-spec|eyJ[\w-]{10,}\.[\w-]{10,}\.[\w-]{10,}|(?:ghp_|github_pat_|sk-(?:live|proj)-|xox[baprs]-|AIza[\w-]{20,})[\w-]+|(?:api[_-]?key|secret|access[_-]?key)\s*=|(?:^|\n)\s{0,3}(?:#{1,6}\s+\S|```|[-*+]\s+\S|>\s+\S)|\*\*[^*\n]+\*\*|\[[^\]\n]+\]\([^)]*\))/imu,
  );
}

test("captures the four README demo scenes", async ({ page }) => {
  await page.goto(
    "/workspace/11111111-1111-4111-8111-111111111111?noteId=22222222-2222-4222-8222-222222222222",
  );
  await expect(page.getByRole("button", { name: "Open command palette" })).toBeVisible();
  await expect(page.getByRole("tabpanel", { name: /editor$/u })).toBeVisible();
  await assertDemoDomSafe(page);
  await page.screenshot({ path: "docs/assets/readme/01-editor-modes.png", fullPage: false });
});
````

- [ ] **Step 2: Run the capture spec to verify the missing-output failure.**

Run: `pnpm exec playwright test tests/e2e/readme-demo.spec.ts --project=e2e`

Expected: FAIL because the spec and four output files do not yet exist.

- [ ] **Step 3: Implement all four scenes.**

Use one `page.route("**/api/v1/**", ...)` fixture with fixed UUIDs and sanitized response bodies. For each scene, assert the accessible label before capture:

```ts
await openTool(page, "Search notes");
await expect(page.getByRole("dialog", { name: "Search notes" })).toBeVisible();
await assertDemoDomSafe(page);
await page.screenshot({ path: "docs/assets/readme/03-search-transfer.png" });
```

Capture scene 1 from the Workbench, scene 2 from a rendered canonical note containing callout/toggle/tabs/columns, scene 3 from the search/transfer tools, and scene 4 from share plus `ReadmeDemoPage` rendering `Phase5MaintenancePanel` with an injected fixture client. The `/__readme-demo` route is compiled only in development and still uses the panel's capability response; it is not an authorization bypass or production route. Do not include raw API payloads in visible text. Immediately before every one of the four `page.screenshot` calls, await `assertDemoDomSafe(page)`; the helper scans visible text nodes and attribute values and rejects secrets, URLs, provider diagnostics, raw Markdown, and fixture payloads. The spec must create the directory with `mkdirSync("docs/assets/readme", { recursive: true })` before screenshots.

- [ ] **Step 4: Run the capture spec and inspect file bounds.**

Run: `pnpm exec playwright test tests/e2e/readme-demo.spec.ts --project=e2e`

Expected: the capture test passes and emits four non-empty PNGs; `file docs/assets/readme/*.png` reports PNG images at 1440×900 or a bounded crop.

- [ ] **Step 5: Commit the capture fixture and assets.**

```bash
git add tests/e2e/readme-demo.spec.ts apps/web/src/pages/ReadmeDemoPage.vue apps/web/src/router/index.ts docs/assets/readme/01-editor-modes.png docs/assets/readme/02-semantic-blocks.png docs/assets/readme/03-search-transfer.png docs/assets/readme/04-sharing-maintenance.png
git commit -m "docs: capture README product demos"
```

### Task 2: Add the four-cell README gallery

**Files:**

- Modify: `README.md` immediately after `## What is GlyphQuire`
- Create: `tests/e2e/readme-gallery-render.spec.ts`
- Modify: `package.json` and `pnpm-lock.yaml` to add exact pinned renderer dependencies: `unified@11.0.5`, `remark-parse@11.0.0`, `remark-gfm@4.0.1`, `remark-rehype@11.1.2`, `rehype-raw@7.0.0`, `rehype-sanitize@6.0.0`, and `rehype-stringify@10.0.1`
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

Run: `pnpm format:check && count=$(rg -o 'docs/assets/readme/0[1-4]-[^" ]+\.png' README.md | sort -u | wc -l) && test "$count" -eq 4`

Expected: formatting passes and exactly four image paths are found.

- [ ] **Step 3: Add the desktop/narrow rendering test.**

````ts
import { readFileSync } from "node:fs";
import { inflateSync } from "node:zlib";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkRehype from "remark-rehype";
import rehypeRaw from "rehype-raw";
import rehypeSanitize from "rehype-sanitize";
import rehypeStringify from "rehype-stringify";
import { expect, test } from "@playwright/test";

const images = [
  ["docs/assets/readme/01-editor-modes.png", "Visual / Source editing"],
  ["docs/assets/readme/02-semantic-blocks.png", "Callout, Toggle, Tabs, Columns"],
  ["docs/assets/readme/03-search-transfer.png", "Search and transfer"],
  ["docs/assets/readme/04-sharing-maintenance.png", "Sharing and maintenance"],
] as const;

function checkedInGallery(renderedHtml: string): string {
  const section = renderedHtml.match(/<h2[^>]*>Product Demo<\/h2>[\s\S]*?(?=<h2|$)/u)?.[0];
  const table = section?.match(/<table>[\s\S]*?<\/table>/u)?.[0];
  expect(table).toBeTruthy();
  for (const [path] of images) expect(table).toContain(path);
  return table!;
}

function assertPngSafety(pathOrBytes: string | Buffer): void {
  const bytes = Buffer.isBuffer(pathOrBytes) ? pathOrBytes : readFileSync(pathOrBytes);
  expect(bytes.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  let width = 0;
  let height = 0;
  const text: string[] = [];
  let sawIHDR = false;
  let sawIEND = false;
  for (let offset = 8; offset + 12 <= bytes.length;) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString("ascii", offset + 4, offset + 8);
    expect(offset + 12 + length).toBeLessThanOrEqual(bytes.length);
    const data = bytes.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      expect(offset).toBe(8);
      expect(length).toBe(13);
      expect(sawIHDR).toBe(false);
      sawIHDR = true;
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
    } else if (type === "tEXt") {
      const separator = data.indexOf(0);
      expect(separator).toBeGreaterThan(0);
      expect(data.subarray(0, separator).includes(0)).toBe(false);
      text.push(data.subarray(separator + 1).toString("utf8"));
    } else if (type === "zTXt") {
      const separator = data.indexOf(0);
      expect(separator).toBeGreaterThan(0);
      expect(data[separator + 1]).toBe(0);
      expect(separator).toBeGreaterThan(0);
      text.push(inflateSync(data.subarray(separator + 2)).toString("utf8"));
    } else if (type === "iTXt") {
      const keywordEnd = data.indexOf(0);
      expect(keywordEnd).toBeGreaterThan(0);
      let cursor = keywordEnd + 1;
      const compressed = data[cursor] === 1;
      expect([0, 1]).toContain(data[cursor]);
      expect(data[cursor + 1]).toBe(0);
      cursor += 2;
      const languageEnd = data.indexOf(0, cursor);
      expect(languageEnd).toBeGreaterThanOrEqual(0);
      cursor = languageEnd + 1;
      const translatedEnd = data.indexOf(0, cursor);
      expect(translatedEnd).toBeGreaterThanOrEqual(0);
      cursor = translatedEnd + 1;
      const value = data.subarray(cursor);
      text.push(compressed ? inflateSync(value).toString("utf8") : value.toString("utf8"));
    }
    offset += 12 + length;
    if (type === "IEND") {
      expect(length).toBe(0);
      sawIEND = true;
      expect(offset).toBe(bytes.length);
      break;
    }
  }
  expect(sawIHDR).toBe(true);
  expect(sawIEND).toBe(true);
  expect(width).toBeGreaterThan(0);
  expect(height).toBeGreaterThan(0);
  expect(text.join("\n")).not.toMatch(
    /(?:token=|bearer |presigned|postgresql:\/\/|https?:\/\/|s3[.-]|password=|cookie|provider|diagnostic|document body|raw markdown|fixture(?: payload| id)?|asset:\/\/|#\s|glyphquire-spec|eyJ[\w-]{10,}\.[\w-]{10,}\.[\w-]{10,}|(?:api[_-]?key|secret|access[_-]?key)\s*=)/iu,
  );
}

for (const viewport of [
  { width: 1440, height: 900 },
  { width: 390, height: 844 },
]) {
  test(`README gallery renders at ${viewport.width}px`, async ({ page }) => {
    await page.setViewportSize(viewport);
    const readme = readFileSync("README.md", "utf8");
    for (const [path] of images) assertPngSafety(path);
    const renderedReadme = String(
      await unified()
        .use(remarkParse)
        .use(remarkGfm)
        .use(remarkRehype, { allowDangerousHtml: true })
        .use(rehypeRaw)
        .use(rehypeSanitize)
        .use(rehypeStringify)
        .process(readme),
    );
    const table = checkedInGallery(renderedReadme).replace(/src="([^"]+)"/gu, (_, path: string) => {
      const data = readFileSync(path).toString("base64");
      return `src="data:image/png;base64,${data}"`;
    });
    await page.setContent(`<main>${table}</main>`);
    await expect(page.locator("main img")).toHaveCount(4);
    const imagesInDom = await page.locator("main img").all();
    for (const image of imagesInDom) {
      await expect(image).toBeVisible();
      await expect(image).toHaveJSProperty("complete", true);
      expect(
        await image.evaluate((node) => (node as HTMLImageElement).naturalWidth),
      ).toBeGreaterThan(0);
      expect(
        await image.evaluate((node) => {
          const imageRect = node.getBoundingClientRect();
          const mainRect = node.closest("main")!.getBoundingClientRect();
          return (
            imageRect.left >= mainRect.left &&
            imageRect.right <= mainRect.right &&
            imageRect.top >= 0 &&
            imageRect.left >= 0 &&
            imageRect.right <= window.innerWidth &&
            imageRect.bottom <= window.innerHeight
          );
        }),
      ).toBe(true);
    }
    for (const [, caption] of images) await expect(page.getByText(caption)).toBeVisible();
    const renderedText = await page.locator("main").innerText();
    expect(renderedText).not.toMatch(
      /(?:token=|bearer |presigned|https?:\/\/|postgresql:\/\/|s3[.-]|password=|cookie|data:|raw markdown|fixture(?: payload| id)?|provider(?: diagnostic| error)|asset:\/\/|glyphquire-spec|eyJ[\w-]{10,}\.[\w-]{10,}\.[\w-]{10,}|(?:api[_-]?key|secret|access[_-]?key)\s*=|(?:^|\n)\s{0,3}(?:#{1,6}\s+\S|```|[-*+]\s+\S|>\s+\S))/imu,
    );
    const bounds = await page.locator("main").evaluate((element) => ({
      scrollWidth: element.scrollWidth,
      clientWidth: element.clientWidth,
    }));
    expect(bounds.scrollWidth).toBeLessThanOrEqual(bounds.clientWidth);
  });
}

test("rejects malformed PNG text chunks", () => {
  const malformedOrder = Buffer.from([
    137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0, 73, 69, 78, 68, 0, 0, 0, 0,
  ]);
  const truncatedText = Buffer.from([
    137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 5, 122, 84, 88, 116, 107,
  ]);
  const malformedCompressedItext = Buffer.from([
    137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0, 105, 84, 88, 116,
  ]);
  expect(() => assertPngSafety(malformedOrder)).toThrow();
  expect(() => assertPngSafety(truncatedText)).toThrow();
  expect(() => assertPngSafety(malformedCompressedItext)).toThrow();
});

function chunk(type: string, data: Buffer): Buffer {
  const header = Buffer.alloc(8);
  header.writeUInt32BE(data.length, 0);
  header.write(type, 4, "ascii");
  return Buffer.concat([header, data, Buffer.alloc(4)]);
}

function makePng(chunks: Buffer[]): Buffer {
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), ...chunks]);
}

function validIhdr(width: number, height: number): Buffer {
  const data = Buffer.alloc(13);
  data.writeUInt32BE(width, 0);
  data.writeUInt32BE(height, 4);
  data[8] = 8;
  data[9] = 6;
  return data;
}

test("inflates valid iTXt and rejects text separators, flags, methods, ordering, and truncation", () => {
  const validCompressedItext = makePng([
    chunk("IHDR", validIhdr(1, 1)),
    chunk(
      "iTXt",
      Buffer.concat([
        Buffer.from("comment\\0\\1\\0\\0\\0", "binary"),
        deflateSync(Buffer.from("safe text", "utf8")),
      ]),
    ),
    chunk("IEND", Buffer.alloc(0)),
  ]);
  expect(() => assertPngSafety(validCompressedItext)).not.toThrow();

  const malformed = [
    makePng([
      chunk("IHDR", validIhdr(1, 1)),
      chunk("tEXt", Buffer.from("missing-separator")),
      chunk("IEND", Buffer.alloc(0)),
    ]),
    makePng([
      chunk("IHDR", validIhdr(1, 1)),
      chunk("zTXt", Buffer.from("key\\0\\1not-zlib")),
      chunk("IEND", Buffer.alloc(0)),
    ]),
    makePng([
      chunk("IHDR", validIhdr(1, 1)),
      chunk("iTXt", Buffer.from("key\\0\\2\\0\\0\\0value")),
      chunk("IEND", Buffer.alloc(0)),
    ]),
    makePng([
      chunk("IHDR", validIhdr(1, 1)),
      chunk("iTXt", Buffer.from("key\\0\\1\\1\\0\\0")),
      chunk("IEND", Buffer.alloc(0)),
    ]),
    makePng([
      chunk("IHDR", validIhdr(1, 1)),
      chunk("iTXt", Buffer.from("key\\0\\0\\0\\0\\0truncated")).subarray(0, -1),
      chunk("IEND", Buffer.alloc(0)),
    ]),
    makePng([chunk("IEND", Buffer.alloc(0)), chunk("IHDR", validIhdr(1, 1))]),
  ];
  for (const bytes of malformed) expect(() => assertPngSafety(bytes)).toThrow();
});
````

The helper must run the checked-in README through a GFM-compatible
`remark-parse`/`remark-gfm`/`remark-rehype`/`rehype-raw`/`rehype-sanitize`
pipeline, extract only the rendered `Product Demo` table, and resolve its
relative image paths to local data URLs. It must assert all four images are
loaded, visible, have non-zero natural dimensions, and remain in-bounds at both
viewports. Before rendering, `assertPngSafety` must verify the PNG signature and
IHDR dimensions and decode every `tEXt`, `iTXt`, and `zTXt` chunk, rejecting
credential, URL, provider-diagnostic, or note-content patterns. This
test is a renderer smoke check, not a claim that GitHub's production renderer
has been replaced.

- [ ] **Step 4: Commit the README gallery.**

```bash
git add README.md tests/e2e/readme-gallery-render.spec.ts package.json pnpm-lock.yaml
git commit -m "docs: add README product demo gallery"
```

### Task 3: Verify the documentation deliverable

**Files:**

- Test: `tests/e2e/readme-demo.spec.ts`
- Verify: `README.md`, `docs/assets/readme/*.png`

- [ ] **Step 1: Run the complete documentation gate.**

Run: `pnpm exec playwright test tests/e2e/readme-demo.spec.ts --project=e2e && pnpm exec playwright test tests/e2e/readme-gallery-render.spec.ts --project=e2e && pnpm format:check && git diff --check`

Expected: four capture tests pass, Markdown formatting passes, and the diff is clean.

- [ ] **Step 2: Inspect image metadata and secret safety.**

Run: `pnpm exec playwright test tests/e2e/readme-demo.spec.ts --project=e2e && sha256sum docs/assets/readme/01-editor-modes.png docs/assets/readme/02-semantic-blocks.png docs/assets/readme/03-search-transfer.png docs/assets/readme/04-sharing-maintenance.png > /tmp/readme-demo-before.sha256 && pnpm exec playwright test tests/e2e/readme-demo.spec.ts --project=e2e && sha256sum -c /tmp/readme-demo-before.sha256 && file docs/assets/readme/01-editor-modes.png docs/assets/readme/02-semantic-blocks.png docs/assets/readme/03-search-transfer.png docs/assets/readme/04-sharing-maintenance.png && if rg -n -i 'token=|bearer |presigned|postgresql://|password=|cookie' apps/web/src/pages/ReadmeDemoPage.vue apps/web/src/router/index.ts; then exit 1; fi && pnpm exec playwright test tests/e2e/readme-gallery-render.spec.ts --project=e2e && git diff --exit-code -- docs/assets/readme/01-editor-modes.png docs/assets/readme/02-semantic-blocks.png docs/assets/readme/03-search-transfer.png docs/assets/readme/04-sharing-maintenance.png`

Expected: all images are PNGs; the demo page/router source has no credential, URL, or raw-payload match; each scene's live DOM is scrubbed immediately before capture; the gallery's four links render at both 1440px and a 390px viewport with visible captions and no horizontal overflow. The renderer smoke test also verifies PNG signatures, IHDR dimensions/order, terminal IEND, malformed/truncated/text-chunk rejection, and that decoded PNG text chunks contain no credential/content patterns; it never hides overflow with CSS and it renders the checked-in table rather than a synthetic replacement.
