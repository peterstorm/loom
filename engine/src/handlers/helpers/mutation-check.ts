/**
 * Task mutation check (ADR-0071): mutate the lines one Task changed, run the
 * Task's affected tests against each mutant in an isolated worktree, print
 * the mutants that survived, and leave the runtime record a stop reads.
 * Usage: bun cli.ts helper mutation-check --task <task-id>
 *
 * A shell around the pure core (`core/task-mutation-check.ts`): it parses
 * `--task`, loads the TaskGraph, asks `taskMutationDuty` whether the Task owes
 * the check, digests the Task's declared files, runs
 * `runTaskMutationCheck`, and writes the record under that digest.
 *
 * It never writes the State File, the ledger, Proof or the real workspace's
 * files. Its runner executions happen in a worktree outside the repository,
 * so they leave no test run and no report where the Task's own verification
 * is observed.
 *
 * Every result is printed and exits 0: survivors, a clean run, a Task that
 * owes nothing and a run that could not decide are all answers. Only a
 * command line or TaskGraph that cannot be read, or a record that cannot be
 * written, is an error.
 */

import type { HookHandler, TaskGraph } from "../../types";
import { taskGraphPath } from "../../config";
import { StateManager } from "../../state-manager";
import {
  recordedTaskMutation,
  renderTaskMutationReport,
  TASK_MUTATION_OFF_TEXT,
  taskMutationDuty,
  taskMutationUnavailable,
  type OwedTaskMutation,
  type TaskMutationResult,
} from "../../core/task-mutation-check";
import { observeTaskMutationDigest, writeTaskMutationRecord } from "../../orchestration/task-mutation-record";
import { runTaskMutationCheck, type TaskMutationRunInput } from "../../orchestration/task-mutation-runner";
import { describeCause } from "../../utils/describe-cause";
import type { CanonicalRepositoryRoot } from "../../utils/workspace-digest";
import { PRODUCTION_STOP_CHECK_PORTS, type StopCheckShellPorts } from "../subagent-stop/acceptance-stop-check";
import { argumentValue, unconsumedValueArguments } from "./cli-args";

const FLAGS: ReadonlySet<string> = new Set(["--task"]);

/** What the helper reaches the world through. */
export type MutationCheckPorts = Readonly<{
  write: (text: string) => void;
  repositoryRoot: StopCheckShellPorts["repositoryRoot"];
  run: (input: TaskMutationRunInput) => Promise<TaskMutationResult>;
  now: () => number;
  /** The runtime directory the record is kept in, or undefined for the engine's own. */
  recordDirectory?: string;
}>;

const PRODUCTION_PORTS: MutationCheckPorts = Object.freeze({
  write: (text: string) => {
    process.stdout.write(text);
  },
  repositoryRoot: PRODUCTION_STOP_CHECK_PORTS.repositoryRoot,
  run: runTaskMutationCheck,
  now: () => Date.now(),
});

/** The Task id the caller named, or the refusal of the command line. */
function parseTaskArgument(args: readonly string[]): Readonly<{ ok: true; taskId: string }> | Readonly<{ ok: false; message: string }> {
  const unconsumed = unconsumedValueArguments(args, FLAGS);
  if (unconsumed.length > 0) return { ok: false, message: `mutation-check: unknown or unconsumed argument(s): ${unconsumed.join(" ")}` };
  const taskId = argumentValue(args, "--task");
  return taskId === null ? { ok: false, message: "mutation-check requires --task <task-id>" } : { ok: true, taskId };
}

/**
 * One run over the Task's files as they are now, and the record of it. The
 * record carries the digest observed before the run; files that changed while
 * it ran make the result `unavailable`, and the record then reads as stale at
 * the next stop.
 */
async function runAndRecord(
  graph: TaskGraph,
  duty: OwedTaskMutation,
  root: CanonicalRepositoryRoot,
  ports: MutationCheckPorts,
): Promise<Readonly<{ ok: true; result: TaskMutationResult }> | Readonly<{ ok: false; message: string }>> {
  const before = observeTaskMutationDigest(root, duty);
  if (!before.ok) return { ok: true, result: taskMutationUnavailable(`the Task's files could not be digested: ${before.error}`) };
  const ran = await ports.run({ root, graph, duty, now: ports.now });
  const after = observeTaskMutationDigest(root, duty);
  const result = after.ok && after.value === before.value
    ? ran
    : taskMutationUnavailable("the Task's files changed while the check ran; run it again once they are settled");
  const written = writeTaskMutationRecord(root, recordedTaskMutation(duty.taskId, before.value, result), ports.recordDirectory);
  return written.ok
    ? { ok: true, result }
    : { ok: false, message: `mutation-check: the record could not be written (${written.error}); the result was:\n${renderTaskMutationReport(duty.taskId, result)}` };
}

export function createMutationCheckHandler(ports: MutationCheckPorts = PRODUCTION_PORTS): HookHandler {
  return async (_stdin, args) => {
    const parsed = parseTaskArgument(args);
    if (!parsed.ok) return { kind: "error", message: parsed.message };
    const { taskId } = parsed;

    const statePath = taskGraphPath();
    const manager = StateManager.fromPath(statePath);
    if (manager === null) return { kind: "error", message: `No task graph at ${statePath}` };
    let graph: TaskGraph;
    try {
      graph = manager.load();
    } catch (cause) {
      return { kind: "error", message: describeCause(cause) };
    }

    const duty = taskMutationDuty(graph, taskId);
    if (duty.kind === "off") {
      if (duty.reason === "unknown-task") return { kind: "error", message: `mutation-check: Task ${taskId} is not in the TaskGraph at ${manager.getPath()}` };
      ports.write(`Task mutation check for ${taskId}: not owed — ${TASK_MUTATION_OFF_TEXT[duty.reason]}.\n`);
      return { kind: "passthrough" };
    }
    const root = ports.repositoryRoot(manager.getPath());
    if (!root.ok) {
      ports.write(`${renderTaskMutationReport(taskId, taskMutationUnavailable(root.reason))}\n`);
      return { kind: "passthrough" };
    }
    const outcome = await runAndRecord(graph, duty, root.root, ports);
    if (!outcome.ok) return { kind: "error", message: outcome.message };
    ports.write(`${renderTaskMutationReport(taskId, outcome.result)}\n`);
    return { kind: "passthrough" };
  };
}

export default createMutationCheckHandler();
