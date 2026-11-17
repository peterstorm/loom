/**
 * The raw ledger TestRun the I6 acceptance and settlement suites write: an
 * agent-command run with a parsed JUnit report recording `results`,
 * reconciled with its counts, as the evidence line parser reads it back.
 */

import type { TestFileResult } from "../../src/core/red-then-green-types";
import { AGENT_COMMAND_ORIGIN } from "../../src/machine/types";

export const RED_RUN = "npm --prefix engine run test:unit -- tests/core/ledger.test.ts";
export const GREEN_RUN = "npm --prefix engine run test:unit";

export type RawEvent = Readonly<Record<string, unknown>>;

/** A TestRun with a parsed JUnit report recording `results`; red runs exit 1 under `RED_RUN`, green ones 0 under `GREEN_RUN`. */
export function rawTestRun(
  results: readonly TestFileResult[],
  options: Readonly<{ command?: string; exit?: number | null }> = {},
): RawEvent {
  const total = results.reduce((sum, { executed }) => sum + executed, 0);
  const failed = results.reduce((sum, file) => sum + file.failed, 0);
  return {
    kind: "TestRun", origin: AGENT_COMMAND_ORIGIN,
    command: options.command ?? (failed > 0 ? RED_RUN : GREEN_RUN),
    exit: options.exit === undefined ? (failed > 0 ? 1 : 0) : options.exit,
    report: { total, failed, source: "junit-xml", files: { kind: "recorded", results } },
  };
}
