import { createPinia, setActivePinia } from "pinia";
import { flushPromises, mount } from "@vue/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Phase5ApiError } from "../../api/Phase5Client.js";
import { usePhase5Store, type Phase5ClientPort } from "../../stores/phase5.js";
import SearchPalette from "./SearchPalette.vue";

const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
const NOTE_ID = "22222222-2222-4222-8222-222222222222";

function client(search: Phase5ClientPort["search"]): Phase5ClientPort {
  return {
    uploadAsset: vi.fn(),
    search,
    startImport: vi.fn(),
    getImport: vi.fn(),
    startExport: vi.fn(),
    getExport: vi.fn(),
    createShareLink: vi.fn(),
    revokeShareLink: vi.fn(),
  } as Phase5ClientPort;
}

describe("SearchPalette", () => {
  beforeEach(() => setActivePinia(createPinia()));

  it("renders title/snippet as inert text and emits only the validated note id", async () => {
    const search = vi.fn(async () => ({
      items: [
        {
          noteId: NOTE_ID,
          workspaceId: WORKSPACE_ID,
          revision: 2,
          title: '<img src=x onerror="alert(1)">',
          snippet: "<script>globalThis.pwned=true</script> **not Markdown**",
          updatedAt: "2026-08-30T00:00:00.000Z",
        },
      ],
      nextCursor: null,
    }));
    const store = usePhase5Store();
    store.configure(client(search));
    const wrapper = mount(SearchPalette, { props: { workspaceId: WORKSPACE_ID } });
    await wrapper.get('input[aria-label="Search notes"]').setValue("needle");
    await wrapper.get('button[aria-label="Run search"]').trigger("click");
    await flushPromises();

    expect(wrapper.find("img, script").exists()).toBe(false);
    expect(wrapper.text()).toContain("<img src=x");
    expect(wrapper.text()).toContain("<script>");
    await wrapper.get('button[aria-label="Open search result"]').trigger("click");
    expect(wrapper.emitted("select-note")).toEqual([[NOTE_ID]]);
  });

  it("shows a uniform permission state without distinguishing tenant existence", async () => {
    const store = usePhase5Store();
    store.configure(
      client(
        vi.fn(async () =>
          Promise.reject(
            new Phase5ApiError("NOTE_NOT_FOUND", 404, "33333333-3333-4333-8333-333333333333"),
          ),
        ),
      ),
    );
    const wrapper = mount(SearchPalette, { props: { workspaceId: WORKSPACE_ID } });
    await wrapper.get('input[aria-label="Search notes"]').setValue("private title");
    await wrapper.get('button[aria-label="Run search"]').trigger("click");
    await flushPromises();

    expect(wrapper.get('[role="alert"]').text()).toBe(
      "You do not have permission, or the item is unavailable.",
    );
  });
});
