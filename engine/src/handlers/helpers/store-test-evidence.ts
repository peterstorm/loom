/**
 * Store test evidence for a task.
 * Usage: bun cli.ts helper store-test-evidence --task T1
 * Reads TEST_PASSED:/TEST_EVIDENCE:/NEW_TESTS_WRITTEN:/NEW_TEST_EVIDENCE: lines from stdin.
 */

import type { HookHandler } from "../../types";
import { TASK_GRAPH_PATH } from "../../config";
import { StateManager } from "../../state-manager";

const handler: HookHandler = async (stdin, args) => {
  const taskIdx = args.indexOf("--task");
  const taskId = taskIdx >= 0 ? args[taskIdx + 1] : null;
  if (!taskId) return { kind: "error", message: "--task required" };

  const mgr = StateManager.fromPath(TASK_GRAPH_PATH);
  if (!mgr) return { kind: "error", message: `No task graph at ${TASK_GRAPH_PATH}` };

  const passed = /TEST_PASSED:\s*true/i.test(stdin);
  const evidenceMatch = stdin.match(/TEST_EVIDENCE:\s*(.*)/);
  const newWritten = /NEW_TESTS_WRITTEN:\s*true/i.test(stdin);
  const newEvidenceMatch = stdin.match(/NEW_TEST_EVIDENCE:\s*(.*)/);

  await mgr.update((s) => ({
    ...s,
    tasks: s.tasks.map((t) =>
      t.id === taskId
        ? {
            ...t,
            status: "implemented" as const,
            tests_passed: passed,
            test_evidence: evidenceMatch?.[1] ?? "",
            new_tests_written: newWritten,
            new_test_evidence: newEvidenceMatch?.[1] ?? "",
          }
        : t
    ),
  }));

  process.stderr.write(`Test evidence stored for ${taskId}: passed=${passed} new_tests=${newWritten}\n`);
  return { kind: "passthrough" };
};

export default handler;
