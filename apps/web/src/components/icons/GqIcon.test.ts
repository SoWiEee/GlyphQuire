import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import GqIcon from "./GqIcon.vue";

describe("GqIcon", () => {
  it("renders an allowlisted icon with its size class and currentColor", () => {
    const wrapper = mount(GqIcon, {
      props: {
        name: "search",
        size: "lg",
        strokeWidth: 1.75,
        decorative: true,
      },
    });
    const svg = wrapper.get("svg");

    expect(svg.classes()).toContain("gq-icon");
    expect(svg.classes()).toContain("gq-icon--lg");
    expect(svg.attributes("stroke")).toBe("currentColor");
    expect(svg.attributes("stroke-width")).toBe("1.75");
  });

  it("hides decorative icons from assistive technology", () => {
    const wrapper = mount(GqIcon, {
      props: { name: "check", size: "sm", decorative: true },
    });

    expect(wrapper.get("svg").attributes("aria-hidden")).toBe("true");
    expect(wrapper.get("svg").attributes("aria-label")).toBeUndefined();
  });

  it("labels non-decorative icons", () => {
    const wrapper = mount(GqIcon, {
      props: { name: "info", size: "md", decorative: false, label: "Information" },
    });

    expect(wrapper.get("svg").attributes("aria-label")).toBe("Information");
    expect(wrapper.get("svg").attributes("aria-hidden")).toBeUndefined();
  });

  it("requires a non-empty label for non-decorative icons", () => {
    expect(() =>
      mount(GqIcon, {
        props: { name: "info", decorative: false },
      }),
    ).toThrow(/label/i);
    expect(() =>
      mount(GqIcon, {
        props: { name: "info", decorative: false, label: "   " },
      }),
    ).toThrow(/label/i);
  });
});
