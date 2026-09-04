import { mount } from "@vue/test-utils";
import { describe, expect, it, vi } from "vitest";
import CommandPalette from "./CommandPalette.vue";
import type { WorkbenchCommand } from "./types.js";

function command(
  id: string,
  label: string,
  category: WorkbenchCommand["category"],
): WorkbenchCommand {
  return { id, label, category, run: vi.fn() };
}

describe("CommandPalette", () => {
  it("starts from the supplied query and filters by category", async () => {
    const wrapper = mount(CommandPalette, {
      props: {
        commands: [command("bold", "Bold", "format"), command("heading", "Heading", "block")],
        initialQuery: "head",
        categoryFilter: "block",
      },
    });

    await wrapper.vm.$nextTick();
    expect(wrapper.get('input[aria-label="篩選命令"]').element).toHaveProperty(
      "value",
      "head",
    );
    expect(wrapper.text()).toContain("Heading");
    expect(wrapper.text()).not.toContain("Bold");
  });

  it("supports Home and End navigation and closes after a throwing command", async () => {
    const throwing = command("throwing", "Throwing", "format");
    throwing.run = () => {
      throw new Error("command failed");
    };
    const wrapper = mount(CommandPalette, {
      props: { commands: [command("first", "First", "format"), throwing] },
    });
    const input = wrapper.get('input[aria-label="篩選命令"]');

    await input.trigger("keydown", { key: "End" });
    expect(input.attributes("aria-activedescendant")).toBe("command-palette-option-1");
    await input.trigger("keydown", { key: "Home" });
    expect(input.attributes("aria-activedescendant")).toBe("command-palette-option-0");

    await input.trigger("keydown", { key: "End" });
    await expect(input.trigger("keydown", { key: "Enter" })).rejects.toThrow("command failed");
    await wrapper.vm.$nextTick();
    expect(wrapper.emitted("close")).toHaveLength(1);
  });
});
