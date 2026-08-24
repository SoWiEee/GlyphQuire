import { describe, it, expect } from "vitest";
import type { ContainerDirective } from "mdast-util-directive";
import type { RootContent } from "mdast";
import { calloutBlock } from "./callout.js";
import { toggleBlock } from "./toggle.js";
import { p5Block } from "./runtime.js";
import type { TransformContext, SerializeContext } from "../types.js";

const tx: TransformContext = { transformChildren: () => [], addDiagnostic: () => {} };
const sx: SerializeContext = { serializeChildren: (): RootContent[] => [] };

function container(
  name: string,
  attributes: Record<string, string>,
  children: RootContent[] = [],
): ContainerDirective {
  return {
    type: "containerDirective",
    name,
    attributes,
    children: children as ContainerDirective["children"],
  };
}

describe("callout block", () => {
  it("parses type and title, defaults type to info", () => {
    const node = calloutBlock.fromDirective(container("callout", {}), tx);
    expect(node.props.type).toBe("info");
  });
  it("throws (schema-invalid) on bad enum", () => {
    expect(() =>
      calloutBlock.fromDirective(container("callout", { type: "rainbow" }), tx),
    ).toThrow();
  });
  it("serializes type attribute", () => {
    const dir = calloutBlock.toDirective(
      { type: "callout", version: 1, props: { type: "danger" }, children: [] },
      sx,
    ) as ContainerDirective;
    expect(dir.attributes?.type).toBe("danger");
  });
});

describe("toggle block", () => {
  it("requires a non-empty title", () => {
    expect(() => toggleBlock.fromDirective(container("toggle", {}), tx)).toThrow();
  });
  it("omits default open on serialize", () => {
    const dir = toggleBlock.toDirective(
      { type: "toggle", version: 1, props: { title: "T", open: false }, children: [] },
      sx,
    ) as ContainerDirective;
    expect(dir.attributes?.open).toBeUndefined();
  });
});

describe("runtime block", () => {
  it("preserves source without executing", () => {
    const code: RootContent = { type: "code", lang: "js", value: "circle(1,2,3)" };
    const node = p5Block.fromDirective(container("p5", { height: "400" }, [code]), tx);
    expect(node.source).toBe("circle(1,2,3)");
    expect(node.runtime).toBe("p5");
  });
});
