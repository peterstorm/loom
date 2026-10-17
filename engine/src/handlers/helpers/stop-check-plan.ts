/**
 * Stop-Check Plan (CT-1, CT-2): print what both stop checks would do at one
 * Task's stop.
 * - The acceptance check: the owed testcases by contract, the acceptance
 *   files, the runner cwd, argv and report path, or the one reason it is off.
 * - The affected check: the Task's current changed files, the runner argv
 *   after `{files}` expansion, its cwd and report path, or the one reason it
 *   is off.
 *
 * A read-only shell around the pure `renderStopChecksPlan`, which reads the
 * same `planStopChecks` the live stop shell runs (INV-1). It parses
 * `--task <id>`, locates and loads the TaskGraph, resolves the Task's live
 * attempt epoch through `liveAttemptEvidence`, derives the changed files from
 * it through `changedFilesAtStop` (INV-7), renders and writes the lines. It
 * never runs a runner, never writes the State File, the ledger or the runtime
 * directory, and never takes the TaskGraph lock (FR-005, FR-029).
 *
 * Refusals: a missing TaskGraph names the path looked for; an unreadable or
 * corrupt one surfaces the parser's error rather than reading as missing; an
 * unknown Task id names the id, so a typo never reads as "nothing owed"; a
 * live attempt whose ledger epoch cannot be read surfaces why, rather than
 * reading as "no changed files".
 */

import { readdirSync, realpathSync } from "node:fs";
import { match } from "ts-pattern";
import type { HookHandler, TaskGraph } from "../../types";
import { subagentDir, taskGraphPath } from "../../config";
import { StateManager } from "../../state-manager";
import { renderStopChecksPlan } from "../../core/acceptance-contract/stop-check-plan";
import type { ChangedFiles, RenderStopChecksPlanFn } from "../../core/affected-stop-check-types";
import { NO_CHANGED_FILES } from "../../core/changed-files";
import type { LedgerObservation } from "../../core/red-then-green-types";
import {
  epochOf,
  eventsForEpoch,
  IMPLEMENTATION_ATTEMPT_SIDECAR_SUFFIX,
  parseSessionId,
  readActiveAgentRoles,
  readEvidence,
  type AgentType,
} from "../../machine";
import { snapshotImplementationAttemptSidecar, type ClaudeImplementationAttemptSidecar } from "../../implementation-attempt-sidecar";
import { PRODUCTION_STOP_CHECK_PORTS, type StopCheckShellPorts } from "../subagent-stop/acceptance-stop-check";
import { epochChangedFiles } from "../subagent-stop/stop-checks";
import { argumentValue, unconsumedValueArguments } from "./cli-args";

const FLAGS: ReadonlySet<string> = new Set(["--task"]);

const toStdout = (text: string): void => {
  process.stdout.write(text);
};

/** A Task's live attempt, as the plan view finds it read-only. */
export type LiveAttemptEvidence =
  | Readonly<{ kind: "no-live-attempt" }>
  | Readonly<{ kind: "live"; ledger: LedgerObservation }>;

/** The read-only port: the live attempt of `taskId` against the TaskGraph at `statePath`. */
export type LiveAttemptEvidenceFn = (taskId: string, statePath: string) => LiveAttemptEvidence;

/** What the helper needs to turn an epoch into changed files: the repository root and the existence predicate. */
export type StopCheckPlanPorts = Pick<StopCheckShellPorts, "repositoryRoot" | "pathExists">;

const NO_LIVE_ATTEMPT: LiveAttemptEvidence = Object.freeze({ kind: "no-live-attempt" });

const describe = (cause: unknown): string => cause instanceof Error ? cause.message : String(cause);

/** The session and agent a sidecar's file name encodes, or null for any other entry. */
function sidecarIdentity(leaf: string): Readonly<{ sessionId: string; agentId: string }> | null {
  if (!leaf.endsWith(IMPLEMENTATION_ATTEMPT_SIDECAR_SUFFIX)) return null;
  const stem = leaf.slice(0, -IMPLEMENTATION_ATTEMPT_SIDECAR_SUFFIX.length);
  const dot = stem.lastIndexOf(".");
  if (dot <= 0) return null;
  const hex = stem.slice(dot + 1);
  if (!/^(?:[0-9a-f]{2})+$/.test(hex)) return null;
  return Object.freeze({ sessionId: stem.slice(0, dot), agentId: Buffer.from(hex, "hex").toString("utf8") });
}

/**
 * The Claude implementation sidecars whose authority names `taskId` on this
 * TaskGraph, with the role their agent is rostered under. A sidecar whose
 * agent is no longer on its session roster belongs to an attempt that has
 * ended.
 */
function liveClaudeAttempts(taskId: string, canonicalStatePath: string): readonly Readonly<{ sidecar: ClaudeImplementationAttemptSidecar; agentType: AgentType | null }>[] {
  let leaves: readonly string[];
  try {
    leaves = readdirSync(subagentDir());
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  return leaves.flatMap((leaf) => {
    const identity = sidecarIdentity(leaf);
    if (identity === null) return [];
    const observed = snapshotImplementationAttemptSidecar(identity.sessionId, identity.agentId);
    if (observed.kind !== "authority-observed") return [];
    const { sidecar } = observed;
    if (sidecar.authority.taskId !== taskId || sidecar.canonicalTaskGraphPath !== canonicalStatePath) return [];
    const rostered = readActiveAgentRoles(sidecar.sessionId).find(({ agentId }) => agentId === sidecar.agentId);
    return rostered === undefined ? [] : [Object.freeze({ sidecar, agentType: rostered.agentType })];
  });
}

/**
 * Production `liveAttemptEvidence` for Claude Code: the one live
 * implementation sidecar naming the Task, read back with its epoch from the
 * session ledger. Read-only: it lists, opens and reads, and creates nothing.
 *
 * Pi keeps its reservation slots and write-grant tokens in the parent Pi
 * process, and a consumed grant leaves no record naming its Task on disk, so a
 * separate helper process cannot resolve a Pi child's epoch: for a Pi run this
 * reads as no live attempt.
 */
export const claudeLiveAttemptEvidence: LiveAttemptEvidenceFn = (taskId, statePath) => {
  const attempts = liveClaudeAttempts(taskId, realpathSync.native(statePath));
  if (attempts.length === 0) return NO_LIVE_ATTEMPT;
  if (attempts.length > 1) {
    return Object.freeze({ kind: "live", ledger: Object.freeze({ kind: "unreadable", reason: `${attempts.length} live implementation attempts name ${taskId}` }) });
  }
  const [{ sidecar, agentType }] = attempts as [(typeof attempts)[number]];
  const session = parseSessionId(sidecar.sessionId);
  if (agentType === null || session === null) {
    return Object.freeze({ kind: "live", ledger: Object.freeze({ kind: "unreadable", reason: `the live attempt of ${taskId} is rostered without a parseable role` }) });
  }
  try {
    return Object.freeze({ kind: "live", ledger: Object.freeze({ kind: "read", events: eventsForEpoch(readEvidence(session), epochOf(sidecar.agentId, agentType)) }) });
  } catch (error) {
    return Object.freeze({ kind: "live", ledger: Object.freeze({ kind: "unreadable", reason: describe(error) }) });
  }
};

/** The changed files the plan renders: none without a live attempt, else the epoch's, or why they cannot be read. */
function planChangedFiles(live: LiveAttemptEvidence, statePath: string, ports: StopCheckPlanPorts):
  Readonly<{ ok: true; changed: ChangedFiles }> | Readonly<{ ok: false; message: string }> {
  if (live.kind === "no-live-attempt") return { ok: true, changed: NO_CHANGED_FILES };
  const root = ports.repositoryRoot(statePath);
  if (!root.ok) return { ok: false, message: `stop-check-plan: ${root.reason}` };
  const observed = epochChangedFiles(live.ledger, ports.pathExists)(root.root);
  return observed.kind === "observed"
    ? { ok: true, changed: observed.changed }
    : { ok: false, message: `stop-check-plan: ${observed.reason}` };
}

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
  render: RenderStopChecksPlanFn = renderStopChecksPlan,
  liveAttemptEvidence: LiveAttemptEvidenceFn = claudeLiveAttemptEvidence,
  ports: StopCheckPlanPorts = PRODUCTION_STOP_CHECK_PORTS,
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
    const changed = planChangedFiles(liveAttemptEvidence(parsed.taskId, manager.getPath()), manager.getPath(), ports);
    if (!changed.ok) return { kind: "error", message: changed.message };
    return renderedResult(write, render(graph, parsed.taskId, changed.changed));
  };
}

function renderedResult(write: (text: string) => void, rendering: ReturnType<RenderStopChecksPlanFn>) {
  return match(rendering)
    .with({ kind: "rendered" }, ({ lines }) => {
      write(`${lines.join("\n")}\n`);
      return { kind: "passthrough" } as const;
    })
    .with({ kind: "unknown-task" }, ({ message }) => ({ kind: "error", message }) as const)
    .exhaustive();
}

export default createStopCheckPlanHandler();
