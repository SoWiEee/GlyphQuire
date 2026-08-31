import { createPinia, setActivePinia } from "pinia";
import { flushPromises, mount } from "@vue/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ShareLinkResponse } from "@glyphquire/api-contract";
import { WorkspaceToolsApiError } from "../../api/WorkspaceToolsClient.js";
import {
  useWorkspaceToolsStore,
  type WorkspaceToolsClientPort,
} from "../../stores/workspace-tools.js";
import ShareLinkDialog from "./ShareLinkDialog.vue";

const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
const NOTE_ID = "22222222-2222-4222-8222-222222222222";
const SHARE_ID = "33333333-3333-4333-8333-333333333333";
const TOKEN = "A".repeat(43);

function link(): ShareLinkResponse {
  return {
    id: SHARE_ID,
    workspaceId: WORKSPACE_ID,
    noteId: NOTE_ID,
    token: TOKEN,
    url: `${location.origin}/api/v1/shared/${TOKEN}`,
    expiresAt: null,
    createdAt: "2026-08-30T00:00:00.000Z",
  };
}

function client(overrides: Partial<WorkspaceToolsClientPort> = {}): WorkspaceToolsClientPort {
  return {
    uploadAsset: vi.fn(),
    search: vi.fn(),
    startImport: vi.fn(),
    getImport: vi.fn(),
    startExport: vi.fn(),
    getExport: vi.fn(),
    createShareLink: vi.fn(async () => link()),
    revokeShareLink: vi.fn(async () => undefined),
    ...overrides,
  } as WorkspaceToolsClientPort;
}

describe("ShareLinkDialog", () => {
  beforeEach(() => {
    localStorage.clear();
    setActivePinia(createPinia());
  });

  it("renders an authorized read-only link and removes its token immediately after revoke", async () => {
    const api = client();
    const store = useWorkspaceToolsStore();
    store.configure(api);
    const wrapper = mount(ShareLinkDialog, { props: { noteId: NOTE_ID } });

    await wrapper.get('button[aria-label="Create share link"]').trigger("click");
    await flushPromises();
    const anchor = wrapper.get('a[aria-label="Read-only share link"]');
    expect(anchor.attributes("href")).toBe(link().url);
    expect(anchor.attributes("rel")).toBe("noopener noreferrer");
    expect(localStorage.getItem("glyphquire.workspace-tools.pending.v1") ?? "").not.toContain(
      TOKEN,
    );

    await wrapper.get('button[aria-label="Revoke share link"]').trigger("click");
    await flushPromises();
    expect(wrapper.find('a[aria-label="Read-only share link"]').exists()).toBe(false);
    expect(wrapper.html()).not.toContain(TOKEN);
  });

  it("renders expired/inaccessible links with one sanitized public state", async () => {
    const api = client({
      createShareLink: vi.fn(async () =>
        Promise.reject(
          Object.assign(
            new WorkspaceToolsApiError(
              "SHARE_NOT_FOUND",
              404,
              "44444444-4444-4444-8444-444444444444",
            ),
            { detail: "plaintext-token=SECRET note=# private" },
          ),
        ),
      ),
    });
    const store = useWorkspaceToolsStore();
    store.configure(api);
    const wrapper = mount(ShareLinkDialog, { props: { noteId: NOTE_ID } });
    await wrapper.get('button[aria-label="Create share link"]').trigger("click");
    await flushPromises();

    expect(wrapper.get('[role="alert"]').text()).toBe(
      "You do not have permission, or the item is unavailable.",
    );
    expect(wrapper.html()).not.toMatch(/plaintext-token|SECRET|private/iu);
  });
});
