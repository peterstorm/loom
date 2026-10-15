/**
 * Stop-Check Plan (CT-1): what the Acceptance Stop Check would do at one
 * Task's stop, projected from a parsed TaskGraph and rendered as lines.
 *
 * Two pure steps over `planStopCheck`, the same plan the live check's
 * `decideStop` consumes, so the view and the check cannot disagree on
 * anything the TaskGraph decides. `stopCheckPlanView` projects the plan into
 * the frozen view, and `renderStopCheckPlan` formats the view in the frozen
 * line grammar. Both are total: no I/O, no clock, no throw.
 */

import { match } from "ts-pattern";
import {
  STOP_CHECK_OFF,
  STOP_CHECK_OFF_REASON_TEXT,
  STOP_CHECK_ON,
  UNKNOWN_TASK_PREFIX,
  type RenderStopCheckPlanFn,
  type StopCheckPlanRendering,
  type StopCheckPlanView,
  type StopCheckPlanViewFn,
} from "../stop-check-plan-types";
import { planStopCheck } from "./stop-check-planner";

export const stopCheckPlanView: StopCheckPlanViewFn = (graph, taskId) =>
  match(planStopCheck(graph, taskId))
    .returnType<StopCheckPlanView>()
    .with({ kind: "unknown-task" }, () => Object.freeze({ kind: "unknown-task", taskId }))
    .with({ kind: "off" }, ({ wave, reason }) => Object.freeze({ kind: "off", taskId, wave, reason }))
    .with({ kind: "on" }, ({ wave, check, command, reportPath }) => Object.freeze({
      kind: "on",
      taskId,
      wave,
      owed: check.owed,
      files: check.files,
      command: Object.freeze({
        argv: Object.freeze([command.executable, ...command.args] as const),
        cwd: command.cwd,
        reportPath,
      }),
    }))
    .exhaustive();

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
