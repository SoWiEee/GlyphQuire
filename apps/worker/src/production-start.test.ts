import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("built worker production artifact", () => {
  it.each([
    ["packages/queue/package.json", ".", "./src/index.ts", "./dist/index.js"],
    [
      "packages/api-contract/package.json",
      "./jobs",
      "./src/jobs/index.ts",
      "./dist/jobs/index.js",
    ],
  ])(
    "publishes Node-resolvable JavaScript from %s %s",
    async (packagePath, exportName, sourcePath, distributionPath) => {
    const manifest = JSON.parse(
      await readFile(new URL(`../../../${packagePath}`, import.meta.url), "utf8"),
    ) as { exports: Record<string, unknown> };

    expect(manifest.exports[exportName]).toEqual({
      types: sourcePath,
      development: sourcePath,
      import: distributionPath,
      default: distributionPath,
    });
    },
  );
});
