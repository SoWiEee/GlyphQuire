import { describe, expect, it } from "vitest";
import { meApiContract, meResultSchema } from "./schemas.js";

// A better-auth user id is opaque text, not a UUID.
const opaqueUserId = "usr_2N4kQb8fVxErq7wZ";
const workspaceId = "22222222-2222-4222-8222-222222222222";

describe("meResultSchema", () => {
  it("accepts an opaque userId with a canonical-UUID personalWorkspaceId", () => {
    const parsed = meResultSchema.parse({ userId: opaqueUserId, personalWorkspaceId: workspaceId });
    expect(parsed).toEqual({ userId: opaqueUserId, personalWorkspaceId: workspaceId });
  });

  it("rejects an empty userId", () => {
    expect(() => meResultSchema.parse({ userId: "", personalWorkspaceId: workspaceId })).toThrow();
  });

  it("rejects a non-canonical personalWorkspaceId", () => {
    expect(() =>
      meResultSchema.parse({ userId: opaqueUserId, personalWorkspaceId: "not-a-uuid" }),
    ).toThrow();
  });

  it("rejects unknown fields", () => {
    expect(() =>
      meResultSchema.parse({ userId: opaqueUserId, personalWorkspaceId: workspaceId, email: "x@y.z" }),
    ).toThrow();
  });

  it("declares the GET /api/v1/me contract", () => {
    expect(meApiContract.getMe.method).toBe("GET");
    expect(meApiContract.getMe.path).toBe("/api/v1/me");
    expect(meApiContract.getMe.response).toBe(meResultSchema);
  });
});
