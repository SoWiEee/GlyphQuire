import { describe, it, expect } from "vitest";
import { parse } from "../parser/index.js";
import { serialize } from "./index.js";

function roundTrip(md: string): string {
  return serialize(parse(md).document);
}

describe("serialize", () => {
  it("re-emits a callout directive", () => {
    const out = roundTrip('---\nglyphquire-spec: 1\n---\n\n:::callout{type="warning"}\nHi\n:::\n');
    expect(out).toContain(":::callout");
    expect(out).toContain('type="warning"');
  });

  it("preserves an unknown directive", () => {
    const out = roundTrip('---\nglyphquire-spec: 1\n---\n\n:::future{x="1"}\nHi\n:::\n');
    expect(out).toContain(":::future");
    expect(out).toContain('x="1"');
  });

  it("preserves asset:// image URIs", () => {
    const out = roundTrip("---\nglyphquire-spec: 1\n---\n\n![Arch](asset://01ABC)\n");
    expect(out).toContain("asset://01ABC");
  });

  it("emits the glyphquire-spec frontmatter", () => {
    const out = roundTrip("---\nglyphquire-spec: 1\n---\n\n# Hi\n");
    expect(out).toContain("glyphquire-spec: 1");
  });
});
