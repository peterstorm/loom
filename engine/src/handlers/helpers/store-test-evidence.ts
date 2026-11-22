/**
 * Store test evidence for a task.
 * Usage: bun cli.ts helper store-test-evidence --task T1
 * Reads TEST_PASSED:/TEST_EVIDENCE:/NEW_TESTS_WRITTEN:/NEW_TEST_EVIDENCE: lines from stdin.
 */

import {
  parseNewTestEvidence,
  storedNewTestEvidence,
  type HookHandler,
  type NewTestEvidence,
  type TaskGraph,
} from "../../types";
import { TASK_GRAPH_PATH } from "../../config";
import { StateManager } from "../../state-manager";
import { argumentValue } from "./cli-args";

/** The test evidence one helper invocation reports on stdin: agent-controlled text. */
export type HelperTestEvidence = Readonly<{
  passed: boolean;
  testEvidence: string;
  newTests: NewTestEvidence;
}>;

export type TestEvidenceStoreOutcome = "missing" | "requires-agent-revalidation" | "trusted-verdict-skipped" | "stored";

/**
 * Whether `taskId` may take the helper-reported evidence, and the graph that
 * results. A trusted verdict (ledger-derived ground truth) must never be
 * laundered away by agent-controlled stdin: an untrusted "passed: true"
 * replacing a trusted-fail would sail through the wave gate. Mirroring
 * update-task-status's skip guard, the Task is left untouched and the outcome
 * says so. Only a stored outcome returns a new graph: every refusal hands back
 * `graph` itself, so a locked update over it writes nothing. Pure.
 */
export function decideTestEvidenceStore(
  graph: TaskGraph,
  taskId: string,
  evidence: HelperTestEvidence,
): Readonly<{ state: TaskGraph; value: TestEvidenceStoreOutcome }> {
  const target = graph.tasks.find((t) => t.id === taskId);
  if (target === undefined) return { state: graph, value: "missing" };
  if (target.revalidation_required === true) return { state: graph, value: "requires-agent-revalidation" };
  const verdict = target.test_result?.verdict;
  if (verdict === "trusted-pass" || verdict === "trusted-fail") return { state: graph, value: "trusted-verdict-skipped" };
  return {
    state: {
      ...graph,
      tasks: graph.tasks.map((t) => t.id !== taskId ? t : {
        ...t,
        // Evidence storage is not positive completion authority. The
        // Implementation Completion Oracle alone may change Task lifecycle.
        // Helper-reported stdin is agent-controlled text — never trusted.
        test_result: {
          verdict: "untrusted" as const,
          passed: evidence.passed,
          label: "helper-reported (store-test-evidence stdin)",
          provenance: "unverified" as const,
        },
        test_evidence: evidence.testEvidence,
        ...storedNewTestEvidence(evidence.newTests),
      }),
    },
    value: "stored",
  };
}

const handler: HookHandler = async (stdin, args) => {
  const taskId = argumentValue(args, "--task");
  if (!taskId) return { kind: "error", message: "--task required" };

  const mgr = StateManager.fromPath(TASK_GRAPH_PATH);
  if (!mgr) return { kind: "error", message: `No task graph at ${TASK_GRAPH_PATH}` };

  const passed = /^TEST_PASSED:[ \t]*true[ \t]*$/im.test(stdin);
  const evidenceMatch = stdin.match(/TEST_EVIDENCE:\s*(.*)/);
  const newWritten = /^NEW_TESTS_WRITTEN:[ \t]*true[ \t]*$/im.test(stdin);
  const newEvidenceMatch = stdin.match(/NEW_TEST_EVIDENCE:\s*(.*)/);
  const evidence: HelperTestEvidence = {
    passed,
    testEvidence: evidenceMatch?.[1] ?? "",
    newTests: parseNewTestEvidence(newWritten, newEvidenceMatch?.[1] ?? ""),
  };

  // Decided INSIDE the locked update so a concurrently-written trusted
  // verdict is honored.
  const storeOutcome = await mgr.updateAndReturn((s) => decideTestEvidenceStore(s, taskId, evidence));

  switch (storeOutcome) {
    // A --task that matches nothing is a silent success otherwise: the caller
    // believes evidence was stored while the graph is untouched.
    case "missing":
      return { kind: "error", message: `store-test-evidence: no task ${taskId} in the task graph — nothing stored` };
    case "requires-agent-revalidation":
      return { kind: "error", message: `store-test-evidence: ${taskId} requires a re-spawned implementation Agent to record fresh test evidence` };
    case "trusted-verdict-skipped":
      process.stderr.write(
        `store-test-evidence: ${taskId} already carries a trusted verdict from the evidence ledger — refusing to overwrite it with helper-reported (untrusted) results\n`,
      );
      return { kind: "passthrough" };
    case "stored":
      process.stderr.write(`Test evidence stored for ${taskId}: passed=${passed} new_tests=${newWritten}\n`);
      return { kind: "passthrough" };
    default: {
      const unreachable: never = storeOutcome;
      return unreachable;
    }
  }
};

export default handler;
