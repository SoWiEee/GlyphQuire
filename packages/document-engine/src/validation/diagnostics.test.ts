import { describe, it, expect } from "vitest";
import { diagnostic, DIAGNOSTIC_CODES } from "./diagnostics.js";

describe("diagnostic", () => {
  it("builds a diagnostic with code, severity, and message", () => {
    const d = diagnostic(DIAGNOSTIC_CODES.ATTRIBUTE_INVALID_VALUE, "error", "bad", {
      block: "callout",
      attribute: "type",
    });
    expect(d).toEqual({
      code: "ATTRIBUTE_INVALID_VALUE",
      severity: "error",
      message: "bad",
      block: "callout",
      attribute: "type",
    });
  });
});
