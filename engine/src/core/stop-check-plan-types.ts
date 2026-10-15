/**
 * The surface of `helper stop-check-plan`: the view a TaskGraph and Task id
 * project into, the rendering the shell prints, the signatures of the pure
 * projection and renderer, and the fixed text the output grammar uses. No
 * logic lives here. It is Acceptance Contract CT-1's frozen types file.
 *
 * Every fact a view carries comes from the functions the live Acceptance Stop
 * Check calls (`stopCheckExpectation`, `acceptanceRunnerCheck`); nothing here
 * re-derives what is owed or how the runner command is formed.
 */

import type { OwedAcceptance } from "./acceptance-contract";
import type { NonEmpty } from "./orchestration-contract";
import type { TaskGraph } from "../types";

/** Why the check would do nothing at this Task's stop. Exactly one, in this
 *  precedence: no runner, then nothing owed, then the command refused. */
export type StopCheckOffReason =
  | Readonly<{ kind: "no-runner" }>
  | Readonly<{ kind: "nothing-owed" }>
  /** acceptanceRunnerCheck refused the owed files; `errors` is its refusal text. */
  | Readonly<{ kind: "command-refused"; errors: NonEmpty<string> }>;

/** The exact command the check would launch, read off acceptanceRunnerCheck's value. */
export type StopCheckRunnerCommand = Readonly<{
  /** The executable followed by its args after {files} expansion; each owed
   *  file, relative to `cwd`, is one element. */
  argv: NonEmpty<string>;
  cwd: string;
  reportPath: string;
}>;

/** What the Acceptance Stop Check would do at one Task's stop. An `on` view
 *  always has owed testcases, their files and a formed command. */
export type StopCheckPlanView =
  | Readonly<{ kind: "unknown-task"; taskId: string }>
  | Readonly<{ kind: "off"; taskId: string; wave: number; reason: StopCheckOffReason }>
  | Readonly<{
      kind: "on";
      taskId: string;
      wave: number;
      /** stopCheckExpectation's `owed`, in its order. */
      owed: NonEmpty<OwedAcceptance>;
      /** stopCheckExpectation's `files`, repository-relative, in its order. */
      files: NonEmpty<string>;
      command: StopCheckRunnerCommand;
    }>;

/** The plan as the shell consumes it: lines to print, or a refusal naming the id. */
export type StopCheckPlanRendering =
  | Readonly<{ kind: "rendered"; lines: NonEmpty<string> }>
  | Readonly<{ kind: "unknown-task"; taskId: string; message: string }>;

/** Project a TaskGraph and Task id into the plan view. Pure and total. */
export type StopCheckPlanViewFn = (graph: TaskGraph, taskId: string) => StopCheckPlanView;

/** Render the plan for one Task. Pure and total; never runs the runner. */
export type RenderStopCheckPlanFn = (graph: TaskGraph, taskId: string) => StopCheckPlanRendering;

/** Header suffix of an `on` view: `${taskId} (Wave ${wave}): ${STOP_CHECK_ON}`. */
export const STOP_CHECK_ON = "acceptance stop check on";

/** Header suffix of an `off` view, followed by ` — ${reason text}`. */
export const STOP_CHECK_OFF = "acceptance stop check off";

/** The one line each off-reason renders after `STOP_CHECK_OFF — `. */
export const STOP_CHECK_OFF_REASON_TEXT: Readonly<Record<StopCheckOffReason["kind"], string>> = {
  "no-runner": "no acceptance runner is frozen in this TaskGraph",
  "nothing-owed": "this Task owes no frozen acceptance testcase due by its Wave",
  "command-refused": "the runner command could not be formed for the owed files",
};

/** An unknown id's message: `${UNKNOWN_TASK_PREFIX} ${taskId} in the TaskGraph`. */
export const UNKNOWN_TASK_PREFIX = "No task";
