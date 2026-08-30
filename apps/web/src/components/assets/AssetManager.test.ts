import { createPinia, setActivePinia } from "pinia";
import { flushPromises, mount } from "@vue/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AssetResponse } from "@glyphquire/api-contract";
import { Phase5ApiError } from "../../api/Phase5Client.js";
import { usePhase5Store, type Phase5ClientPort } from "../../stores/phase5.js";
import AssetManager from "./AssetManager.vue";

const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
const ASSET_ID = "22222222-2222-4222-8222-222222222222";

function asset(): AssetResponse {
  return {
    id: ASSET_ID,
    workspaceId: WORKSPACE_ID,
    originalName: "diagram.png",
    mimeType: "image/png",
    size: 8,
    sha256: "a".repeat(64),
    createdAt: "2026-08-30T00:00:00.000Z",
    deletedAt: null,
    thumbnailStatus: "pending",
  };
}

function client(uploadAsset: Phase5ClientPort["uploadAsset"]): Phase5ClientPort {
  return {
    uploadAsset,
    search: vi.fn(),
    startImport: vi.fn(),
    getImport: vi.fn(),
    startExport: vi.fn(),
    getExport: vi.fn(),
    createShareLink: vi.fn(),
    revokeShareLink: vi.fn(),
  } as Phase5ClientPort;
}

describe("AssetManager", () => {
  beforeEach(() => setActivePinia(createPinia()));

  it("keeps the persisted note reference logical and never renders provider URLs", async () => {
    const uploadAsset = vi.fn(async () => asset());
    const store = usePhase5Store();
    store.configure(client(uploadAsset));
    const wrapper = mount(AssetManager, { props: { workspaceId: WORKSPACE_ID } });
    const input = wrapper.get<HTMLInputElement>('input[aria-label="Asset file"]');
    const file = new File([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])], "diagram.png", {
      type: "image/png",
    });
    Object.defineProperty(input.element, "files", { configurable: true, value: [file] });
    await input.trigger("change");
    await wrapper.get('button[aria-label="Upload asset"]').trigger("click");
    await flushPromises();

    expect(uploadAsset).toHaveBeenCalledWith({ workspaceId: WORKSPACE_ID, file });
    expect(wrapper.get('[data-testid="asset-reference"]').text()).toBe(`asset://${ASSET_ID}`);
    expect(wrapper.find("img").exists()).toBe(false);
    expect(wrapper.html()).not.toMatch(/s3:|signature=|objectKey/iu);
  });

  it("shows one stable denial without raw storage details", async () => {
    const failure = Object.assign(
      new Phase5ApiError("ASSET_INVALID", 403, "33333333-3333-4333-8333-333333333333"),
      { detail: "minio://private token=SECRET" },
    );
    const store = usePhase5Store();
    store.configure(client(vi.fn(async () => Promise.reject(failure))));
    const wrapper = mount(AssetManager, { props: { workspaceId: WORKSPACE_ID } });
    const input = wrapper.get<HTMLInputElement>('input[aria-label="Asset file"]');
    Object.defineProperty(input.element, "files", {
      configurable: true,
      value: [new File(["x"], "x.png", { type: "image/png" })],
    });
    await input.trigger("change");
    await wrapper.get('button[aria-label="Upload asset"]').trigger("click");
    await flushPromises();

    expect(wrapper.get('[role="alert"]').text()).toBe("The asset request was rejected.");
    expect(wrapper.html()).not.toMatch(/minio|SECRET/iu);
  });
});
