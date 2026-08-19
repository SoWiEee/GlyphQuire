import { describe, it, expect } from "vitest";
import { DOCUMENT_ENGINE_PACKAGE } from "../index.js";

describe("scaffold", () => {
  it("exposes the package identity", () => {
    expect(DOCUMENT_ENGINE_PACKAGE).toBe("@glyphquire/document-engine");
  });
});
