/**
 * The one stop-check planner (INV-1, AD-9): everything the TaskGraph and the
 * Task's changed files decide about both checks at one Task's stop.
 * - The acceptance check: the runner from the frozen verification manifest,
 *   what is owed from `stopCheckExpectation`, and the command from
 *   `acceptanceRunnerCheck`.
 * - The affected check: the frozen `affectedRunner`, the changed files beneath
 *   its cwd, and the command from `affectedRunnerCheck`.
 *
 * The live stop shell and `helper stop-check-plan`'s view both consume this
 * one plan, so they cannot disagree on any of it. The shell adds only per-stop
 * state: the block counters and caps, the repository root, the runner lock
 * and the hook budget. The changed files are a parsed input, derived only by
 * `changedFilesAtStop` (INV-7); this module never reads the ledger.
 *
 * Callers import this module directly. The `acceptance-contract` barrel does
 * not re-export it, because `verification-manifest` reaches back into the
 * barrel through other core modules, and a re-export would close an import
 * cycle.
 *
 * Pure and total: no I/O, no clock, no throw.
 */

import type {
  AcceptancePlan,
  AffectedOffReason,
  AffectedPlan,
  ChangedFiles,
  PlanStopChecksFn,
  StopChecksPlan,
} from "../affected-stop-check-types";
import type { StopCheckOffReason } from "../stop-check-plan-types";
import { acceptanceRunnerCheck, affectedRunnerCheck, type FrozenVerificationManifest } from "../verification-manifest";
import type { Task, TaskGraph } from "../../types";
import { freeze, nonEmpty } from "./kernel";
import { stopCheckExpectation } from "./stop-check";

/** The off-reason precedence is the order the steps run in: no runner, then
 *  nothing owed, then the command refused. */
function acceptancePlan(graph: TaskGraph, task: Task, manifest: FrozenVerificationManifest | undefined): AcceptancePlan {
  const off = (reason: StopCheckOffReason): AcceptancePlan => freeze({ kind: "off", reason: freeze(reason) });
  const runner = manifest?.acceptanceRunner;
  if (runner === undefined) return off({ kind: "no-runner" });
  const check = stopCheckExpectation(graph.acceptance_contracts ?? [], graph.tasks, task);
  if (check.kind === "none") return off({ kind: "nothing-owed" });
  const command = acceptanceRunnerCheck(runner, check.files);
  if (!command.ok) return off({ kind: "command-refused", errors: command.error.errors });
  return freeze({ kind: "on", check, command: command.value, reportPath: runner.report.path });
}

/** Whether a repository-relative path lies beneath the runner's cwd. */
const beneath = (cwd: string, path: string): boolean => cwd === "." || path.startsWith(`${cwd}/`);

/** The off-reason precedence is the order the steps run in: no runner, then
 *  no changed files beneath the runner cwd, then the command refused. */
function affectedPlan(manifest: FrozenVerificationManifest | undefined, changed: ChangedFiles): AffectedPlan {
  const off = (reason: AffectedOffReason): AffectedPlan => freeze({ kind: "off", reason: freeze(reason) });
  const runner = manifest?.affectedRunner;
  if (runner === undefined) return off({ kind: "no-runner" });
  if (changed.kind === "none") return off({ kind: "no-changed-files", outsideCwd: null });
  const files = nonEmpty(changed.files.filter((path) => beneath(runner.cwd, path)));
  if (files === null) return off({ kind: "no-changed-files", outsideCwd: changed.files });
  const command = affectedRunnerCheck(runner, files);
  if (!command.ok) return off({ kind: "command-refused", errors: command.error.errors });
  return freeze({ kind: "on", files, command: command.value, reportPath: runner.report.path });
}

/** Both checks' plans for `taskId`'s stop, over the changed files the shell derived. */
export const planStopChecks: PlanStopChecksFn = (graph, taskId, changed): StopChecksPlan => {
  const task = graph.tasks.find(({ id }) => id === taskId);
  if (task === undefined) return freeze({ kind: "unknown-task" });
  const manifest = graph.verification_manifest;
  return freeze({
    kind: "known",
    wave: task.wave,
    acceptance: acceptancePlan(graph, task, manifest),
    affected: affectedPlan(manifest, changed),
  });
};
