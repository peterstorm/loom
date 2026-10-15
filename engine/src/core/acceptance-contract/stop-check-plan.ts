/**
 * Stop-Check Plan (CT-1): what the Acceptance Stop Check would do at one
 * Task's stop, projected from a parsed TaskGraph and rendered as lines.
 *
 * Two pure steps. `stopCheckPlanView` follows the live check's `decideStop`
 * step for step (AD-2): the runner from the frozen verification manifest, what
 * is owed from `stopCheckExpectation`, and the command from
 * `acceptanceRunnerCheck`. It never re-derives either (FR-002). The off-reason
 * precedence is the order those steps run in (AD-3): no runner, then nothing
 * owed, then the command refused. `renderStopCheckPlan` formats the view in
 * the frozen line grammar. Both are total: no I/O, no clock, no throw.
 */

import { match } from "ts-pattern";
import {
  STOP_CHECK_OFF,
  STOP_CHECK_OFF_REASON_TEXT,
  STOP_CHECK_ON,
  UNKNOWN_TASK_PREFIX,
  type RenderStopCheckPlanFn,
  type StopCheckOffReason,
  type StopCheckPlanRendering,
  type StopCheckPlanView,
  type StopCheckPlanViewFn,
} from "../stop-check-plan-types";
import { acceptanceRunnerCheck } from "../verification-manifest";
import { stopCheckExpectation } from "./stop-check";

const off = (taskId: string, wave: number, reason: StopCheckOffReason): StopCheckPlanView =>
  Object.freeze({ kind: "off", taskId, wave, reason: Object.freeze(reason) });

export const stopCheckPlanView: StopCheckPlanViewFn = (graph, taskId) => {
  const task = graph.tasks.find(({ id }) => id === taskId);
  if (task === undefined) return Object.freeze({ kind: "unknown-task", taskId });
  const runner = graph.verification_manifest?.acceptanceRunner;
  if (runner === undefined) return off(taskId, task.wave, { kind: "no-runner" });
  const check = stopCheckExpectation(graph.acceptance_contracts ?? [], graph.tasks, task);
  if (check.kind === "none") return off(taskId, task.wave, { kind: "nothing-owed" });
  const command = acceptanceRunnerCheck(runner, check.files);
  if (!command.ok) return off(taskId, task.wave, { kind: "command-refused", errors: command.error.errors });
  return Object.freeze({
    kind: "on",
    taskId,
    wave: task.wave,
    owed: check.owed,
    files: check.files,
    command: Object.freeze({
      argv: Object.freeze([command.value.executable, ...command.value.args] as const),
      cwd: command.value.cwd,
      reportPath: runner.report.path,
    }),
  });
};

const header = (taskId: string, wave: number): string => `${taskId} (Wave ${wave}): `;

/** The lines of a known Task's view; an unknown id never reaches here. */
function viewLines(view: Exclude<StopCheckPlanView, { kind: "unknown-task" }>): Extract<StopCheckPlanRendering, { kind: "rendered" }> {
  const lines = match(view)
    .with({ kind: "off" }, ({ taskId, wave, reason }) => [
      `${header(taskId, wave)}${STOP_CHECK_OFF} — ${STOP_CHECK_OFF_REASON_TEXT[reason.kind]}`,
      ...(reason.kind === "command-refused" ? reason.errors.map((error) => `  ${error}`) : []),
    ] as const)
    .with({ kind: "on" }, ({ taskId, wave, owed, files, command }) => [
      `${header(taskId, wave)}${STOP_CHECK_ON}`,
      ...owed.flatMap(({ contractId, testcases }) => [contractId, ...testcases.map(({ file, name }) => `  ${file} › ${name}`)]),
      "files:",
      ...files.map((file) => `  ${file}`),
      `cwd: ${command.cwd}`,
      `argv: ${JSON.stringify(command.argv)}`,
      `report: ${command.reportPath}`,
    ] as const)
    .exhaustive();
  return Object.freeze({ kind: "rendered", lines: Object.freeze(lines) });
}

export const renderStopCheckPlan: RenderStopCheckPlanFn = (graph, taskId) => {
  const view = stopCheckPlanView(graph, taskId);
  return view.kind === "unknown-task"
    ? Object.freeze<StopCheckPlanRendering>({ kind: "unknown-task", taskId, message: `${UNKNOWN_TASK_PREFIX} ${taskId} in the TaskGraph` })
    : viewLines(view);
};
