import { expect, it } from "vitest";
import {
  phase6ChecklistSchema,
  phase6ReleaseDecisionSchema,
} from "../../packages/shared/src/index.js";

it("records blocked evidence but rejects it as a release decision", () => {
  expect(phase6ChecklistSchema.parse({ gate: "P0-08", status: "blocked" })).toMatchObject({
    status: "blocked",
  });
  expect(() =>
    phase6ReleaseDecisionSchema.parse({ rows: [{ gate: "P0-08", status: "blocked" }] }),
  ).toThrow();
});
