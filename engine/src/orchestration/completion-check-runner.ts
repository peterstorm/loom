import { spawn, type ChildProcess } from "node:child_process";
import { lstatSync, type BigIntStats } from "node:fs";
import { join } from "node:path";
import {
  parseAuthorizedWaveCompletionCheck,
  type AuthorizedWaveCompletionCheck,
  type CompletionCheckResult,
  type CompletionReportOutcome,
  type NonEmptyString,
} from "../core/completion-suite";
import { parseArtifactDigest } from "../core/orchestration-contract";
import { sha256Bytes } from "../core/review-packet";
import { inspectRepositoryPath } from "../utils/repository-path";
import {
  parseCanonicalRepositoryRoot,
  type CanonicalRepositoryRoot,
} from "../utils/workspace-digest";
import { readRunBytesNoFollow } from "./no-follow-fs";

type ProjectCommandCheck = Extract<AuthorizedWaveCompletionCheck, { readonly kind: "project-command" }>;

export type CompletionCheckDiagnostics = Readonly<{
  stdoutTail: string;
  stderrTail: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
}>;

export type CompletionCheckExecution = Readonly<{
  checkResult: CompletionCheckResult;
  diagnostics: CompletionCheckDiagnostics;
}>;

export type CompletionCheckRunnerFailure =
  | Readonly<{ kind: "invalid-runner-authority"; message: string }>
  | Readonly<{ kind: "path-rejected"; path: string; message: string }>
  | Readonly<{
      kind: "cancelled";
      message: string;
      exitCode: number | null;
      signal: NodeJS.Signals | null;
      diagnostics: CompletionCheckDiagnostics;
    }>
  | Readonly<{
      kind: "termination-unconfirmed";
      message: string;
      diagnostics: CompletionCheckDiagnostics;
    }>;

export type CompletionCheckRunnerResult =
  | Readonly<{ ok: true; value: CompletionCheckExecution }>
  | Readonly<{ ok: false; error: CompletionCheckRunnerFailure }>;

export type CompletionCheckRunnerOptions = Readonly<{
  signal?: AbortSignal;
  terminationGraceMs?: number;
  hardKillWaitMs?: number;
  diagnosticTailBytes?: number;
}>;

const DEFAULT_TERMINATION_GRACE_MS = 250;
const DEFAULT_HARD_KILL_WAIT_MS = 1_000;
const DEFAULT_DIAGNOSTIC_TAIL_BYTES = 64 * 1_024;
const MAX_TERMINATION_BOUND_MS = 60_000;
const MAX_DIAGNOSTIC_TAIL_BYTES = 1_024 * 1_024;
const MAX_MESSAGE_LENGTH = 4_096;

const succeeded = (value: CompletionCheckExecution): CompletionCheckRunnerResult =>
  Object.freeze({ ok: true, value: Object.freeze(value) });
const failed = (error: CompletionCheckRunnerFailure): CompletionCheckRunnerResult =>
  Object.freeze({ ok: false, error: Object.freeze(error) });

function messageOf(cause: unknown): string {
  const message = cause instanceof Error ? cause.message : String(cause);
  const bounded = message.slice(0, MAX_MESSAGE_LENGTH);
  return bounded.trim().length > 0 ? bounded : "completion check infrastructure failure";
}

function boundedInteger(raw: number | undefined, fallback: number, maximum: number): number | null {
  const value = raw ?? fallback;
  return Number.isSafeInteger(value) && value >= 1 && value <= maximum ? value : null;
}

class DiagnosticTail {
  private bytes: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  private dropped = false;

  constructor(private readonly maximumBytes: number) {}

  append(chunk: Buffer | string): void {
    const incoming = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    if (incoming.byteLength >= this.maximumBytes) {
      this.bytes = incoming.subarray(incoming.byteLength - this.maximumBytes);
      this.dropped = true;
      return;
    }
    const overflow = this.bytes.byteLength + incoming.byteLength - this.maximumBytes;
    if (overflow > 0) {
      this.bytes = this.bytes.subarray(overflow);
      this.dropped = true;
    }
    this.bytes = Buffer.concat([this.bytes, incoming]);
  }

  value(): Readonly<{ text: string; truncated: boolean }> {
    return Object.freeze({ text: this.bytes.toString("utf-8"), truncated: this.dropped });
  }
}

type ReportSnapshot = Readonly<{
  ino: bigint;
  size: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
}>;

function snapshot(stat: BigIntStats): ReportSnapshot {
  return Object.freeze({ ino: stat.ino, size: stat.size, mtimeNs: stat.mtimeNs, ctimeNs: stat.ctimeNs });
}

function sameSnapshot(left: ReportSnapshot, right: ReportSnapshot): boolean {
  return left.ino === right.ino && left.size === right.size &&
    left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}

function changedSince(before: ReportSnapshot | null, after: ReportSnapshot): boolean {
  return before === null || !sameSnapshot(before, after);
}

function absoluteRepositoryPath(root: CanonicalRepositoryRoot, relative: string): string {
  return join(root, ...relative.split("/"));
}

function lstatIfPresent(path: string): BigIntStats | null {
  try {
    return lstatSync(path, { bigint: true });
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw cause;
  }
}

function preSpawnReportSnapshot(
  root: CanonicalRepositoryRoot,
  check: ProjectCommandCheck,
): CompletionCheckRunnerResult | ReportSnapshot | null {
  if (check.reportPolicy.kind === "not-required") return null;
  try {
    const inspected = inspectRepositoryPath(root, check.reportPolicy.path, "completion report path");
    if (!inspected.exists) return null;
    const stat = lstatSync(inspected.absolute, { bigint: true });
    return snapshot(stat);
  } catch (cause) {
    return failed({
      kind: "path-rejected",
      path: check.reportPolicy.path,
      message: messageOf(cause),
    });
  }
}

function missingReport(check: ProjectCommandCheck): CompletionReportOutcome {
  if (check.reportPolicy.kind === "not-required") return Object.freeze({ kind: "not-required" });
  return Object.freeze({ kind: "missing", path: check.reportPolicy.path });
}

function unreadableReport(check: ProjectCommandCheck, cause: unknown): CompletionReportOutcome {
  if (check.reportPolicy.kind === "not-required") return Object.freeze({ kind: "not-required" });
  return Object.freeze({
    kind: "unreadable",
    path: check.reportPolicy.path,
    message: messageOf(cause) as NonEmptyString,
  });
}

/** Observe required report bytes only after process close and through no-follow reads. */
function observeReportAfterClose(
  root: CanonicalRepositoryRoot,
  check: ProjectCommandCheck,
  before: ReportSnapshot | null,
): CompletionReportOutcome {
  if (check.reportPolicy.kind === "not-required") return Object.freeze({ kind: "not-required" });
  const absolute = absoluteRepositoryPath(root, check.reportPolicy.path);
  try {
    inspectRepositoryPath(root, check.reportPolicy.path, "completion report path");
    const firstStat = lstatIfPresent(absolute);
    if (firstStat === null || !firstStat.isFile()) return missingReport(check);
    const first = snapshot(firstStat);
    if (!changedSince(before, first)) return missingReport(check);

    const bytes = readRunBytesNoFollow(absolute);
    const finalStat = lstatIfPresent(absolute);
    if (finalStat === null || !finalStat.isFile() || !sameSnapshot(first, snapshot(finalStat))) {
      return unreadableReport(check, "completion report changed while it was being read");
    }
    const digest = parseArtifactDigest(sha256Bytes(bytes));
    if (!digest.ok) return unreadableReport(check, digest.error.message);
    return Object.freeze({
      kind: "produced",
      path: check.reportPolicy.path,
      digest: digest.value,
      byteLength: bytes.byteLength,
    });
  } catch (cause) {
    return unreadableReport(check, cause);
  }
}

function diagnostics(stdout: DiagnosticTail, stderr: DiagnosticTail): CompletionCheckDiagnostics {
  const out = stdout.value();
  const err = stderr.value();
  return Object.freeze({
    stdoutTail: out.text,
    stderrTail: err.text,
    stdoutTruncated: out.truncated,
    stderrTruncated: err.truncated,
  });
}

function spawnFailure(
  check: ProjectCommandCheck,
  cause: unknown,
  output: CompletionCheckDiagnostics,
): CompletionCheckRunnerResult {
  const checkResult: CompletionCheckResult = Object.freeze({
    checkId: check.checkId,
    scope: check.scope,
    outcome: Object.freeze({ kind: "spawn-failed", message: messageOf(cause) as NonEmptyString }),
  });
  return succeeded({ checkResult, diagnostics: output });
}

function terminate(child: ChildProcess, graceMs: number, onHardKill: () => void): NodeJS.Timeout {
  try { child.kill("SIGTERM"); } catch { /* bounded hard-kill timer still applies */ }
  return setTimeout(() => {
    try { child.kill("SIGKILL"); } catch { /* final watchdog reports failure to close */ }
    onHardKill();
  }, graceMs);
}

/**
 * Execute one parser-proven project command with no shell. Every expected
 * infrastructure failure is returned as data; the Promise never rejects.
 */
export async function runCompletionCheck(
  rawCheck: ProjectCommandCheck,
  repositoryRoot: CanonicalRepositoryRoot,
  options: CompletionCheckRunnerOptions = {},
): Promise<CompletionCheckRunnerResult> {
  const parsedCheck = parseAuthorizedWaveCompletionCheck(rawCheck);
  if (!parsedCheck.ok || parsedCheck.value.kind !== "project-command") {
    return failed({
      kind: "invalid-runner-authority",
      message: parsedCheck.ok ? "runner accepts project-command checks only" : parsedCheck.error.errors.join("; "),
    });
  }
  const parsedRoot = parseCanonicalRepositoryRoot(repositoryRoot);
  if (!parsedRoot.ok) {
    const message = "message" in parsedRoot.error ? parsedRoot.error.message : "repository root observation drifted";
    return failed({ kind: "invalid-runner-authority", message });
  }

  const graceMs = boundedInteger(options.terminationGraceMs, DEFAULT_TERMINATION_GRACE_MS, MAX_TERMINATION_BOUND_MS);
  const hardKillWaitMs = boundedInteger(options.hardKillWaitMs, DEFAULT_HARD_KILL_WAIT_MS, MAX_TERMINATION_BOUND_MS);
  const tailBytes = boundedInteger(options.diagnosticTailBytes, DEFAULT_DIAGNOSTIC_TAIL_BYTES, MAX_DIAGNOSTIC_TAIL_BYTES);
  if (graceMs === null || hardKillWaitMs === null || tailBytes === null) {
    return failed({ kind: "invalid-runner-authority", message: "runner bounds must be positive bounded integers" });
  }
  if (options.signal?.aborted === true) {
    return failed({
      kind: "cancelled",
      message: "completion check cancelled before spawn",
      exitCode: null,
      signal: null,
      diagnostics: Object.freeze({ stdoutTail: "", stderrTail: "", stdoutTruncated: false, stderrTruncated: false }),
    });
  }

  const check = parsedCheck.value;
  let cwd: string;
  try {
    if (check.cwd === ".") cwd = parsedRoot.value;
    else {
      const inspected = inspectRepositoryPath(parsedRoot.value, check.cwd, "completion check cwd", { mustExist: true });
      const stat = lstatSync(inspected.absolute);
      if (!stat.isDirectory()) throw new Error("completion check cwd must be a real directory");
      cwd = inspected.absolute;
    }
  } catch (cause) {
    return failed({ kind: "path-rejected", path: check.cwd, message: messageOf(cause) });
  }

  const beforeReport = preSpawnReportSnapshot(parsedRoot.value, check);
  if (beforeReport !== null && "ok" in beforeReport) return beforeReport;
  const stdout = new DiagnosticTail(tailBytes);
  const stderr = new DiagnosticTail(tailBytes);

  return await new Promise<CompletionCheckRunnerResult>((resolveResult) => {
    let child: ChildProcess;
    let settled = false;
    let timedOut = false;
    let cancelled = false;
    let timeoutTimer: NodeJS.Timeout | null = null;
    let graceTimer: NodeJS.Timeout | null = null;
    let watchdogTimer: NodeJS.Timeout | null = null;

    const cleanup = (): void => {
      if (timeoutTimer !== null) clearTimeout(timeoutTimer);
      if (graceTimer !== null) clearTimeout(graceTimer);
      if (watchdogTimer !== null) clearTimeout(watchdogTimer);
      options.signal?.removeEventListener("abort", onAbort);
    };
    const finish = (result: CompletionCheckRunnerResult): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolveResult(result);
    };
    const hardKill = (): void => {
      watchdogTimer = setTimeout(() => finish(failed({
        kind: "termination-unconfirmed",
        message: "completion process did not close after SIGKILL",
        diagnostics: diagnostics(stdout, stderr),
      })), hardKillWaitMs);
    };
    const beginTermination = (): void => {
      if (graceTimer !== null) return;
      graceTimer = terminate(child, graceMs, hardKill);
    };
    function onAbort(): void {
      if (timedOut || cancelled || settled) return;
      cancelled = true;
      beginTermination();
    }

    try {
      child = spawn(check.executable, [...check.args], {
        cwd,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (cause) {
      finish(spawnFailure(check, cause, diagnostics(stdout, stderr)));
      return;
    }

    child.stdout?.on("data", (chunk: Buffer | string) => stdout.append(chunk));
    child.stderr?.on("data", (chunk: Buffer | string) => stderr.append(chunk));
    child.once("error", (cause) => finish(spawnFailure(check, cause, diagnostics(stdout, stderr))));
    child.once("close", (exitCode, signal) => {
      const output = diagnostics(stdout, stderr);
      if (cancelled) {
        finish(failed({
          kind: "cancelled",
          message: "completion check cancelled",
          exitCode,
          signal,
          diagnostics: output,
        }));
        return;
      }
      const report = observeReportAfterClose(
        parsedRoot.value,
        check,
        beforeReport as ReportSnapshot | null,
      );
      finish(succeeded({
        checkResult: Object.freeze({
          checkId: check.checkId,
          scope: check.scope,
          outcome: Object.freeze({ kind: "observed", exitCode, timedOut, signal, report }),
        }),
        diagnostics: output,
      }));
    });

    options.signal?.addEventListener("abort", onAbort, { once: true });
    timeoutTimer = setTimeout(() => {
      if (settled) return;
      timedOut = true;
      beginTermination();
    }, check.timeoutMs);
  });
}
