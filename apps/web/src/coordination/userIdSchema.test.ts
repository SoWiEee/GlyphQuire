import { describe, expect, it } from "vitest";
import { coordinationUserIdSchema } from "./userIdSchema.js";

describe("coordinationUserIdSchema", () => {
  it("accepts a canonical UUID (existing callers are unaffected)", () => {
    const uuid = "11111111-1111-4111-8111-111111111111";
    expect(coordinationUserIdSchema.parse(uuid)).toBe(uuid);
  });

  it("accepts an opaque better-auth-shaped id", () => {
    const opaque = "usr_2N4kQb8fVxErq7wZ";
    expect(coordinationUserIdSchema.parse(opaque)).toBe(opaque);
  });

  it("rejects an empty string", () => {
    expect(() => coordinationUserIdSchema.parse("")).toThrow();
  });

  it("rejects a value containing a colon (would corrupt the delimited lock/channel name)", () => {
    expect(() => coordinationUserIdSchema.parse("evil:user")).toThrow();
  });

  it("rejects a value over 200 UTF-8 bytes", () => {
    expect(() => coordinationUserIdSchema.parse("a".repeat(201))).toThrow();
  });
});
