/**
 * The stop checks' shared I/O primitives (G4 slices 1 and 2): the one
 * per-repository runner lock, each check's per-agent block counter, and the
 * production and Pi report-only port sets that `runStopChecks`
 * (`stop-checks.ts`) runs the acceptance and affected checks through.
 *
 * Claude Code turns a SubagentStop exit 2 into "keep going" and shows the
 * agent the stderr (probed 2026-10-14: the agent resumed, and the second stop
 * arrived with `stop_hook_active: true` and the same agent id). Nothing here
 * decides anything: the plan comes from `planStopChecks`, the counter rule
 * from `stopCheckBlockDecision`, and `runStopChecks` sequences them. Nothing
 * here is completion evidence; it never writes the TaskGraph.
 */

import { existsSync, linkSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import {
  STOP_HOOK_BUDGET_MS,
  type StopCheckBlockCount,
  type StopCheckRunnerLock,
  type StopChecksPorts,
} from "../../core/affected-stop-check-types";
import { sha256Hex } from "../../core/digest";
import { subagentDir } from "../../config";
import { runCompletionCheck, type CompletionCheckRunnerResult } from "../../orchestration/completion-check-runner";
import { readRunBytesNoFollow } from "../../orchestration/no-follow-fs";
import { resolveCanonicalGitRepositoryRoot, type CanonicalRepositoryRoot } from "../../utils/workspace-digest";

/** At most this many acceptance-check blocks per spawned agent; then that check fails open. */
export const ACCEPTANCE_STOP_CHECK_MAX_BLOCKS = 3;

/**
 * A runner lock older than the longest a stop can hold it, plus a margin,
 * belongs to a stop hook that died. Both runs happen under one lock, and the
 * harness kills the hook at its budget, so no live stop holds it longer.
 */
const RUNNER_LOCK_STALE_MS = STOP_HOOK_BUDGET_MS + 60_000;

/** The stop shell's ports: the CT-2 port over the shell's repository root and the completion runner's result. */
export type StopCheckShellPorts = StopChecksPorts<CanonicalRepositoryRoot, CompletionCheckRunnerResult>;

const describe = (cause: unknown): string => cause instanceof Error ? cause.message : String(cause);

const errnoCode = (error: unknown): unknown =>
  typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined;

/** A counter no block was ever written to: the count every check starts from. */
export const NO_BLOCKS_ISSUED: StopCheckBlockCount = Object.freeze({ kind: "count", blocks: 0 });

/** Which check a counter file counts blocks for. Each has its own file, so their caps are independent. */
type CounterCheck = "acceptance" | "affected";

/** A block count lives beside the other per-agent runtime files, never in the TaskGraph. */
function counterPath(check: CounterCheck, agentKey: string): string {
  return join(subagentDir(), `${agentKey.replace(/[^A-Za-z0-9._-]/g, "_")}.${check}-stop-check.json`);
}

function readBlocks(check: CounterCheck, agentKey: string): StopCheckBlockCount {
  const path = counterPath(check, agentKey);
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    return errnoCode(error) === "ENOENT"
      ? NO_BLOCKS_ISSUED
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

function writeBlocks(check: CounterCheck, agentKey: string, blocks: number): void {
  const path = counterPath(check, agentKey);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, JSON.stringify({ blocks }), { mode: 0o600 });
}

const clearCounter = (check: CounterCheck, agentKey: string): void => rmSync(counterPath(check, agentKey), { force: true });

/**
 * One lock per repository, so stops in unrelated repositories never wait on
 * each other. Its file name predates the affected check and stays the same,
 * so an old hook and a new one never hold two different locks.
 */
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

/** Who holds the lock at `path`: a live stop, a dead or expired one (with the bytes it left), or nobody. */
type LockHolder =
  | Readonly<{ kind: "live"; reason: string }>
  | Readonly<{ kind: "stale"; bytes: string }>
  | Readonly<{ kind: "gone" }>;

function lockHolder(path: string): LockHolder {
  let bytes: string;
  try {
    bytes = readFileSync(path, "utf8");
  } catch (error) {
    if (errnoCode(error) === "ENOENT") return { kind: "gone" };
    throw error;
  }
  let holder: unknown;
  try {
    holder = JSON.parse(bytes);
  } catch {
    // A lock caught mid-write, or a foreign one: judged by its age alone.
    return Date.now() - statSync(path).mtimeMs < RUNNER_LOCK_STALE_MS
      ? { kind: "live", reason: `the runner lock ${path} is unreadable but recent` }
      : { kind: "stale", bytes };
  }
  const { pid, acquiredAt } = typeof holder === "object" && holder !== null ? holder as Record<string, unknown> : {};
  return typeof pid === "number" && typeof acquiredAt === "number" && processAlive(pid) && Date.now() - acquiredAt < RUNNER_LOCK_STALE_MS
    ? { kind: "live", reason: `another stop's stop checks (pid ${pid}) are running the stop-check runners` }
    : { kind: "stale", bytes };
}

/**
 * Reap the stale lock that held `stale`, as one compare-and-delete: claim
 * whatever is at `path` by an atomic rename, delete it only if it still holds
 * those bytes, and otherwise link it back, because another stop reaped the
 * stale lock and took a fresh one first. `retaken` means that happened. The
 * one race left needs a third stop to lock in the instant between the rename
 * and the link-back; the Wave Gate still judges every Task.
 */
export function reapStaleRunnerLock(path: string, stale: string): "reaped" | "retaken" {
  const claimed = `${path}.reap.${process.pid}.${randomUUID()}`;
  try {
    renameSync(path, claimed);
  } catch (error) {
    if (errnoCode(error) === "ENOENT") return "reaped";
    throw error;
  }
  try {
    if (readFileSync(claimed, "utf8") === stale) return "reaped";
    try {
      linkSync(claimed, path);
    } catch (error) {
      if (errnoCode(error) !== "EEXIST") throw error;
    }
    return "retaken";
  } finally {
    rmSync(claimed, { force: true });
  }
}

function acquireRunnerLock(root: CanonicalRepositoryRoot): StopCheckRunnerLock {
  const path = runnerLockPath(root);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const token = JSON.stringify({ pid: process.pid, acquiredAt: Date.now() });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(path, token, { flag: "wx", mode: 0o600 });
      return {
        kind: "acquired",
        // Remove only our own lock: a reaped one may now belong to another stop.
        release: () => {
          try {
            if (readFileSync(path, "utf8") === token) rmSync(path, { force: true });
            return null;
          } catch (error) {
            return errnoCode(error) === "ENOENT" ? null : `the runner lock ${path} could not be released: ${describe(error)}`;
          }
        },
      };
    } catch (error) {
      if (errnoCode(error) !== "EEXIST") throw error;
      const holder = lockHolder(path);
      if (holder.kind === "live") return { kind: "held", reason: holder.reason };
      if (holder.kind === "stale" && reapStaleRunnerLock(path, holder.bytes) === "retaken") break;
    }
  }
  return { kind: "held", reason: `the runner lock ${path} was retaken while this stop reaped a stale one` };
}

export const PRODUCTION_STOP_CHECK_PORTS: StopCheckShellPorts = Object.freeze({
  repositoryRoot: (stateFilePath: string) => {
    const resolved = resolveCanonicalGitRepositoryRoot(dirname(resolve(stateFilePath)));
    return resolved.ok
      ? { ok: true as const, root: resolved.value }
      : { ok: false as const, reason: "the protected TaskGraph's repository root is unavailable" };
  },
  acquireRunner: acquireRunnerLock,
  runCheck: (check, root) => runCompletionCheck(check, root),
  readReport: (path: string) => Uint8Array.from(readRunBytesNoFollow(path)),
  blocksIssued: (agentKey: string) => readBlocks("acceptance", agentKey),
  recordBlock: (agentKey: string, blocks: number) => writeBlocks("acceptance", agentKey, blocks),
  clearBlocks: (agentKey: string) => clearCounter("acceptance", agentKey),
  affectedBlocksIssued: (agentKey: string) => readBlocks("affected", agentKey),
  recordAffectedBlock: (agentKey: string, blocks: number) => writeBlocks("affected", agentKey, blocks),
  clearAffectedBlocks: (agentKey: string) => clearCounter("affected", agentKey),
  pathExists: (root, path) => existsSync(join(root, path)),
  now: () => Date.now(),
});

/**
 * Pi settles a batch only after its subagents have ended, so it cannot resume
 * one: there both checks run report-only. No counter is kept, because nothing
 * is blocked.
 */
export const REPORT_ONLY_STOP_CHECK_PORTS: StopCheckShellPorts = Object.freeze({
  ...PRODUCTION_STOP_CHECK_PORTS,
  blocksIssued: () => NO_BLOCKS_ISSUED,
  recordBlock: () => undefined,
  clearBlocks: () => undefined,
  affectedBlocksIssued: () => NO_BLOCKS_ISSUED,
  recordAffectedBlock: () => undefined,
  clearAffectedBlocks: () => undefined,
});
