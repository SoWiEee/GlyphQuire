import { readFile } from "node:fs/promises";
import { unified } from "unified";
import remarkDirective from "remark-directive";
import remarkParse from "remark-parse";
import { describe, expect, it } from "vitest";

describe("README directive examples", () => {
  it("keeps headings after nested directive fences as headings", async () => {
    const readme = await readFile(new URL("../../../../README.md", import.meta.url), "utf8");
    const tree = unified().use(remarkParse).use(remarkDirective).parse(readme);
    const headings = tree.children
      .filter((node) => node.type === "heading")
      .map((node) =>
        node.children
          ?.filter((child) => child.type === "text")
          .map((child) => child.value)
          .join(""),
      );

    expect(headings).toEqual(expect.arrayContaining(["特色", "Callout", "Interactive Runtime"]));
  });

  it("closes nested runtime code fences before directive closers", async () => {
    const readme = await readFile(new URL("../../../../README.md", import.meta.url), "utf8");
    const canvasExample = readme.match(/:::canvas[\s\S]*?互動程式碼/iu)?.[0];

    expect(canvasExample).toMatch(/```js[\s\S]*?```\s*:::/u);
  });
});
