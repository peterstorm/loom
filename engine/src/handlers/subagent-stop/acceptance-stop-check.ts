/**
 * The Acceptance Stop Check's shell (G4 slice 1). When a claimant's
 * implementation agent tries to stop, run its contract's acceptance files
 * through the operator-declared runner and, if a testcase it owes is still
 * not passing, block the stop so the same agent keeps working.
 *
 * Claude Code turns a SubagentStop exit 2 into "keep going" and shows the
 * agent the stderr (probed 2026-10-14: the agent resumed, and the second stop
 * arrived with `stop_hook_active: true` and the same agent id). Everything
 * else fails OPEN, and `runAcceptanceStopCheck` is total: no runner or no owed
 * testcase is a silent skip; a runner another claimant holds, a runner that
 * cannot run, a report that cannot be read, an unreadable block counter, the
 * block cap, or any thrown fault is a note, and the stop proceeds for the Wave
 * Gate to judge. Nothing here is completion evidence; it never writes the
 * TaskGraph.
 */

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  judgeStopCheck,
  renderStopCheckBlock,
  stopCheckExpectation,
} from "../../core/acceptance-contract";
import { MAX_ACCEPTANCE_RUNNER_TIMEOUT_MS, acceptanceRunnerCheck } from "../../core/verification-manifest";
import { parseJunitTestcases } from "../../core/structured-test-report";
import { sha256Bytes, sha256Hex } from "../../core/digest";
import type { TaskGraph } from "../../types";
import { subagentDir } from "../../config";
import { runCompletionCheck, type CompletionCheckRunnerResult } from "../../orchestration/completion-check-runner";
import { readRunBytesNoFollow } from "../../orchestration/no-follow-fs";
import { resolveCanonicalGitRepositoryRoot, type CanonicalRepositoryRoot } from "../../utils/workspace-digest";

/** At most this many blocks per spawned agent; then the stop proceeds. */
export const ACCEPTANCE_STOP_CHECK_MAX_BLOCKS = 3;

/** The longest runner output tail the blocked agent is shown. */
const OUTPUT_TAIL_CHARS = 4_000;

/** A runner lock older than the longest permitted run plus a margin belongs to a stop hook that died. */
const RUNNER_LOCK_STALE_MS = MAX_ACCEPTANCE_RUNNER_TIMEOUT_MS + 60_000;

export type StopCheckOutcome =
  | Readonly<{ kind: "skip" }>
  | Readonly<{ kind: "passed" }>
  | Readonly<{ kind: "block"; message: string }>
  /** The stop proceeds, and the operator is told why the check did not decide. */
  | Readonly<{ kind: "note"; message: string }>;

/** Blocks already issued to one agent, or why that count cannot be read. */
export type BlockCount =
  | Readonly<{ kind: "count"; blocks: number }>
  | Readonly<{ kind: "unreadable"; reason: string }>;

/**
 * Every claimant of a repository shares the runner's one declared report
 * path, which the runner resets before each launch, so runs are serialized:
 * a stop that finds another claimant's run in flight does not decide.
 */
export type RunnerLock =
  | Readonly<{ kind: "acquired"; release: () => void }>
  | Readonly<{ kind: "held"; reason: string }>;

/** The I/O the check needs, injectable for tests. */
export type StopCheckPorts = Readonly<{
  repositoryRoot: (stateFilePath: string) => Readonly<{ ok: true; root: CanonicalRepositoryRoot }> | Readonly<{ ok: false; reason: string }>;
  acquireRunner: (root: CanonicalRepositoryRoot) => RunnerLock;
  runCheck: (check: Parameters<typeof runCompletionCheck>[0], root: CanonicalRepositoryRoot) => Promise<CompletionCheckRunnerResult>;
  readReport: (path: string) => Uint8Array;
  blocksIssued: (agentKey: string) => BlockCount;
  /** Record that this agent has now been blocked `blocks` times. */
  recordBlock: (agentKey: string, blocks: number) => void;
  /** Forget this agent's blocks: its stop is proceeding. */
  clearBlocks: (agentKey: string) => void;
}>;

export type StopCheckInput = Readonly<{
  /** Read inside the check, so a load fault is a note like every other fault. */
  loadGraph: () => TaskGraph;
  stateFilePath: string;
  taskId: string;
  /** Session and agent id, unique per spawned agent. */
  agentKey: string;
}>;

const describe = (cause: unknown): string => cause instanceof Error ? cause.message : String(cause);
const tail = (text: string): string => text.length <= OUTPUT_TAIL_CHARS ? text : `…${text.slice(-OUTPUT_TAIL_CHARS)}`;

/** Decide the stop. Total: every fault becomes a note, and a stop that proceeds clears the agent's block count. */
export async function runAcceptanceStopCheck(input: StopCheckInput, ports: StopCheckPorts): Promise<StopCheckOutcome> {
  let outcome: StopCheckOutcome;
  try {
    outcome = await decideStop(input, ports);
  } catch (error) {
    outcome = { kind: "note", message: `acceptance stop check for ${input.taskId} crashed and did not decide: ${describe(error)}` };
  }
  if (outcome.kind === "block") return outcome;
  try {
    ports.clearBlocks(input.agentKey);
  } catch (error) {
    const cleared = `its block counter could not be cleared: ${describe(error)}`;
    return { kind: "note", message: outcome.kind === "note" ? `${outcome.message}; ${cleared}` : `acceptance stop check for ${input.taskId}: ${cleared}` };
  }
  return outcome;
}

async function decideStop(input: StopCheckInput, ports: StopCheckPorts): Promise<StopCheckOutcome> {
  const graph = input.loadGraph();
  const runner = graph.verification_manifest?.acceptanceRunner;
  const task = graph.tasks.find(({ id }) => id === input.taskId);
  if (runner === undefined || task === undefined) return { kind: "skip" };
  const check = stopCheckExpectation(graph.acceptance_contracts ?? [], graph.tasks, task);
  if (check.kind === "none") return { kind: "skip" };

  const note = (why: string): StopCheckOutcome =>
    ({ kind: "note", message: `acceptance stop check for ${input.taskId} did not decide (${why}); the stop proceeds and the Wave Gate judges` });
  const issued = ports.blocksIssued(input.agentKey);
  // Without a trustworthy count the cap cannot be enforced, so the check must not block.
  if (issued.kind === "unreadable") return note(`its block counter is unreadable: ${issued.reason}`);
  if (issued.blocks >= ACCEPTANCE_STOP_CHECK_MAX_BLOCKS) {
    return { kind: "note", message: `acceptance stop check: ${input.taskId} reached the ${ACCEPTANCE_STOP_CHECK_MAX_BLOCKS}-block cap; the stop proceeds and the Wave Gate judges` };
  }

  const resolvedRoot = ports.repositoryRoot(input.stateFilePath);
  if (!resolvedRoot.ok) return note(resolvedRoot.reason);
  const root = resolvedRoot.root;
  const command = acceptanceRunnerCheck(runner, check.files);
  if (!command.ok) return note(`the runner command is invalid for these files: ${command.error.errors.join("; ")}`);

  const lock = ports.acquireRunner(root);
  if (lock.kind === "held") return note(lock.reason);
  try {
    const run = await ports.runCheck(command.value, root);
    if (!run.ok) return note(`the runner did not complete: ${run.error.message}`);
    const outcome = run.value.checkResult.outcome;
    if (outcome.kind === "spawn-failed") return note(`the runner could not start: ${outcome.message}`);
    if (outcome.report.kind !== "produced") return note(`the runner produced no report (${outcome.report.kind})`);

    let bytes: Uint8Array;
    try {
      bytes = ports.readReport(join(root, outcome.report.path));
    } catch (cause) {
      return note(`the report could not be read back: ${describe(cause)}`);
    }
    if (sha256Bytes(bytes) !== outcome.report.digest) return note("the report changed after the runner produced it");

    const verdict = judgeStopCheck(check, outcome.report.digest, parseJunitTestcases(bytes));
    if (verdict.kind === "passed") return { kind: "passed" };
    if (verdict.kind === "unobservable") return note(verdict.reason);
    const blocks = issued.blocks + 1;
    ports.recordBlock(input.agentKey, blocks);
    const output = [run.value.diagnostics.stdoutTail, run.value.diagnostics.stderrTail].filter((part) => part.trim() !== "").join("\n");
    return {
      kind: "block",
      message: renderStopCheckBlock(verdict.testcases, tail(output), ACCEPTANCE_STOP_CHECK_MAX_BLOCKS - blocks),
    };
  } finally {
    lock.release();
  }
}

const errnoCode = (error: unknown): unknown =>
  typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined;

/** The block count lives beside the other per-agent runtime files, never in the TaskGraph. */
function counterPath(agentKey: string): string {
  return join(subagentDir(), `${agentKey.replace(/[^A-Za-z0-9._-]/g, "_")}.acceptance-stop-check.json`);
}

function readBlocks(agentKey: string): BlockCount {
  const path = counterPath(agentKey);
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    return errnoCode(error) === "ENOENT"
      ? { kind: "count", blocks: 0 }
      : { kind: "unreadable", reason: `${path}: ${describe(error)}` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return { kind: "unreadable", reason: `${path} is not JSON: ${describe(error)}` };
  }
  const blocks = typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>).blocks : undefined;
  return typeof blocks === "number" && Number.isSafeInteger(blocks) && blocks >= 0
    ? { kind: "count", blocks }
    : { kind: "unreadable", reason: `${path} carries no non-negative integer "blocks"` };
}

/** One lock per repository, so claimants of unrelated repositories never wait on each other. */
function runnerLockPath(root: CanonicalRepositoryRoot): string {
  return join(subagentDir(), `acceptance-stop-check.${sha256Hex(root).slice(0, 16)}.lock`);
}

const processAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errnoCode(error) === "EPERM";
  }
};

/** Why the lock at `path` is still live, or null when its holder is gone or it is stale. */
function liveHolder(path: string): string | null {
  let holder: unknown;
  try {
    holder = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    if (errnoCode(error) === "ENOENT") return null;
    // A lock caught mid-write, or a foreign one: judged by its age alone.
    return Date.now() - statSync(path).mtimeMs < RUNNER_LOCK_STALE_MS ? `the runner lock ${path} is unreadable but recent` : null;
  }
  const { pid, acquiredAt } = typeof holder === "object" && holder !== null ? holder as Record<string, unknown> : {};
  if (typeof pid !== "number" || typeof acquiredAt !== "number") return null;
  return processAlive(pid) && Date.now() - acquiredAt < RUNNER_LOCK_STALE_MS
    ? `another claimant's stop check (pid ${pid}) is running the acceptance runner`
    : null;
}

function acquireRunnerLock(root: CanonicalRepositoryRoot): RunnerLock {
  const path = runnerLockPath(root);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const token = JSON.stringify({ pid: process.pid, acquiredAt: Date.now() });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(path, token, { flag: "wx", mode: 0o600 });
      return {
        kind: "acquired",
        // Remove only our own lock: a stale-reaped one may now belong to another stop.
        release: () => {
          try {
            if (readFileSync(path, "utf8") === token) rmSync(path, { force: true });
          } catch {
            // Already gone: nothing to release.
          }
        },
      };
    } catch (error) {
      if (errnoCode(error) !== "EEXIST") throw error;
      const live = liveHolder(path);
      if (live !== null) return { kind: "held", reason: live };
      rmSync(path, { force: true });
    }
  }
  return { kind: "held", reason: `the runner lock ${path} was retaken while this stop reaped a stale one` };
}

export const PRODUCTION_STOP_CHECK_PORTS: StopCheckPorts = Object.freeze({
  repositoryRoot: (stateFilePath: string) => {
    const resolved = resolveCanonicalGitRepositoryRoot(dirname(resolve(stateFilePath)));
    return resolved.ok
      ? { ok: true as const, root: resolved.value }
      : { ok: false as const, reason: "the protected TaskGraph's repository root is unavailable" };
  },
  acquireRunner: acquireRunnerLock,
  runCheck: (check, root) => runCompletionCheck(check, root),
  readReport: (path: string) => Uint8Array.from(readRunBytesNoFollow(path)),
  blocksIssued: readBlocks,
  recordBlock: (agentKey: string, blocks: number) => {
    const path = counterPath(agentKey);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, JSON.stringify({ blocks }), { mode: 0o600 });
  },
  clearBlocks: (agentKey: string) => rmSync(counterPath(agentKey), { force: true }),
});

/**
 * Pi settles a batch only after its subagents have ended, so it cannot resume
 * one: there the check runs report-only. No counter is kept, because nothing
 * is blocked.
 */
export const REPORT_ONLY_STOP_CHECK_PORTS: StopCheckPorts = Object.freeze({
  ...PRODUCTION_STOP_CHECK_PORTS,
  blocksIssued: (): BlockCount => ({ kind: "count", blocks: 0 }),
  recordBlock: () => undefined,
  clearBlocks: () => undefined,
});

/** The operator line a report-only run prints, or null when there is nothing to say. */
export function stopCheckReportLine(taskId: string, outcome: StopCheckOutcome): string | null {
  switch (outcome.kind) {
    case "skip":
      return null;
    case "passed":
      return `acceptance stop check: ${taskId}'s owed acceptance testcases pass`;
    case "note":
      return outcome.message;
    case "block":
      return `acceptance stop check (report-only on Pi; the agent has already ended): ${taskId} ${outcome.message}`;
  }
}
