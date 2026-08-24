import { spawn, type ChildProcess } from "node:child_process";
import { lstatSync, type BigIntStats } from "node:fs";
import { join } from "node:path";
import {
  parseAuthorizedWaveCompletionCheck,
  parseCompletionSignal,
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
  | Readonly<{ kind: "containment-unsupported"; message: string }>
  | Readonly<{
      kind: "cancelled";
      message: string;
      exitCode: number | null;
      signal: NodeJS.Signals | null;
      diagnostics: CompletionCheckDiagnostics;
    }>
  | Readonly<{
      kind: "process-tree-survived";
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

type PreSpawnReportSnapshot =
  | Readonly<{ kind: "not-required" }>
  | Readonly<{ kind: "snapshot"; value: ReportSnapshot | null }>
  | Readonly<{
      kind: "failure";
      error: Extract<CompletionCheckRunnerFailure, { readonly kind: "path-rejected" }>;
    }>;

function preSpawnReportSnapshot(
  root: CanonicalRepositoryRoot,
  check: ProjectCommandCheck,
): PreSpawnReportSnapshot {
  if (check.reportPolicy.kind === "not-required") return Object.freeze({ kind: "not-required" });
  try {
    const inspected = inspectRepositoryPath(root, check.reportPolicy.path, "completion report path");
    const value = inspected.exists
      ? snapshot(lstatSync(inspected.absolute, { bigint: true }))
      : null;
    return Object.freeze({ kind: "snapshot", value });
  } catch (cause) {
    return Object.freeze({
      kind: "failure",
      error: Object.freeze({
        kind: "path-rejected",
        path: check.reportPolicy.path,
        message: messageOf(cause),
      }),
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

type ProcessGroupProbe =
  | Readonly<{ kind: "gone" }>
  | Readonly<{ kind: "present" }>
  | Readonly<{ kind: "error"; message: string }>;

type ParentObservation =
  | Readonly<{ kind: "spawn-failed"; cause: unknown }>
  | Readonly<{ kind: "closed"; exitCode: number | null; signal: NodeJS.Signals | null }>;

type ProcessTrigger =
  | Readonly<{ kind: "parent"; observation: ParentObservation }>
  | Readonly<{ kind: "timeout" }>
  | Readonly<{ kind: "cancelled" }>;

const POSIX_PROCESS_GROUP_PLATFORMS: ReadonlySet<NodeJS.Platform> = new Set([
  "aix", "darwin", "freebsd", "linux", "netbsd", "openbsd", "sunos",
]);
const GROUP_PROBE_INTERVAL_MS = 10;

function errnoCode(cause: unknown): string | null {
  return cause instanceof Error && "code" in cause && typeof cause.code === "string" ? cause.code : null;
}

function probeProcessGroup(processGroupId: number): ProcessGroupProbe {
  try {
    process.kill(-processGroupId, 0);
    return Object.freeze({ kind: "present" });
  } catch (cause) {
    return errnoCode(cause) === "ESRCH"
      ? Object.freeze({ kind: "gone" })
      : Object.freeze({
          kind: "error",
          message: `process-group ${processGroupId} existence check failed: ${messageOf(cause)}`,
        });
  }
}

function signalProcessGroup(processGroupId: number, signal: "SIGTERM" | "SIGKILL"): string | null {
  try {
    process.kill(-processGroupId, signal);
    return null;
  } catch (cause) {
    return errnoCode(cause) === "ESRCH"
      ? null
      : `process-group ${processGroupId} ${signal} failed: ${messageOf(cause)}`;
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

async function waitForProcessGroupGone(
  processGroupId: number,
  maximumWaitMs: number,
): Promise<ProcessGroupProbe> {
  const deadline = Date.now() + maximumWaitMs;
  let latest = probeProcessGroup(processGroupId);
  while (latest.kind === "present" && Date.now() < deadline) {
    await delay(Math.min(GROUP_PROBE_INTERVAL_MS, Math.max(1, deadline - Date.now())));
    latest = probeProcessGroup(processGroupId);
  }
  return latest;
}

async function terminateProcessGroup(
  processGroupId: number,
  graceMs: number,
  hardKillWaitMs: number,
): Promise<Readonly<{ ok: true }> | Readonly<{ ok: false; message: string }>> {
  const errors: string[] = [];
  const termError = signalProcessGroup(processGroupId, "SIGTERM");
  if (termError !== null) errors.push(termError);

  const afterTerm = await waitForProcessGroupGone(processGroupId, graceMs);
  if (afterTerm.kind === "error") errors.push(afterTerm.message);
  if (afterTerm.kind !== "gone") {
    const killError = signalProcessGroup(processGroupId, "SIGKILL");
    if (killError !== null) errors.push(killError);
    const afterKill = await waitForProcessGroupGone(processGroupId, hardKillWaitMs);
    if (afterKill.kind === "error") errors.push(afterKill.message);
    if (afterKill.kind !== "gone") {
      errors.push(`process-group ${processGroupId} still exists after SIGKILL containment`);
    }
  }

  return errors.length === 0
    ? Object.freeze({ ok: true })
    : Object.freeze({ ok: false, message: errors.join("; ") });
}

function parentObservation(child: ChildProcess): Promise<ParentObservation> {
  return new Promise((resolveObservation) => {
    let observed = false;
    const resolveOnce = (value: ParentObservation): void => {
      if (observed) return;
      observed = true;
      resolveObservation(value);
    };
    child.once("error", (cause) => resolveOnce(Object.freeze({ kind: "spawn-failed", cause })));
    child.once("close", (exitCode, signal) => resolveOnce(Object.freeze({ kind: "closed", exitCode, signal })));
  });
}

function observedExecution(
  root: CanonicalRepositoryRoot,
  check: ProjectCommandCheck,
  beforeReport: ReportSnapshot | null,
  stdout: DiagnosticTail,
  stderr: DiagnosticTail,
  observation: Extract<ParentObservation, { readonly kind: "closed" }>,
  timedOut: boolean,
): CompletionCheckRunnerResult {
  const output = diagnostics(stdout, stderr);
  const signal = observation.signal === null ? null : parseCompletionSignal(observation.signal);
  if (signal !== null && !signal.ok) {
    return failed({
      kind: "termination-unconfirmed",
      message: `Node reported a signal outside the completion allowlist: ${signal.error.errors.join("; ")}`,
      diagnostics: output,
    });
  }
  return succeeded({
    checkResult: Object.freeze({
      checkId: check.checkId,
      scope: check.scope,
      outcome: Object.freeze({
        kind: "observed",
        exitCode: observation.exitCode,
        timedOut,
        signal: signal === null ? null : signal.value,
        report: observeReportAfterClose(root, check, beforeReport),
      }),
    }),
    diagnostics: output,
  });
}

/**
 * Execute one parser-proven project command with no shell. On POSIX the child
 * owns a detached process group; no result is returned until that whole group
 * is proven gone. Every expected infrastructure failure is returned as data.
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
  if (!POSIX_PROCESS_GROUP_PLATFORMS.has(process.platform)) {
    return failed({
      kind: "containment-unsupported",
      message: `completion checks require owned POSIX process-group containment; platform ${process.platform} is unsupported`,
    });
  }

  const graceMs = boundedInteger(options.terminationGraceMs, DEFAULT_TERMINATION_GRACE_MS, MAX_TERMINATION_BOUND_MS);
  const hardKillWaitMs = boundedInteger(options.hardKillWaitMs, DEFAULT_HARD_KILL_WAIT_MS, MAX_TERMINATION_BOUND_MS);
  const tailBytes = boundedInteger(options.diagnosticTailBytes, DEFAULT_DIAGNOSTIC_TAIL_BYTES, MAX_DIAGNOSTIC_TAIL_BYTES);
  if (graceMs === null || hardKillWaitMs === null || tailBytes === null) {
    return failed({ kind: "invalid-runner-authority", message: "runner bounds must be positive bounded integers" });
  }
  const emptyDiagnostics = Object.freeze({
    stdoutTail: "", stderrTail: "", stdoutTruncated: false, stderrTruncated: false,
  });
  if (options.signal?.aborted === true) {
    return failed({
      kind: "cancelled",
      message: "completion check cancelled before spawn",
      exitCode: null,
      signal: null,
      diagnostics: emptyDiagnostics,
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

  const reportObservation = preSpawnReportSnapshot(parsedRoot.value, check);
  if (reportObservation.kind === "failure") return failed(reportObservation.error);
  const beforeReport = reportObservation.kind === "snapshot" ? reportObservation.value : null;
  const stdout = new DiagnosticTail(tailBytes);
  const stderr = new DiagnosticTail(tailBytes);
  let child: ChildProcess;
  try {
    child = spawn(check.executable, [...check.args], {
      cwd,
      detached: true,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (cause) {
    return spawnFailure(check, cause, diagnostics(stdout, stderr));
  }
  const parent = parentObservation(child);
  const processGroupId = child.pid;
  if (processGroupId === undefined) {
    return spawnFailure(check, "spawn returned no process id", diagnostics(stdout, stderr));
  }

  child.stdout?.on("data", (chunk: Buffer | string) => stdout.append(chunk));
  child.stderr?.on("data", (chunk: Buffer | string) => stderr.append(chunk));
  let timeoutTimer: NodeJS.Timeout | null = null;
  let abortListener: (() => void) | null = null;
  const timeout = new Promise<ProcessTrigger>((resolveTimeout) => {
    timeoutTimer = setTimeout(() => resolveTimeout(Object.freeze({ kind: "timeout" })), check.timeoutMs);
  });
  const cancellation = new Promise<ProcessTrigger>((resolveCancellation) => {
    abortListener = () => resolveCancellation(Object.freeze({ kind: "cancelled" }));
    options.signal?.addEventListener("abort", abortListener, { once: true });
  });

  const trigger = await Promise.race<ProcessTrigger>([
    parent.then((observation) => Object.freeze({ kind: "parent" as const, observation })),
    timeout,
    cancellation,
  ]);
  if (timeoutTimer !== null) clearTimeout(timeoutTimer);
  if (abortListener !== null) options.signal?.removeEventListener("abort", abortListener);

  if (trigger.kind === "parent") {
    if (trigger.observation.kind === "spawn-failed") {
      return spawnFailure(check, trigger.observation.cause, diagnostics(stdout, stderr));
    }
    const group = probeProcessGroup(processGroupId);
    if (group.kind === "gone") {
      return observedExecution(
        parsedRoot.value,
        check,
        beforeReport,
        stdout,
        stderr,
        trigger.observation,
        false,
      );
    }
    const containment = await terminateProcessGroup(processGroupId, graceMs, hardKillWaitMs);
    const output = diagnostics(stdout, stderr);
    if (group.kind === "error" || !containment.ok) {
      const causes = [group.kind === "error" ? group.message : null, containment.ok ? null : containment.message]
        .filter((message): message is string => message !== null);
      return failed({
        kind: "termination-unconfirmed",
        message: `completion parent closed but process-tree containment could not be proven: ${causes.join("; ")}`,
        diagnostics: output,
      });
    }
    return failed({
      kind: "process-tree-survived",
      message: `completion parent closed while process-group ${processGroupId} descendants remained; the group was terminated`,
      exitCode: trigger.observation.exitCode,
      signal: trigger.observation.signal,
      diagnostics: output,
    });
  }

  const containment = await terminateProcessGroup(processGroupId, graceMs, hardKillWaitMs);
  if (!containment.ok) {
    return failed({
      kind: "termination-unconfirmed",
      message: `${trigger.kind} process-tree containment failed: ${containment.message}`,
      diagnostics: diagnostics(stdout, stderr),
    });
  }
  const closed = await Promise.race<ParentObservation | null>([
    parent,
    delay(hardKillWaitMs).then(() => null),
  ]);
  if (closed === null || closed.kind !== "closed") {
    return failed({
      kind: "termination-unconfirmed",
      message: `${trigger.kind} process group is gone but the parent close observation is unavailable`,
      diagnostics: diagnostics(stdout, stderr),
    });
  }
  if (trigger.kind === "cancelled") {
    return failed({
      kind: "cancelled",
      message: "completion check cancelled after its whole process group was terminated",
      exitCode: closed.exitCode,
      signal: closed.signal,
      diagnostics: diagnostics(stdout, stderr),
    });
  }
  return observedExecution(
    parsedRoot.value,
    check,
    beforeReport,
    stdout,
    stderr,
    closed,
    true,
  );
}
