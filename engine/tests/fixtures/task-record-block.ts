/**
 * How every Task record check's block message ends, for the per-check suites.
 * The wording is production's `taskRecordAnswerLines`, pinned once in
 * `tests/core/task-record.test.ts`; a per-check suite asserts only that its
 * block ends with it, so a wording or timeout change touches one test.
 */

import { taskRecordAnswerLines } from "../../src/core/task-record";

/** The tail a record check's block ends with: its cause line, a blank line,
 *  then the shared answer lines for `command` and the blocks left. */
export const taskRecordBlockTail = (command: string, blocksRemaining: number): string =>
  `\n${taskRecordAnswerLines(command, blocksRemaining).join("\n")}`;
