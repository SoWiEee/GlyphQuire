import { describe, expect, it } from "vitest";
import * as database from "./index.js";

describe("database test runner", () => {
  it("imports the database public entrypoint", () => {
    expect(database).toHaveProperty("createDb");
  });
});
