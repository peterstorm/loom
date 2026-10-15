/**
 * Stop-Check Plan (CT-1): what the Acceptance Stop Check would do at one
 * Task's stop, decided from a parsed TaskGraph and rendered as lines.
 *
 * Three pure steps. `planStopCheck` is everything the TaskGraph alone decides
 * about a stop: the runner from the frozen verification manifest, what is owed
 * from `stopCheckExpectation`, and the command from `acceptanceRunnerCheck`.
 * The live check's `decideStop` consumes it and adds only per-stop state: the
 * Agent's block counter and cap, the repository root and the runner lock. So
 * the plan and the check cannot disagree on anything the TaskGraph decides.
 * The off-reason precedence is the order those steps run in: no runner, then
 * nothing owed, then the command refused. `stopCheckPlanView` projects the
 * plan into the frozen view, and `renderStopCheckPlan` formats the view in the
 * frozen line grammar. All three are total: no I/O, no clock, no throw.
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
