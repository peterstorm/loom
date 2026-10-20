/**
 * Red-Then-Green Status: print where one Task stands on I6, the
 * red-then-green proof obligation: whether it owes I6 (or the one reason it
 * does not), how settlement splits its `file_list`, the judgment over a live
 * Claude Code attempt's epoch so far, and the stored result in its Proof.
 *
 * A read-only shell around the pure `renderRedThenGreenStatus`. It parses
 * `--task <id>`, locates and loads the TaskGraph, resolves the Task's live
 * attempt through `liveAttemptEvidence` (the port `stop-check-plan` reads,
 * never asked under Pi) and the repository root it is judged against, renders
 * and writes the lines. It never writes the State File, the ledger or the
 * runtime directory, and never takes the TaskGraph lock (FR-007).
 *
 * Refusals: a missing TaskGraph names the path looked for; an unreadable or
 * corrupt one surfaces the load boundary's error; an unknown Task id names the
 * id. Every degraded live state (uninspectable sidecars, several live
 * attempts, an unreadable epoch, an unresolvable repository root) renders as
 * its own line and exits 0.
 */

import { match } from "ts-pattern";
import type { HookHandler, HookResult, TaskGraph } from "../../types";
import { HARNESS, taskGraphPath } from "../../config";
import { StateManager } from "../../state-manager";
import {
  renderRedThenGreenStatus,
  type RedThenGreenLiveInput,
  type RedThenGreenStatusRendering,
} from "../../core/red-then-green-status";
import { PRODUCTION_STOP_CHECK_PORTS, type StopCheckShellPorts } from "../subagent-stop/acceptance-stop-check";
import { argumentValue, unconsumedValueArguments } from "./cli-args";
import { claudeLiveAttemptEvidence, type LiveAttemptEvidenceFn } from "./stop-check-plan";

const FLAGS: ReadonlySet<string> = new Set(["--task"]);

const toStdout = (text: string): void => {
  process.stdout.write(text);
};

/** What the helper needs beyond the live-attempt port: the root a live epoch is judged against. */
export type RedThenGreenStatusPorts = Pick<StopCheckShellPorts, "repositoryRoot">;

const NOT_OBSERVABLE: RedThenGreenLiveInput = Object.freeze({ kind: "not-observable" });

const describe = (cause: unknown): string => cause instanceof Error ? cause.message : String(cause);

/** The Task id the operator named, or the refusal of the command line. */
function parseTaskArgument(args: readonly string[]): Readonly<{ ok: true; taskId: string }> | Readonly<{ ok: false; message: string }> {
  const unconsumed = unconsumedValueArguments(args, FLAGS);
  if (unconsumed.length > 0) {
    return { ok: false, message: `red-then-green-status: unknown or unconsumed argument(s): ${unconsumed.join(" ")}` };
  }
  const taskId = argumentValue(args, "--task");
  return taskId === null
    ? { ok: false, message: "red-then-green-status requires --task <task-id>" }
    : { ok: true, taskId };
}

/**
 * The core's live input. Pi keeps a child's epoch in its parent process, so
 * there the port is never asked. A live attempt is judged against the
 * TaskGraph's repository root, resolved only for a readable ledger; an
 * unreadable ledger or an unresolvable root reads as an unreadable epoch, so
 * it renders rather than refuses.
 */
function liveInput(
  harness: "claude" | "pi",
  taskId: string,
  statePath: string,
  liveAttemptEvidence: LiveAttemptEvidenceFn,
  ports: RedThenGreenStatusPorts,
): RedThenGreenLiveInput {
  if (harness === "pi") return NOT_OBSERVABLE;
  const live = liveAttemptEvidence(taskId, statePath);
  if (live.kind !== "live") return live;
  if (live.ledger.kind === "unreadable") return Object.freeze({ kind: "unreadable", reason: live.ledger.reason });
  const root = ports.repositoryRoot(statePath);
  return root.ok
    ? Object.freeze({ kind: "live", events: live.ledger.events, repositoryRoot: root.root })
    : Object.freeze({ kind: "unreadable", reason: root.reason });
}

function renderedResult(write: (text: string) => void, rendering: RedThenGreenStatusRendering): HookResult {
  return match(rendering)
    .returnType<HookResult>()
    .with({ kind: "rendered" }, ({ lines }) => {
      write(`${lines.join("\n")}\n`);
      return { kind: "passthrough" };
    })
    .with({ kind: "unknown-task" }, ({ message }) => ({ kind: "error", message }))
    .exhaustive();
}

export function createRedThenGreenStatusHandler(
  write: (text: string) => void = toStdout,
  liveAttemptEvidence: LiveAttemptEvidenceFn = claudeLiveAttemptEvidence,
  ports: RedThenGreenStatusPorts = PRODUCTION_STOP_CHECK_PORTS,
  harness: "claude" | "pi" = HARNESS,
): HookHandler {
  return async (_stdin, args) => {
    const parsed = parseTaskArgument(args);
    if (!parsed.ok) return { kind: "error", message: parsed.message };

    const statePath = taskGraphPath();
    const manager = StateManager.fromPath(statePath);
    if (manager === null) return { kind: "error", message: `No task graph at ${statePath}` };

    // Only the load boundary may refuse: the renderer is pure and total, so a
    // throw from it is a defect and must crash rather than read as a refusal.
    let graph: TaskGraph;
    try {
      graph = manager.load();
    } catch (error) {
      return { kind: "error", message: describe(error) };
    }
    // An unknown id has no live attempt, so the renderer refuses it naming the id.
    const live = liveInput(harness, parsed.taskId, manager.getPath(), liveAttemptEvidence, ports);
    return renderedResult(write, renderRedThenGreenStatus({ graph, taskId: parsed.taskId, live }));
  };
}

export default createRedThenGreenStatusHandler();
