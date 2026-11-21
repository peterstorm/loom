/**
 * SubagentStop wiring of regression attribution (ADR-0080): the handler
 * builds the settling Task's regression scope from the TaskGraph roster, so a
 * trusted failure only in an unsettled sibling's test file lands as this
 * Task's pass, and the same failure stands once that sibling has settled.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { failing, passing, report } from "../../fixtures/red-then-green-status-fixtures";
import { runUpdateTaskStatus } from "../../../src/handlers/subagent-stop/update-task-status";
import { parseEpoch, type EvidenceRecord } from "../../../src/machine";
import { AGENT_COMMAND_ORIGIN } from "../../../src/machine/types";
import { armedClaudeImplementation, writesTranscript } from "../../fixtures/claude-implementation-attempt";
import { taskFixture } from "../../fixtures/task-lifecycle";

const OWN_TEST = "tests/own.test.ts";
const SIBLING_TEST = "tests/sibling.test.ts";
const disposals: (() => void)[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const dispose of disposals.splice(0)) dispose();
});

/** T1 settles its exact attempt; T2 is its Wave sibling declaring the failing test file. */
async function settle(siblingStatus: "pending" | "implemented") {
  const armed = await armedClaudeImplementation({
    label: `regression-scope-${siblingStatus}`,
    verificationPolicy: {
      regression: { kind: "required" },
      newTests: { kind: "waived", reason: "existing-tests-sufficient" },
    },
    fileList: [OWN_TEST],
    siblings: [taskFixture({
      id: "T2", description: "impl", agent: "code-implementer-agent", wave: 1, status: siblingStatus,
      depends_on: [], new_tests_required: false, file_list: [SIBLING_TEST],
    })],
  });
  disposals.push(armed.dispose);
  writeFileSync(armed.transcript, writesTranscript("Ran the suite.", []));
  const epoch = parseEpoch(`${armed.agentId}:code-implementer-agent`);
  if (epoch === null) throw new Error("the armed Agent epoch must parse");
  const snapshot: readonly EvidenceRecord[] = [{
    epoch,
    event: {
      kind: "TestRun",
      origin: AGENT_COMMAND_ORIGIN,
      command: "npm test",
      exit: 1,
      report: report([failing(SIBLING_TEST), passing(OWN_TEST)]),
    },
  }];
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  const result = await runUpdateTaskStatus(armed.stopInput, [], { kind: "snapshot", events: snapshot }, armed.observation);
  expect(result.kind, JSON.stringify(result)).toBe("passthrough");
  return JSON.parse(readFileSync(armed.statePath, "utf-8")).tasks[0];
}

describe("SubagentStop regression scope", () => {
  it("lands a failure only in an unsettled sibling's test file as this Task's trusted pass, naming the sibling", async () => {
    const task = await settle("pending");
    expect(task.test_result).toEqual({ verdict: "trusted-pass" });
    expect(task.test_evidence).toContain(`failures attributed to unsettled Tasks: ${SIBLING_TEST} (T2)`);
  }, 30000);

  it("keeps the same failure on this Task once the sibling has settled", async () => {
    const task = await settle("implemented");
    expect(task.test_result).toEqual({ verdict: "trusted-fail" });
    expect(task.test_evidence).toContain("ledger: exit 1");
  }, 30000);
});
