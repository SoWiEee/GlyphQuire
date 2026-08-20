import { describe, it, expect } from "vitest";
import { parseToMdast } from "./mdast.js";
import { extractSpecVersion } from "./frontmatter.js";

function version(md: string) {
  return extractSpecVersion(parseToMdast(md));
}

describe("extractSpecVersion", () => {
  it("reads a valid positive integer version", () => {
    const r = version("---\nglyphquire-spec: 1\n---\n\n# Hi\n");
    expect(r.version).toBe(1);
    expect(r.diagnostics).toHaveLength(0);
  });

  it("flags a missing marker", () => {
    const r = version("# Hi\n");
    expect(r.version).toBeNull();
    expect(r.diagnostics[0]?.code).toBe("SPEC_VERSION_MISSING");
  });

  it("rejects a non-positive version", () => {
    const r = version("---\nglyphquire-spec: 0\n---\n");
    expect(r.version).toBeNull();
    expect(r.diagnostics[0]?.code).toBe("SPEC_VERSION_INVALID");
  });

  it("rejects a non-integer version", () => {
    const r = version("---\nglyphquire-spec: 1.5\n---\n");
    expect(r.version).toBeNull();
    expect(r.diagnostics[0]?.code).toBe("SPEC_VERSION_INVALID");
  });
});
