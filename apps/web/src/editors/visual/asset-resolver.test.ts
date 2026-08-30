import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AssetResolutionError,
  createAssetResolver,
  parseAssetReference,
} from "./asset-resolver.js";

const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_WORKSPACE_ID = "22222222-2222-4222-8222-222222222222";
const ASSET_ID = "33333333-3333-4333-8333-333333333333";
const NOW = "2026-08-30T00:00:00.000Z";

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function metadata(overrides: Record<string, unknown> = {}) {
  return {
    id: ASSET_ID,
    workspaceId: WORKSPACE_ID,
    originalName: "safe.png",
    mimeType: "image/png",
    size: 8,
    sha256: "a".repeat(64),
    createdAt: NOW,
    deletedAt: null,
    thumbnailStatus: "pending",
    downloadUrl: "https://objects.example/signed-object",
    ...overrides,
  };
}

describe("asset:// resolver", () => {
  afterEach(() => vi.restoreAllMocks());

  it.each([
    `asset://${ASSET_ID}`,
    `asset://${ASSET_ID.toUpperCase()}`,
    `asset://${ASSET_ID}/extra`,
    `asset://${ASSET_ID}?workspace=${OTHER_WORKSPACE_ID}`,
    `https://objects.example/${ASSET_ID}`,
    "data:image/svg+xml,<svg onload=alert(1)>",
    "asset://not-a-uuid",
  ])("accepts only a canonical lowercase asset reference: %s", (candidate) => {
    expect(parseAssetReference(candidate)).toBe(
      candidate === `asset://${ASSET_ID}` ? ASSET_ID : null,
    );
  });

  it("loads metadata through the authenticated same-origin API and exposes only a blob URL", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(metadata()))
      .mockResolvedValueOnce(
        new Response(new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), {
          status: 200,
          headers: { "content-type": "image/png", "content-length": "8" },
        }),
      );
    const createObjectURL = vi.fn(() => "blob:https://app.example/object-id");
    const revokeObjectURL = vi.fn();
    const resolver = createAssetResolver({
      workspaceId: WORKSPACE_ID,
      fetchImpl,
      createObjectURL,
      revokeObjectURL,
    });

    const resolved = await resolver.resolve(`asset://${ASSET_ID}`);

    expect(fetchImpl.mock.calls[0]?.[0]).toBe(`/api/v1/assets/${ASSET_ID}/download`);
    expect(fetchImpl.mock.calls[0]?.[1]).toMatchObject({
      credentials: "same-origin",
      redirect: "error",
      cache: "no-store",
    });
    expect(fetchImpl.mock.calls[1]?.[0]).toBe("https://objects.example/signed-object");
    expect(fetchImpl.mock.calls[1]?.[1]).toMatchObject({
      credentials: "omit",
      redirect: "error",
      cache: "no-store",
      referrerPolicy: "no-referrer",
    });
    expect(resolved.src).toBe("blob:https://app.example/object-id");
    expect(resolved.src).not.toContain("asset:");
    expect(resolved.src).not.toContain("objects.example");
    resolved.release();
    resolved.release();
    expect(revokeObjectURL).toHaveBeenCalledOnce();
  });

  it("fails closed when the API returns an asset from another workspace", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(metadata({ workspaceId: OTHER_WORKSPACE_ID })),
    );
    const resolver = createAssetResolver({ workspaceId: WORKSPACE_ID, fetchImpl });

    await expect(resolver.resolve(`asset://${ASSET_ID}`)).rejects.toBeInstanceOf(
      AssetResolutionError,
    );
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it.each(["image/svg+xml", "text/html", "application/xhtml+xml", "text/plain"])(
    "never fetches or exposes active/unsupported media type %s",
    async (mimeType) => {
      const fetchImpl = vi.fn(async () => jsonResponse(metadata({ mimeType })));
      const resolver = createAssetResolver({ workspaceId: WORKSPACE_ID, fetchImpl });

      await expect(resolver.resolve(`asset://${ASSET_ID}`)).rejects.toBeInstanceOf(
        AssetResolutionError,
      );
      expect(fetchImpl).toHaveBeenCalledOnce();
    },
  );

  it("rejects response body MIME drift and bytes above the declared bounded size", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(metadata()))
      .mockResolvedValueOnce(
        new Response("<svg onload=alert(1)></svg>", {
          status: 200,
          headers: { "content-type": "image/svg+xml" },
        }),
      );
    const createObjectURL = vi.fn(() => "blob:must-not-be-created");
    const resolver = createAssetResolver({
      workspaceId: WORKSPACE_ID,
      fetchImpl,
      createObjectURL,
    });

    await expect(resolver.resolve(`asset://${ASSET_ID}`)).rejects.toBeInstanceOf(
      AssetResolutionError,
    );
    expect(createObjectURL).not.toHaveBeenCalled();
  });
});
