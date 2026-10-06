import { describe, expect, it } from "vitest";
import { taskReviewScope } from "../../src/core/wave-review-authority";

/** The single Task review-scope rule every review issuance path reads. */
describe("taskReviewScope", () => {
  it.each([
    { name: "union of declared and modified paths, de-duplicated and sorted", task: { file_list: ["b.ts", "a.ts"], files_modified: ["a.ts", "c.ts"] }, scope: ["a.ts", "b.ts", "c.ts"] },
    { name: "declared paths only", task: { file_list: ["z.ts", "y.ts"] }, scope: ["y.ts", "z.ts"] },
    { name: "modified paths only", task: { files_modified: ["m.ts"] }, scope: ["m.ts"] },
    { name: "no paths", task: {}, scope: [] },
  ])("$name", ({ task, scope }) => {
    expect(taskReviewScope(task)).toEqual(scope);
  });
});
