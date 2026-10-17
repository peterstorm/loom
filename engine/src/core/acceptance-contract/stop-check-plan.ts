/**
 * Stop-Check Plan: what both stop checks would do at one Task's stop,
 * projected from a parsed TaskGraph and the Task's changed files, and rendered
 * as lines.
 *
 * Every step reads `planStopChecks`, the one plan the live stop shell
 * consumes (INV-1), so the view and the checks cannot disagree on anything the
 * TaskGraph and the changed files decide.
 * - CT-1: `stopCheckPlanView` and `renderStopCheckPlan` project and print the
 *   acceptance arm in the frozen CT-1 grammar.
 * - CT-2: `stopChecksPlanView` and `renderStopChecksPlan` add the affected
 *   arm. They print the unchanged CT-1 lines, then an `affected tests:`
 *   section (AD-11, FR-028).
 *
 * All four are total: no I/O, no clock, no throw.
 */

import { match } from "ts-pattern";
import {
  AFFECTED_OFF_REASON_TEXT,
  AFFECTED_OUTSIDE_CWD_PREFIX,
  AFFECTED_SECTION_HEADING,
  AFFECTED_STOP_CHECK_OFF,
  type AcceptancePlan,
  type AffectedOffReason,
  type AffectedPlan,
  type AffectedStopCheckView,
  type RenderStopChecksPlanFn,
  type StopCheckCommand,
  type StopChecksPlanView,
  type StopChecksPlanViewFn,
} from "../affected-stop-check-types";
import {
  STOP_CHECK_OFF,
  STOP_CHECK_OFF_REASON_TEXT,
  STOP_CHECK_ON,
  UNKNOWN_TASK_PREFIX,
  type RenderStopCheckPlanFn,
  type StopCheckPlanRendering,
  type StopCheckPlanView,
  type StopCheckPlanViewFn,
  type StopCheckRunnerCommand,
} from "../stop-check-plan-types";
import { NO_CHANGED_FILES } from "../changed-files";
import { freeze } from "./kernel";
import { planStopChecks } from "./stop-check-planner";

type KnownAcceptanceView = Exclude<StopCheckPlanView, { kind: "unknown-task" }>;

const runnerCommand = (command: StopCheckCommand, reportPath: string): StopCheckRunnerCommand => freeze({
  argv: freeze([command.executable, ...command.args] as const),
  cwd: command.cwd,
  reportPath,
});

const acceptanceView = (taskId: string, wave: number, plan: AcceptancePlan): KnownAcceptanceView =>
  match(plan)
    .returnType<KnownAcceptanceView>()
    .with({ kind: "off" }, ({ reason }) => freeze({ kind: "off", taskId, wave, reason }))
    .with({ kind: "on" }, ({ check, command, reportPath }) => freeze({
      kind: "on",
      taskId,
      wave,
      owed: check.owed,
      files: check.files,
      command: runnerCommand(command, reportPath),
    }))
    .exhaustive();

const affectedView = (plan: AffectedPlan): AffectedStopCheckView =>
  match(plan)
    .returnType<AffectedStopCheckView>()
    .with({ kind: "off" }, ({ reason }) => freeze({ kind: "off", reason }))
    .with({ kind: "on" }, ({ files, command, reportPath }) => freeze({ kind: "on", files, command: runnerCommand(command, reportPath) }))
    .exhaustive();

/** The CT-1 view asks only about the acceptance arm, which no changed file affects. */
export const stopCheckPlanView: StopCheckPlanViewFn = (graph, taskId) => {
  const plan = planStopChecks(graph, taskId, NO_CHANGED_FILES);
  return plan.kind === "unknown-task"
    ? freeze({ kind: "unknown-task", taskId })
    : acceptanceView(taskId, plan.wave, plan.acceptance);
};

export const stopChecksPlanView: StopChecksPlanViewFn = (graph, taskId, changed) => {
  const plan = planStopChecks(graph, taskId, changed);
  return plan.kind === "unknown-task"
    ? freeze<StopChecksPlanView>({ kind: "unknown-task", taskId })
    : freeze({ kind: "known", acceptance: acceptanceView(taskId, plan.wave, plan.acceptance), affected: affectedView(plan.affected) });
};

const header = (taskId: string, wave: number): string => `${taskId} (Wave ${wave}): `;

/** The CT-1 lines of a known Task's acceptance view. */
const acceptanceLines = (view: KnownAcceptanceView): readonly [string, ...string[]] =>
  match(view)
    .returnType<readonly [string, ...string[]]>()
    .with({ kind: "off" }, ({ taskId, wave, reason }) => [
      `${header(taskId, wave)}${STOP_CHECK_OFF} — ${STOP_CHECK_OFF_REASON_TEXT[reason.kind]}`,
      ...(reason.kind === "command-refused" ? reason.errors.map((error) => `  ${error}`) : []),
    ])
    .with({ kind: "on" }, ({ taskId, wave, owed, files, command }) => [
      `${header(taskId, wave)}${STOP_CHECK_ON}`,
      ...owed.flatMap(({ contractId, testcases }) => [contractId, ...testcases.map(({ file, name }) => `  ${file} › ${name}`)]),
      "files:",
      ...files.map((file) => `  ${file}`),
      `cwd: ${command.cwd}`,
      `argv: ${JSON.stringify(command.argv)}`,
      `report: ${command.reportPath}`,
    ])
    .exhaustive();

/** The detail lines under an off affected check: what lies outside the runner
 *  cwd, or why the builder refused the command. */
const affectedOffDetail = (reason: AffectedOffReason): readonly string[] =>
  match(reason)
    .returnType<readonly string[]>()
    .with({ kind: "no-runner" }, () => [])
    .with({ kind: "no-changed-files" }, ({ outsideCwd }) => (outsideCwd ?? []).map((file) => `    ${AFFECTED_OUTSIDE_CWD_PREFIX}: ${file}`))
    .with({ kind: "command-refused" }, ({ errors }) => errors.map((error) => `    ${error}`))
    .exhaustive();

/** The affected section, in the grammar `RenderStopChecksPlanFn` documents. */
const affectedLines = (view: AffectedStopCheckView): readonly string[] => [
  AFFECTED_SECTION_HEADING,
  ...match(view)
    .returnType<readonly string[]>()
    .with({ kind: "off" }, ({ reason }) => [
      `  ${AFFECTED_STOP_CHECK_OFF} — ${AFFECTED_OFF_REASON_TEXT[reason.kind]}`,
      ...affectedOffDetail(reason),
    ])
    .with({ kind: "on" }, ({ files, command }) => [
      "  changed files:",
      ...files.map((file) => `    ${file}`),
      `  cwd: ${command.cwd}`,
      `  argv: ${JSON.stringify(command.argv)}`,
      `  report: ${command.reportPath}`,
    ])
    .exhaustive(),
];

const unknownTask = (taskId: string): StopCheckPlanRendering =>
  freeze({ kind: "unknown-task", taskId, message: `${UNKNOWN_TASK_PREFIX} ${taskId} in the TaskGraph` });

export const renderStopCheckPlan: RenderStopCheckPlanFn = (graph, taskId) => {
  const view = stopCheckPlanView(graph, taskId);
  return view.kind === "unknown-task" ? unknownTask(taskId) : freeze({ kind: "rendered", lines: freeze(acceptanceLines(view)) });
};

export const renderStopChecksPlan: RenderStopChecksPlanFn = (graph, taskId, changed) => {
  const view = stopChecksPlanView(graph, taskId, changed);
  return view.kind === "unknown-task"
    ? unknownTask(taskId)
    : freeze({ kind: "rendered", lines: freeze([...acceptanceLines(view.acceptance), ...affectedLines(view.affected)] as const) });
};
