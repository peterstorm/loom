/**
 * Store test evidence for a task.
 * Usage: bun cli.ts helper store-test-evidence --task T1
 * Reads TEST_PASSED:/TEST_EVIDENCE:/NEW_TESTS_WRITTEN:/NEW_TEST_EVIDENCE: lines from stdin.
 */

import { parseNewTestEvidence, storedNewTestEvidence, type HookHandler } from "../../types";
import { TASK_GRAPH_PATH } from "../../config";
import { StateManager } from "../../state-manager";
import { argumentValue } from "./cli-args";

const handler: HookHandler = async (stdin, args) => {
  const taskId = argumentValue(args, "--task");
  if (!taskId) return { kind: "error", message: "--task required" };

  const mgr = StateManager.fromPath(TASK_GRAPH_PATH);
  if (!mgr) return { kind: "error", message: `No task graph at ${TASK_GRAPH_PATH}` };

  const passed = /TEST_PASSED:\s*true/i.test(stdin);
  const evidenceMatch = stdin.match(/TEST_EVIDENCE:\s*(.*)/);
  const newWritten = /NEW_TESTS_WRITTEN:\s*true/i.test(stdin);
  const newEvidenceMatch = stdin.match(/NEW_TEST_EVIDENCE:\s*(.*)/);

  // A trusted verdict (ledger-derived ground truth) must never be laundered
  // away by agent-controlled stdin — an untrusted "passed: true" replacing a
  // trusted-fail would sail through the wave gate. Mirror update-task-status's
  // skip guard: leave the task untouched and say so. Decided INSIDE the
  // locked update so a concurrently-written trusted verdict is honored.
  type StoreOutcome = "missing" | "requires-agent-revalidation" | "trusted-verdict-skipped" | "stored";
  let storeOutcome: StoreOutcome = "missing";
  await mgr.update((s) => ({
    ...s,
    tasks: s.tasks.map((t) => {
      if (t.id !== taskId) return t;
      const verdict = t.test_result?.verdict;
      if (t.revalidation_required === true) {
        storeOutcome = "requires-agent-revalidation";
        return t;
      }
      if (verdict === "trusted-pass" || verdict === "trusted-fail") {
        storeOutcome = "trusted-verdict-skipped";
        return t;
      }
      storeOutcome = "stored";
      return {
        ...t,
        // Evidence storage is not positive completion authority. The
        // Implementation Completion Oracle alone may change Task lifecycle.
        // Helper-reported stdin is agent-controlled text — never trusted.
        test_result: {
          verdict: "untrusted" as const,
          passed,
          label: "helper-reported (store-test-evidence stdin)",
          provenance: "unverified" as const,
        },
        test_evidence: evidenceMatch?.[1] ?? "",
        ...storedNewTestEvidence(parseNewTestEvidence(newWritten, newEvidenceMatch?.[1] ?? "")),
      };
    }),
  }));

  // A --task that matches nothing is a silent success otherwise: the caller
  // believes evidence was stored while the graph is untouched.
  if (storeOutcome === "missing") {
    return { kind: "error", message: `store-test-evidence: no task ${taskId} in the task graph — nothing stored` };
  }

  if (storeOutcome === "requires-agent-revalidation") {
    return { kind: "error", message: `store-test-evidence: ${taskId} requires a re-spawned implementation Agent to record fresh test evidence` };
  }

  if (storeOutcome === "trusted-verdict-skipped") {
    process.stderr.write(
      `store-test-evidence: ${taskId} already carries a trusted verdict from the evidence ledger — refusing to overwrite it with helper-reported (untrusted) results\n`,
    );
  } else {
    process.stderr.write(`Test evidence stored for ${taskId}: passed=${passed} new_tests=${newWritten}\n`);
  }
  return { kind: "passthrough" };
};

export default handler;
