import { describe, expect, it } from "vitest";
import * as queue from "./index.js";

describe("queue test runner", () => {
  it("imports the queue public entrypoint", () => {
    expect(queue).toBeDefined();
  });
});
