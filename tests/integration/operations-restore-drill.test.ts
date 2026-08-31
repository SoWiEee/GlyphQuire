import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const repositoryRoot = new URL("../../", import.meta.url);

describe("Restore drill", () => {
  it("restores only into isolated targets and verifies relationships and hashes", async () => {
    const script = await readFile(new URL("infra/backup/restore-drill.sh", repositoryRoot), "utf8");

    expect(script).toContain("set -Eeuo pipefail");
    expect(script).toMatch(/restore[_-]drill/u);
    expect(script).toMatch(/pg_restore/u);
    expect(script).toMatch(/note_versions/u);
    expect(script).toMatch(/assets/u);
    expect(script).toMatch(/sha256/u);
    expect(script).toMatch(/>>/u);
    expect(script).not.toMatch(/content_markdown.+>>/u);
    expect(script).not.toMatch(/set -x/u);
  });
});
