/**
 * The Acceptance Stop Check's plan: everything the TaskGraph alone decides
 * about one Task's stop. That covers the runner from the frozen verification
 * manifest, what is owed from `stopCheckExpectation`, and the command from
 * `acceptanceRunnerCheck`.
 *
 * The live check's `decideStop` and `helper stop-check-plan`'s view both
 * consume this one plan, so they cannot disagree on any of it. The live check
 * adds only per-stop state: the block counter and cap, the repository root and
 * the runner lock.
 *
 * Callers import this module directly. The `acceptance-contract` barrel does
 * not re-export it, because `verification-manifest` reaches back into the
 * barrel through other core modules, and a re-export would close an import
 * cycle.
 *
 * Pure and total: no I/O, no clock, no throw.
 */

import type { StopCheckOffReason } from "../stop-check-plan-types";
import { acceptanceRunnerCheck } from "../verification-manifest";
import type { TaskGraph } from "../../types";
import { stopCheckExpectation, type OwedStopCheck } from "./stop-check";

/** The completion check `acceptanceRunnerCheck` forms for the owed files. */
export type AcceptanceRunnerCommand = Extract<ReturnType<typeof acceptanceRunnerCheck>, { ok: true }>["value"];

/** What the TaskGraph alone decides about one Task's stop. An `on` plan
 *  always has owed testcases and the command that runs their files. */
export type StopCheckPlan =
  | Readonly<{ kind: "unknown-task" }>
  | Readonly<{ kind: "off"; wave: number; reason: StopCheckOffReason }>
  | Readonly<{ kind: "on"; wave: number; check: OwedStopCheck; command: AcceptanceRunnerCommand; reportPath: string }>;

/** The plan for `taskId`'s stop. The off-reason precedence is the order the
 *  steps run in: no runner, then nothing owed, then the command refused. */
export function planStopCheck(graph: TaskGraph, taskId: string): StopCheckPlan {
  const task = graph.tasks.find(({ id }) => id === taskId);
  if (task === undefined) return Object.freeze({ kind: "unknown-task" });
  const off = (reason: StopCheckOffReason): StopCheckPlan => Object.freeze({ kind: "off", wave: task.wave, reason: Object.freeze(reason) });
  const runner = graph.verification_manifest?.acceptanceRunner;
  if (runner === undefined) return off({ kind: "no-runner" });
  const check = stopCheckExpectation(graph.acceptance_contracts ?? [], graph.tasks, task);
  if (check.kind === "none") return off({ kind: "nothing-owed" });
  const command = acceptanceRunnerCheck(runner, check.files);
  if (!command.ok) return off({ kind: "command-refused", errors: command.error.errors });
  return Object.freeze({ kind: "on", wave: task.wave, check, command: command.value, reportPath: runner.report.path });
}
