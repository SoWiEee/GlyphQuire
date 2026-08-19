import { describe, it, expect } from "vitest";
import { diagnostic, DIAGNOSTIC_CODES } from "./diagnostics.js";

describe("diagnostic", () => {
  it("builds a diagnostic with code, severity, and message", () => {
    const d = diagnostic(DIAGNOSTIC_CODES.ATTRIBUTE_INVALID_VALUE, "error", "bad", {
      block: "callout",
      attribute: "type",
    });
    expect(d).toStrictEqual({
      code: "ATTRIBUTE_INVALID_VALUE",
      severity: "error",
      message: "bad",
      block: "callout",
      attribute: "type",
    });
  });

  it("omits optional keys entirely when no extra is passed", () => {
    const d = diagnostic(DIAGNOSTIC_CODES.DIRECTIVE_UNKNOWN, "warning", "unknown directive");
    expect(d).toStrictEqual({
      code: "DIRECTIVE_UNKNOWN",
      severity: "warning",
      message: "unknown directive",
    });
    expect(Object.keys(d)).not.toContain("range");
    expect(Object.keys(d)).not.toContain("block");
    expect(Object.keys(d)).not.toContain("attribute");
  });

  it("omits unset optional keys when only a partial extra is passed", () => {
    const d = diagnostic(DIAGNOSTIC_CODES.INVALID_PARENT, "error", "bad parent", {
      block: "callout",
    });
    expect(d).toStrictEqual({
      code: "INVALID_PARENT",
      severity: "error",
      message: "bad parent",
      block: "callout",
    });
    expect(Object.keys(d)).not.toContain("range");
    expect(Object.keys(d)).not.toContain("attribute");
  });
});
