/**
 * Stop-Check Plan (CT-1): print what the Acceptance Stop Check would do at one
 * Task's stop — the owed testcases by contract, the acceptance files, the
 * runner cwd, argv and report path — or the one reason it would do nothing.
 *
 * A read-only shell around the pure `renderStopCheckPlan`: it parses
 * `--task <id>`, locates the TaskGraph, loads it, renders and writes the
 * lines. It never runs the runner, never writes the State File and never takes
 * the TaskGraph lock (FR-005). A missing TaskGraph is refused with the path
 * looked for; an unreadable or corrupt one surfaces the parser's error rather
 * than reading as missing; an unknown Task id is refused naming the id, so a
 * typo never reads as "nothing owed".
 */

import { match } from "ts-pattern";
import type { HookHandler } from "../../types";
import { taskGraphPath } from "../../config";
import { StateManager } from "../../state-manager";
import { renderStopCheckPlan } from "../../core/acceptance-contract/stop-check-plan";
import type { RenderStopCheckPlanFn } from "../../core/stop-check-plan-types";
import { argumentValue, unconsumedValueArguments } from "./cli-args";

const FLAGS: ReadonlySet<string> = new Set(["--task"]);

const toStdout = (text: string): void => {
  process.stdout.write(text);
};

/** The Task id the operator named, or the refusal of the command line. */
function parseTaskArgument(args: readonly string[]): Readonly<{ ok: true; taskId: string }> | Readonly<{ ok: false; message: string }> {
  const unconsumed = unconsumedValueArguments(args, FLAGS);
  if (unconsumed.length > 0) {
    return { ok: false, message: `stop-check-plan: unknown or unconsumed argument(s): ${unconsumed.join(" ")}` };
  }
  const taskId = argumentValue(args, "--task");
  return taskId === null
    ? { ok: false, message: "stop-check-plan requires --task <task-id>" }
    : { ok: true, taskId };
}

export function createStopCheckPlanHandler(
  write: (text: string) => void = toStdout,
  render: RenderStopCheckPlanFn = renderStopCheckPlan,
): HookHandler {
  return async (_stdin, args) => {
    const parsed = parseTaskArgument(args);
    if (!parsed.ok) return { kind: "error", message: parsed.message };

    const statePath = taskGraphPath();
    const manager = StateManager.fromPath(statePath);
    if (manager === null) return { kind: "error", message: `No task graph at ${statePath}` };

    // Only the load boundary may refuse: the renderer is pure and total, so a
    // throw from it is a defect and must crash rather than read as a refusal.
    let graph: ReturnType<StateManager["load"]>;
    try {
      graph = manager.load();
    } catch (error) {
      return { kind: "error", message: error instanceof Error ? error.message : String(error) };
    }

    return match(render(graph, parsed.taskId))
      .with({ kind: "rendered" }, ({ lines }) => {
        write(`${lines.join("\n")}\n`);
        return { kind: "passthrough" } as const;
      })
      .with({ kind: "unknown-task" }, ({ message }) => ({ kind: "error", message }) as const)
      .exhaustive();
  };
}

export default createStopCheckPlanHandler();
