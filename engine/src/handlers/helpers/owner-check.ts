/**
 * Task owner check (ADR-0092): run the Wave Gate's Owner Verification over the
 * owned Invariants one Task writes, print what the matrix test misses or lets
 * survive, and leave the runtime record a stop reads.
 * Usage: bun cli.ts helper owner-check --task <task-id>
 *
 * A shell around the pure core (`core/task-owner-check.ts`): it parses
 * `--task`, loads the TaskGraph, asks `taskOwnerCheckDuty` whether the Task
 * owes the check, digests the family's inputs, runs `runTaskOwnerCheck`, and
 * writes the record under that digest.
 *
 * It never writes the State File, the ledger, Proof or the real workspace's
 * files. Its runner executions happen in worktrees outside the repository.
 *
 * Every result is printed and exits 0: findings, a clean run, a Task that owes
 * nothing and a run that could not decide are all answers. Only a command line
 * or TaskGraph that cannot be read, a Task id the TaskGraph does not hold, or a
 * record that cannot be written, is an error.
 */

import type { HookHandler, TaskGraph } from "../../types";
import { taskGraphPath } from "../../config";
import { StateManager } from "../../state-manager";
import {
  recordedTaskOwnerCheck,
  renderTaskOwnerCheckReport,
  TASK_OWNER_CHECK_OFF_TEXT,
  taskOwnerCheckDuty,
  taskOwnerCheckUnavailable,
  type OwedTaskOwnerCheck,
  type TaskOwnerCheckResult,
} from "../../core/task-owner-check";
import { observeTaskOwnerCheckDigest, writeTaskOwnerCheckRecord } from "../../orchestration/task-owner-check-record";
import { runTaskOwnerCheck, type TaskOwnerCheckRunInput } from "../../orchestration/task-owner-check-runner";
import { describeCause } from "../../utils/describe-cause";
import type { CanonicalRepositoryRoot } from "../../utils/workspace-digest";
import { PRODUCTION_STOP_CHECK_PORTS, type StopCheckShellPorts } from "../subagent-stop/acceptance-stop-check";
import { argumentValue, unconsumedValueArguments } from "./cli-args";

const FLAGS: ReadonlySet<string> = new Set(["--task"]);

/** What the helper reaches the world through. */
export type OwnerCheckPorts = Readonly<{
  write: (text: string) => void;
  repositoryRoot: StopCheckShellPorts["repositoryRoot"];
  run: (input: TaskOwnerCheckRunInput) => Promise<TaskOwnerCheckResult>;
  now: () => number;
  /** The runtime directory the record is kept in, or undefined for the engine's own. */
  recordDirectory?: string;
}>;

const PRODUCTION_PORTS: OwnerCheckPorts = Object.freeze({
  write: (text: string) => {
    process.stdout.write(text);
  },
  repositoryRoot: PRODUCTION_STOP_CHECK_PORTS.repositoryRoot,
  run: (input: TaskOwnerCheckRunInput) => runTaskOwnerCheck(input),
  now: () => Date.now(),
});

type Outcome<T> = Readonly<{ ok: true; value: T }> | Readonly<{ ok: false; message: string }>;

/** The Task id the caller named, or the refusal of the command line. */
function parseTaskArgument(args: readonly string[]): Outcome<string> {
  const unconsumed = unconsumedValueArguments(args, FLAGS);
  if (unconsumed.length > 0) return { ok: false, message: `owner-check: unknown or unconsumed argument(s): ${unconsumed.join(" ")}` };
  const taskId = argumentValue(args, "--task");
  return taskId === null ? { ok: false, message: "owner-check requires --task <task-id>" } : { ok: true, value: taskId };
}

/**
 * One run over the family as it is now, and the record of it. The record
 * carries the digest observed before the run; inputs that changed while it
 * ran make the result `unavailable`, and the record then reads as stale.
 */
async function runAndRecord(
  graph: TaskGraph,
  duty: OwedTaskOwnerCheck,
  root: CanonicalRepositoryRoot,
  ports: OwnerCheckPorts,
): Promise<Outcome<TaskOwnerCheckResult>> {
  const before = observeTaskOwnerCheckDigest(root, duty);
  if (!before.ok) return { ok: true, value: taskOwnerCheckUnavailable(`the family's files could not be digested: ${before.error}`) };
  const ran = await ports.run({ root, graph, duty, now: ports.now });
  const after = observeTaskOwnerCheckDigest(root, duty);
  const result = after.ok && after.value === before.value
    ? ran
    : taskOwnerCheckUnavailable("the family's files changed while the check ran; run it again once they are settled");
  const written = writeTaskOwnerCheckRecord(root, recordedTaskOwnerCheck(duty.taskId, before.value, result), ports.recordDirectory);
  return written.ok
    ? { ok: true, value: result }
    : { ok: false, message: `owner-check: the record could not be written (${written.error}); the result was:\n${renderTaskOwnerCheckReport(duty, result)}` };
}

export function createOwnerCheckHandler(ports: OwnerCheckPorts = PRODUCTION_PORTS): HookHandler {
  return async (_stdin, args) => {
    const parsed = parseTaskArgument(args);
    if (!parsed.ok) return { kind: "error", message: parsed.message };
    const taskId = parsed.value;

    const statePath = taskGraphPath();
    const manager = StateManager.fromPath(statePath);
    if (manager === null) return { kind: "error", message: `No task graph at ${statePath}` };
    let graph: TaskGraph;
    try {
      graph = manager.load();
    } catch (cause) {
      return { kind: "error", message: describeCause(cause) };
    }

    const duty = taskOwnerCheckDuty(graph, taskId);
    if (duty.kind === "off") {
      if (duty.reason === "unknown-task") return { kind: "error", message: `owner-check: Task ${taskId} is not in the TaskGraph at ${manager.getPath()}` };
      ports.write(`Task owner check for ${taskId}: not owed — ${TASK_OWNER_CHECK_OFF_TEXT[duty.reason]}.\n`);
      return { kind: "passthrough" };
    }
    const root = ports.repositoryRoot(manager.getPath());
    if (!root.ok) {
      ports.write(`${renderTaskOwnerCheckReport(duty, taskOwnerCheckUnavailable(root.reason))}\n`);
      return { kind: "passthrough" };
    }
    const outcome = await runAndRecord(graph, duty, root.root, ports);
    if (!outcome.ok) return { kind: "error", message: outcome.message };
    ports.write(`${renderTaskOwnerCheckReport(duty, outcome.value)}\n`);
    return { kind: "passthrough" };
  };
}

export default createOwnerCheckHandler();
