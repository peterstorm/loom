/**
 * Read-only verifier for per-task test evidence.
 * Does NOT modify state — only reports status.
 * Usage: bun cli.ts helper mark-tests-passed [--wave N]
 */

import type { HookHandler, Task } from "../../types";
import { testResultPassed } from "../../types";
import { TASK_GRAPH_PATH } from "../../config";
import { StateManager } from "../../state-manager";

/** Parses --wave N from CLI args (null when absent). A non-integer or
 *  sub-1 value throws — an unvalidated Number() would filter on NaN,
 *  matching zero tasks and reporting vacuous success. Mirrors
 *  lint-wave-gate's parseWaveArg. */
function parseWaveArg(args: string[]): number | null {
  const idx = args.indexOf("--wave");
  if (idx < 0 || !args[idx + 1]) return null;
  const n = Number(args[idx + 1]);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1) {
    throw new Error(`Invalid --wave value: "${args[idx + 1]}" (must be a positive integer)`);
  }
  return n;
}

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

  const withTests = tasks.filter((t) => testResultPassed(t.test_result));
  const newTestOk = tasks.filter((t) => t.new_tests_required === false || t.new_tests_written);

  process.stderr.write(`Wave ${wave} test evidence: ${withTests.length}/${tasks.length} passed, ${newTestOk.length}/${tasks.length} new-test OK\n`);

  for (const t of tasks) {
    const testStatus = testResultPassed(t.test_result) ? "PASS" : "MISSING";
    const newStatus = t.new_tests_required === false
      ? "N/A"
      : t.new_tests_written ? `YES (${t.new_test_evidence})` : "MISSING";
    process.stderr.write(`  ${t.id}: tests=${testStatus} new=${newStatus}\n`);
  }

  const allPass = withTests.length === tasks.length && newTestOk.length === tasks.length;
  if (allPass) {
    process.stderr.write("\nAll tasks have test evidence.\n");
    return { kind: "passthrough" };
  }

  const missing = tasks.filter((t) => !testResultPassed(t.test_result)).map((t) => t.id);
  const missingNew = tasks.filter((t) => t.new_tests_required !== false && !t.new_tests_written).map((t) => t.id);

  const parts = [];
  if (missing.length > 0) parts.push(`Missing test evidence: ${missing.join(", ")}`);
  if (missingNew.length > 0) parts.push(`Missing new-test evidence: ${missingNew.join(", ")}`);

  return { kind: "error", message: parts.join("\n") };
};

export default handler;
