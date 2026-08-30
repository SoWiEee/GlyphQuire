import { readFileSync } from "node:fs";
import { deflateSync, inflateSync } from "node:zlib";
import { expect, test } from "@playwright/test";
import { unified } from "unified";
import rehypeRaw from "rehype-raw";
import rehypeSanitize from "rehype-sanitize";
import rehypeStringify from "rehype-stringify";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";

const images = [
  ["docs/assets/readme/01-editor-modes.png", "Visual / Source editing"],
  ["docs/assets/readme/02-semantic-blocks.png", "Callout, Toggle, Tabs, Columns"],
  ["docs/assets/readme/03-search-transfer.png", "Search and transfer"],
  ["docs/assets/readme/04-sharing-maintenance.png", "Sharing and maintenance"],
] as const;

const unsafeElementPattern = /<(?:embed|form|iframe|object|script|style|svg)\b/iu;
const unsafeAttributePattern = /\s(?:on[a-z]+|formaction|srcdoc|xlink:href)\s*=/iu;
const unsafeProtocolPattern = /^(?:data|javascript|vbscript):/iu;

function renderReadme(): Promise<string> {
  const readme = readFileSync("README.md", "utf8");
  return unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkRehype, { allowDangerousHtml: true })
    .use(rehypeRaw)
    .use(rehypeSanitize)
    .use(rehypeStringify)
    .process(readme)
    .then(String);
}

function checkedInGallery(renderedHtml: string): string {
  const section = renderedHtml.match(/<h2[^>]*>Product Demo<\/h2>[\s\S]*?(?=<h2|$)/u)?.[0];
  expect(section).toBeTruthy();
  const table = section?.match(/<table>[\s\S]*?<\/table>/u)?.[0];
  expect(table).toBeTruthy();
  for (const [path, caption] of images) {
    expect(table).toContain(path);
    expect(table).toContain(caption);
  }
  return table ?? "";
}

function attributeValues(renderedHtml: string, tagName: string, attributeName: string): string[] {
  const tagPattern = new RegExp(`<${tagName}\\b[^>]*>`, "giu");
  const attributePattern = new RegExp(`\\s${attributeName}="([^"]*)"`, "iu");
  return [...renderedHtml.matchAll(tagPattern)]
    .map((match) => match[0].match(attributePattern)?.[1])
    .filter((value): value is string => value !== undefined);
}

function assertGallerySafety(table: string): void {
  expect(table).not.toMatch(unsafeElementPattern);
  expect(table).not.toMatch(unsafeAttributePattern);

  const imageSources = attributeValues(table, "img", "src");
  expect(imageSources).toEqual(images.map(([path]) => path));
  for (const source of imageSources) {
    expect(source).toMatch(/^docs\/assets\/readme\/0[1-4]-[a-z-]+\.png$/u);
    expect(source).not.toMatch(/^(?:[a-z][a-z\d+.-]*:|\/\/)/iu);
    expect(source).not.toMatch(unsafeProtocolPattern);
  }

  for (const href of attributeValues(table, "a", "href")) {
    expect(href).not.toMatch(unsafeProtocolPattern);
    expect(href).toMatch(/^(?:\.{0,2}\/|#[^\s]+|https?:\/\/)/iu);
  }
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

async function checkedInGalleryTable(): Promise<string> {
  const renderedReadme = await renderReadme();
  const table = checkedInGallery(renderedReadme);
  assertGallerySafety(table);
  return table.replace(/src="([^"]+)"/gu, (_, path: string) => {
    expect(images.map(([imagePath]) => imagePath)).toContain(path);
    const data = readFileSync(path).toString("base64");
    return `src="data:image/png;base64,${data}"`;
  });
}

for (const viewport of [
  { width: 1440, height: 900 },
  { width: 390, height: 844 },
]) {
  test(`README gallery renders at ${viewport.width}px`, async ({ page }) => {
    await page.setViewportSize(viewport);
    for (const [path] of images) assertPngSafety(path);

    const table = await checkedInGalleryTable();
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

test("sanitizes unsafe gallery HTML and link/image protocols", async () => {
  const hostileReadme = [
    "## Product Demo",
    "",
    '<table><tr><td><script>alert(1)</script><img src="javascript:alert(1)" onerror="alert(2)"><a href="javascript:alert(3)" formaction="/evil">unsafe</a></td></tr></table>',
  ].join("\n");
  const rendered = String(
    await unified()
      .use(remarkParse)
      .use(remarkGfm)
      .use(remarkRehype, { allowDangerousHtml: true })
      .use(rehypeRaw)
      .use(rehypeSanitize)
      .use(rehypeStringify)
      .process(hostileReadme),
  );

  expect(rendered).not.toMatch(unsafeElementPattern);
  expect(rendered).not.toMatch(unsafeAttributePattern);
  expect(rendered).not.toMatch(unsafeProtocolPattern);
  expect(attributeValues(rendered, "img", "src")).toEqual([]);
  expect(attributeValues(rendered, "a", "href")).toEqual([]);
});

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

test("inflates valid iTXt and rejects malformed text metadata", () => {
  const validCompressedItext = makePng([
    chunk("IHDR", validIhdr(1, 1)),
    chunk(
      "iTXt",
      Buffer.concat([
        Buffer.from("comment\0\x01\0\0\0", "binary"),
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
      chunk("zTXt", Buffer.from("key\0\x01not-zlib")),
      chunk("IEND", Buffer.alloc(0)),
    ]),
    makePng([
      chunk("IHDR", validIhdr(1, 1)),
      chunk("iTXt", Buffer.from("key\0\x02\0\0\0value")),
      chunk("IEND", Buffer.alloc(0)),
    ]),
    makePng([
      chunk("IHDR", validIhdr(1, 1)),
      chunk("iTXt", Buffer.from("key\0\x01\x01\0\0")),
      chunk("IEND", Buffer.alloc(0)),
    ]),
    makePng([
      chunk("IHDR", validIhdr(1, 1)),
      chunk("iTXt", Buffer.from("key\0\0\0\0\0truncated")).subarray(0, -1),
      chunk("IEND", Buffer.alloc(0)),
    ]),
    makePng([chunk("IEND", Buffer.alloc(0)), chunk("IHDR", validIhdr(1, 1))]),
  ];
  for (const bytes of malformed) expect(() => assertPngSafety(bytes)).toThrow();
});
