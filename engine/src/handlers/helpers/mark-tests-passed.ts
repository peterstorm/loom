/**
 * Read-only verifier for per-task test evidence.
 * Does NOT modify state — only reports status.
 * Usage: bun cli.ts helper mark-tests-passed [--wave N]
 */

import type { HookHandler } from "../../types";
import { testResultPassed } from "../../types";
import { TASK_GRAPH_PATH } from "../../config";
import { StateManager } from "../../state-manager";
import {
  requiresNewTests,
  requiresRegression,
  taskVerificationPolicy,
} from "../../core/verification-policy";

import { parseWaveArg } from "./wave-args";

const handler: HookHandler = async (_stdin, args) => {
  const mgr = StateManager.fromPath(TASK_GRAPH_PATH);
  if (!mgr) return { kind: "error", message: "No active task graph" };

  let waveArg: number | null;
  try {
    waveArg = parseWaveArg(args);
  } catch (e) {
    return { kind: "error", message: `mark-tests-passed: ${(e as Error).message}` };
  }

  const state = mgr.load();
  const wave = waveArg ?? state.current_wave ?? 1;
  const tasks = state.tasks.filter((t) => t.wave === wave);

  // Zero tasks would satisfy every count below vacuously — that is an
  // error (wrong --wave or unpopulated graph), never "all evidence present".
  if (tasks.length === 0) {
    return {
      kind: "error",
      message: `Wave ${wave} has no tasks — nothing to verify (wrong --wave or unpopulated task graph?)`,
    };
  }

  // Same policy projections as the Wave Gate: regression execution and new-test
  // creation are independent, so waiving one never silently waives the other.
  const regressionRequired = (task: (typeof tasks)[number]) =>
    requiresRegression(taskVerificationPolicy(task));
  const newTestsRequired = (task: (typeof tasks)[number]) =>
    requiresNewTests(taskVerificationPolicy(task));
  const missing = tasks.filter((task) =>
    regressionRequired(task) && !testResultPassed(task.test_result));
  const missingNew = tasks.filter((task) =>
    newTestsRequired(task) && !task.new_tests_written);

  process.stderr.write(
    `Wave ${wave} test evidence: ${tasks.length - missing.length}/${tasks.length} passed, ` +
    `${tasks.length - missingNew.length}/${tasks.length} new-test OK\n`,
  );

  for (const t of tasks) {
    const verification = taskVerificationPolicy(t);
    const testStatus = verification.regression.kind === "waived"
      ? `N/A (${verification.regression.reason})`
      : testResultPassed(t.test_result) ? "PASS" : "MISSING";
    const newStatus = verification.newTests.kind === "waived"
      ? `N/A (${verification.newTests.reason})`
      : t.new_tests_written ? `YES (${t.new_test_evidence})` : "MISSING";
    process.stderr.write(`  ${t.id}: tests=${testStatus} new=${newStatus}\n`);
  }

  if (missing.length === 0 && missingNew.length === 0) {
    process.stderr.write("\nAll tasks have test evidence.\n");
    return { kind: "passthrough" };
  }

  const parts = [];
  if (missing.length > 0) parts.push(`Missing test evidence: ${missing.map((task) => task.id).join(", ")}`);
  if (missingNew.length > 0) parts.push(`Missing new-test evidence: ${missingNew.map((task) => task.id).join(", ")}`);

  return { kind: "error", message: parts.join("\n") };
};

export default handler;
