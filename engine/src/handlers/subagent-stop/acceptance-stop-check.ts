/**
 * The Acceptance Stop Check's shell (G4 slice 1). When a claimant's
 * implementation agent tries to stop, run its contract's acceptance files
 * through the operator-declared runner and, if a testcase it owes is still
 * not passing, block the stop so the same agent keeps working.
 *
 * Claude Code turns a SubagentStop exit 2 into "keep going" and shows the
 * agent the stderr (probed 2026-10-14: the agent resumed, and the second stop
 * arrived with `stop_hook_active: true` and the same agent id). Everything
 * else fails OPEN: no runner, no owed testcases, a runner that cannot run, a
 * report that cannot be read, or the block cap reached all let the stop
 * proceed, and the Wave Gate judges as it always has. Nothing here is
 * completion evidence; it never writes the TaskGraph.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  judgeStopCheck,
  renderStopCheckBlock,
  stopCheckExpectation,
} from "../../core/acceptance-contract";
import { acceptanceRunnerCheck } from "../../core/verification-manifest";
import { parseJunitTestcases } from "../../core/structured-test-report";
import { sha256Bytes } from "../../core/digest";
import type { TaskGraph } from "../../types";
import { subagentDir } from "../../config";
import { runCompletionCheck, type CompletionCheckRunnerResult } from "../../orchestration/completion-check-runner";
import { readRunBytesNoFollow } from "../../orchestration/no-follow-fs";
import { resolveCanonicalGitRepositoryRoot, type CanonicalRepositoryRoot } from "../../utils/workspace-digest";

/** At most this many blocks per spawned agent; then the stop proceeds. */
export const ACCEPTANCE_STOP_CHECK_MAX_BLOCKS = 3;

/** The longest runner output tail the blocked agent is shown. */
const OUTPUT_TAIL_CHARS = 4_000;

export type StopCheckOutcome =
  | Readonly<{ kind: "skip" }>
  | Readonly<{ kind: "passed" }>
  | Readonly<{ kind: "block"; message: string }>
  /** The stop proceeds, and the operator is told why the check did not decide. */
  | Readonly<{ kind: "note"; message: string }>;

/** The I/O the check needs, injectable for tests. */
export type StopCheckPorts = Readonly<{
  repositoryRoot: (stateFilePath: string) => Readonly<{ ok: true; root: CanonicalRepositoryRoot }> | Readonly<{ ok: false; reason: string }>;
  runCheck: (check: Parameters<typeof runCompletionCheck>[0], root: CanonicalRepositoryRoot) => Promise<CompletionCheckRunnerResult>;
  readReport: (path: string) => Uint8Array;
  /** Blocks already issued to this agent. */
  blocksIssued: (agentKey: string) => number;
  recordBlock: (agentKey: string) => void;
}>;

export type StopCheckInput = Readonly<{
  graph: TaskGraph;
  stateFilePath: string;
  taskId: string;
  /** Session and agent id, unique per spawned agent. */
  agentKey: string;
}>;

const tail = (text: string): string => text.length <= OUTPUT_TAIL_CHARS ? text : `…${text.slice(-OUTPUT_TAIL_CHARS)}`;

export async function runAcceptanceStopCheck(input: StopCheckInput, ports: StopCheckPorts): Promise<StopCheckOutcome> {
  const runner = input.graph.verification_manifest?.acceptanceRunner;
  const task = input.graph.tasks.find(({ id }) => id === input.taskId);
  if (runner === undefined || task === undefined) return { kind: "skip" };
  const check = stopCheckExpectation(input.graph.acceptance_contracts ?? [], input.graph.tasks, task);
  if (check.kind === "none") return { kind: "skip" };

  const issued = ports.blocksIssued(input.agentKey);
  if (issued >= ACCEPTANCE_STOP_CHECK_MAX_BLOCKS) {
    return { kind: "note", message: `acceptance stop check: ${input.taskId} reached the ${ACCEPTANCE_STOP_CHECK_MAX_BLOCKS}-block cap; the stop proceeds and the Wave Gate judges` };
  }
  const note = (why: string): StopCheckOutcome =>
    ({ kind: "note", message: `acceptance stop check for ${input.taskId} did not decide (${why}); the stop proceeds and the Wave Gate judges` });

  const resolvedRoot = ports.repositoryRoot(input.stateFilePath);
  if (!resolvedRoot.ok) return note(resolvedRoot.reason);
  const root = resolvedRoot.root;
  const command = acceptanceRunnerCheck(runner, check.files);
  if (!command.ok) return note(`the runner command is invalid for these files: ${command.error.errors.join("; ")}`);
  const run = await ports.runCheck(command.value, root);
  if (!run.ok) return note(`the runner did not complete: ${run.error.message}`);
  const outcome = run.value.checkResult.outcome;
  if (outcome.kind === "spawn-failed") return note(`the runner could not start: ${outcome.message}`);
  if (outcome.report.kind !== "produced") return note(`the runner produced no report (${outcome.report.kind})`);

  let bytes: Uint8Array;
  try {
    bytes = ports.readReport(join(root, outcome.report.path));
  } catch (cause) {
    return note(`the report could not be read back: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
  if (sha256Bytes(bytes) !== outcome.report.digest) return note("the report changed after the runner produced it");

  const verdict = judgeStopCheck(check, outcome.report.digest, parseJunitTestcases(bytes));
  if (verdict.kind === "passed") return { kind: "passed" };
  if (verdict.kind === "unobservable") return note(verdict.reason);
  ports.recordBlock(input.agentKey);
  const output = [run.value.diagnostics.stdoutTail, run.value.diagnostics.stderrTail].filter((part) => part.trim() !== "").join("\n");
  return {
    kind: "block",
    message: renderStopCheckBlock(verdict.testcases, tail(output), ACCEPTANCE_STOP_CHECK_MAX_BLOCKS - issued - 1),
  };
}

/** The block count lives beside the other per-agent runtime files, never in the TaskGraph. */
function counterPath(agentKey: string): string {
  return join(subagentDir(), `${agentKey.replace(/[^A-Za-z0-9._-]/g, "_")}.acceptance-stop-check.json`);
}

export const PRODUCTION_STOP_CHECK_PORTS: StopCheckPorts = Object.freeze({
  repositoryRoot: (stateFilePath: string) => {
    const resolved = resolveCanonicalGitRepositoryRoot(dirname(resolve(stateFilePath)));
    return resolved.ok
      ? { ok: true as const, root: resolved.value }
      : { ok: false as const, reason: "the protected TaskGraph's repository root is unavailable" };
  },
  runCheck: (check, root) => runCompletionCheck(check, root),
  readReport: (path: string) => Uint8Array.from(readRunBytesNoFollow(path)),
  blocksIssued: (agentKey: string) => {
    const path = counterPath(agentKey);
    if (!existsSync(path)) return 0;
    try {
      const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
      const blocks = typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>).blocks : undefined;
      // An unreadable counter reads as the cap: the check must never block forever.
      return typeof blocks === "number" && Number.isSafeInteger(blocks) && blocks >= 0 ? blocks : ACCEPTANCE_STOP_CHECK_MAX_BLOCKS;
    } catch {
      return ACCEPTANCE_STOP_CHECK_MAX_BLOCKS;
    }
  },
  recordBlock: (agentKey: string) => {
    const path = counterPath(agentKey);
    const current = PRODUCTION_STOP_CHECK_PORTS.blocksIssued(agentKey);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ blocks: current + 1 }));
  },
});

/**
 * Pi settles a batch only after its subagents have ended, so it cannot resume
 * one: there the check runs report-only. No counter is kept, because nothing
 * is blocked.
 */
export const REPORT_ONLY_STOP_CHECK_PORTS: StopCheckPorts = Object.freeze({
  ...PRODUCTION_STOP_CHECK_PORTS,
  blocksIssued: () => 0,
  recordBlock: () => undefined,
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
