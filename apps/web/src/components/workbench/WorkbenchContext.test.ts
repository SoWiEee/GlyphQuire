import { defineComponent, h } from "vue";
import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import {
  provideWorkbenchHostContext,
  useWorkbenchHostContext,
  type WorkbenchHostContext,
} from "./WorkbenchContext.js";

const Probe = defineComponent({
  setup() {
    const context = useWorkbenchHostContext();
    return () => h("output", { "data-context": JSON.stringify(context) });
  },
});

describe("WorkbenchContext", () => {
  it("keeps the default context empty", () => {
    const wrapper = mount(Probe);

    expect(JSON.parse(wrapper.get("output").attributes("data-context") ?? "null")).toEqual({});
  });

  it("provides the host context unchanged", () => {
    const context: WorkbenchHostContext = {
      workspaceId: "33333333-3333-4333-8333-333333333333",
      workspaceName: "Research",
      accountLabel: "AL",
    };
    const Host = defineComponent({
      setup() {
        provideWorkbenchHostContext(context);
        return () => h(Probe);
      },
    });

    const wrapper = mount(Host);

    expect(JSON.parse(wrapper.get("output").attributes("data-context") ?? "null")).toEqual(context);
  });
});
