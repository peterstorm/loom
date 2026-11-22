/**
 * The block-message tail both Task record checks share. Each per-check suite
 * asserts only that its block ends with `taskRecordBlockTail`; the wording
 * itself is pinned here, once.
 */

import { describe, expect, it } from "vitest";
import { TASK_RECORD_CHECK_BASH_TIMEOUT_MS, taskRecordAnswerLines } from "../../src/core/task-record";

describe("taskRecordAnswerLines", () => {
  it("ends a block with the command, its Bash timeout and the blocks left", () => {
    expect(taskRecordAnswerLines("CMD", 1)).toEqual([
      "",
      `Run it as one Bash call with a timeout of ${TASK_RECORD_CHECK_BASH_TIMEOUT_MS} ms, then your final verification run:`,
      "  CMD",
      "This check blocks at most 1 more time(s); after that your stop proceeds and the Wave Gate judges.",
    ]);
  });
});
