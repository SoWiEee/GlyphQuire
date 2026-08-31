import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import type { ShareLinkResponse } from "@glyphquire/api-contract";
import SharedLinksPanel from "./SharedLinksPanel.vue";

const link: ShareLinkResponse = {
  id: "66666666-6666-4666-8666-666666666666",
  workspaceId: "33333333-3333-4333-8333-333333333333",
  noteId: "44444444-4444-4444-8444-444444444444",
  token: "a".repeat(43),
  url: "https://glyphquire.example/share/a",
  expiresAt: null,
  createdAt: "2026-08-19T12:00:00.000Z",
};

describe("SharedLinksPanel", () => {
  it("presents cached links and emits note open and revoke actions", async () => {
    const wrapper = mount(SharedLinksPanel, { props: { links: [link] } });

    expect(wrapper.text()).toContain("Shared links");
    await wrapper.get('button[aria-label="Open shared note"]').trigger("click");
    await wrapper.get('button[aria-label="Revoke shared link"]').trigger("click");

    expect(wrapper.emitted("open")?.[0]).toEqual([link.noteId]);
    expect(wrapper.emitted("revoke")?.[0]).toEqual([link.id]);
  });

  it("does not invent links when the session cache is empty", () => {
    const wrapper = mount(SharedLinksPanel, { props: { links: [] } });

    expect(wrapper.get('[data-testid="shared-links-empty"]').text()).toContain("No shared links");
  });
});
