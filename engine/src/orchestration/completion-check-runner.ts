import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { lstatSync, type BigIntStats } from "node:fs";
import { join } from "node:path";
import {
  parseAuthorizedWaveCompletionCheck,
  parseCompletionSignal,
  type AuthorizedWaveCompletionCheck,
  type CompletionCheckResult,
  type CompletionProcessOutcome,
  type CompletionReportOutcome,
  type CompletionSignal,
  type NonEmptyString,
} from "../core/completion-suite";
import type {
  AuthorizedRemediationCheck,
  ProjectCommandAuthority,
  RemediationCheckScope,
} from "../core/defect-family-accounting";
import { parseArtifactDigest } from "../core/orchestration-contract";
import {
  MAX_STRUCTURED_REPORT_BYTES,
  parseStructuredTestReportBytes,
  type StructuredReportParseResult,
} from "../core/structured-test-report";
import { sha256Bytes } from "../core/review-packet";
import { inspectRepositoryPath } from "../utils/repository-path";
import {
  parseCanonicalRepositoryRoot,
  type CanonicalRepositoryRoot,
} from "../utils/workspace-digest";
import { readRunBytesNoFollow, removeRunRegularFileNoFollow } from "./no-follow-fs";

type ProjectCommandCheck = Extract<AuthorizedWaveCompletionCheck, { readonly kind: "project-command" }>;
type RunnerCommand = ProjectCommandCheck | ProjectCommandAuthority;

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
  | Readonly<{ kind: "report-reset-failed"; path: string; message: string }>
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

export type RawRemediationProcessOutcome =
  | Extract<CompletionProcessOutcome, { readonly kind: "spawn-failed" }>
  | Readonly<{
      kind: "observed";
      exitCode: number | null;
      timedOut: boolean;
      signal: CompletionSignal | null;
    }>;

export type StableProducedReport = Readonly<{
  outcome: Extract<CompletionReportOutcome, { readonly kind: "produced" }>;
  /** An owned copy of the one stable read; Uint8Array itself is intentionally mutable. */
  bytes: Uint8Array;
  mode: number;
}>;

type RequiredReportFailure = Extract<CompletionReportOutcome, { readonly kind: "missing" | "unreadable" }>;

export type RemediationReportObservation =
  | Readonly<{ outcome: RequiredReportFailure }>
  | StableProducedReport & Readonly<{ parsedReportFacts: StructuredReportParseResult }>;

export type RemediationCheckExecution = Readonly<{
  kind: "remediation-check-execution";
  checkId: AuthorizedRemediationCheck["command"]["checkId"];
  scope: RemediationCheckScope;
  manifestDigest: AuthorizedRemediationCheck["manifestDigest"];
  authorityDigest: AuthorizedRemediationCheck["authorityDigest"];
  process: RawRemediationProcessOutcome;
  report: RemediationReportObservation | null;
  diagnostics: CompletionCheckDiagnostics;
}>;

export type RemediationCheckRunnerResult =
  | Readonly<{ ok: true; value: RemediationCheckExecution }>
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

const completionSucceeded = (value: CompletionCheckExecution): CompletionCheckRunnerResult =>
  Object.freeze({ ok: true, value: Object.freeze(value) });
const failed = (error: CompletionCheckRunnerFailure): Readonly<{ ok: false; error: CompletionCheckRunnerFailure }> =>
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
  device: bigint;
  inode: bigint;
  size: bigint;
  mode: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
}>;

function snapshot(stat: BigIntStats): ReportSnapshot {
  return Object.freeze({
    device: stat.dev,
    inode: stat.ino,
    size: stat.size,
    mode: stat.mode,
    mtimeNs: stat.mtimeNs,
    ctimeNs: stat.ctimeNs,
  });
}

function sameSnapshot(left: ReportSnapshot, right: ReportSnapshot): boolean {
  return left.device === right.device && left.inode === right.inode && left.size === right.size &&
    left.mode === right.mode && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
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
  check: RunnerCommand,
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

/** Destructive permission is narrower than report-reading authority: only the
 * exact currently ignored, untracked report may be removed. Git reads do not
 * refresh the index, and the unlink itself retains its no-follow parent fd. */
function resetRemediationReport(root: CanonicalRepositoryRoot, check: RunnerCommand): void {
  if (check.reportPolicy.kind !== "required-file") throw new Error("remediation requires a report path");
  const path = check.reportPolicy.path;
  const tracked = spawnSync("git", ["--literal-pathspecs", "ls-files", "-z", "--", path], { cwd: root, encoding: "utf8" });
  if (tracked.error || tracked.status !== 0 || tracked.stdout.length !== 0) {
    throw new Error(`report reset cannot prove exact path is untracked: ${path}`);
  }
  const ignored = spawnSync("git", ["check-ignore", "-q", "--", path], { cwd: root, encoding: "utf8" });
  if (ignored.error || ignored.status !== 0) throw new Error(`report reset requires a Git-ignored path: ${path}`);
  removeRunRegularFileNoFollow(absoluteRepositoryPath(root, path));
}

type CollectedReport =
  | Exclude<CompletionReportOutcome, { readonly kind: "produced" }>
  | StableProducedReport;

function missingReport(check: RunnerCommand): CollectedReport {
  if (check.reportPolicy.kind === "not-required") return Object.freeze({ kind: "not-required" });
  return Object.freeze({ kind: "missing", path: check.reportPolicy.path });
}

function unreadableReport(check: RunnerCommand, cause: unknown): CollectedReport {
  if (check.reportPolicy.kind === "not-required") return Object.freeze({ kind: "not-required" });
  return Object.freeze({
    kind: "unreadable",
    path: check.reportPolicy.path,
    message: messageOf(cause) as NonEmptyString,
  });
}

/** Observe required report bytes only after process close and through one stable no-follow read. */
function observeReportAfterClose(
  root: CanonicalRepositoryRoot,
  check: RunnerCommand,
  before: ReportSnapshot | null,
  maximumBytes?: number,
): CollectedReport {
  if (check.reportPolicy.kind === "not-required") return Object.freeze({ kind: "not-required" });
  const absolute = absoluteRepositoryPath(root, check.reportPolicy.path);
  try {
    inspectRepositoryPath(root, check.reportPolicy.path, "completion report path");
    const firstStat = lstatIfPresent(absolute);
    if (firstStat === null || !firstStat.isFile()) return missingReport(check);
    const first = snapshot(firstStat);
    if (!changedSince(before, first)) return missingReport(check);

    const readBytes = readRunBytesNoFollow(absolute, maximumBytes);
    const finalStat = lstatIfPresent(absolute);
    if (finalStat === null || !finalStat.isFile() || !sameSnapshot(first, snapshot(finalStat))) {
      return unreadableReport(check, "completion report changed while it was being read");
    }
    const bytes = Uint8Array.from(readBytes);
    const digest = parseArtifactDigest(sha256Bytes(bytes));
    if (!digest.ok) return unreadableReport(check, digest.error.message);
    const outcome = Object.freeze({
      kind: "produced" as const,
      path: check.reportPolicy.path,
      digest: digest.value,
      byteLength: bytes.byteLength,
    });
    return Object.freeze({ outcome, bytes, mode: Number(firstStat.mode) });
  } catch (cause) {
    return unreadableReport(check, cause);
  }
}

function completionReportOutcome(report: CollectedReport): CompletionReportOutcome {
  return "outcome" in report ? report.outcome : report;
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

/** Spawn-failure and observation are different states, not one state with an
 *  optional report: a spawn failure can never have collected a report and an
 *  observed process always has one (possibly `missing`/`unreadable`). The
 *  report/process pairing is therefore a compile-time property — constructing a
 *  report on spawn-failure or a null report on observation is a type error, and
 *  consumers discriminate on `kind` instead of re-deriving the pairing at their
 *  own sites. The policy parameter keeps the second promise the runner already
 *  makes by construction: a required-file check never observes a
 *  `not-required` report, so the remediation overload below can hand its
 *  consumer an observation whose `not-required` arm does not exist. */
type ReportPolicy = ProjectCommandCheck["reportPolicy"];
type RequiredFileReportPolicy = Extract<ReportPolicy, { readonly kind: "required-file" }>;
type RequiredReportObservation = Exclude<CollectedReport, { readonly kind: "not-required" }>;

type CommandExecution<P extends ReportPolicy = ReportPolicy> =
  | Readonly<{
      kind: "spawn-failed";
      process: Extract<RawRemediationProcessOutcome, { readonly kind: "spawn-failed" }>;
      diagnostics: CompletionCheckDiagnostics;
    }>
  | Readonly<{
      kind: "observed";
      process: Extract<RawRemediationProcessOutcome, { readonly kind: "observed" }>;
      report: P extends RequiredFileReportPolicy ? RequiredReportObservation : CollectedReport;
      diagnostics: CompletionCheckDiagnostics;
    }>;

type CommandRunnerResult<P extends ReportPolicy = ReportPolicy> =
  | Readonly<{ ok: true; value: CommandExecution<P> }>
  | Readonly<{ ok: false; error: CompletionCheckRunnerFailure }>;

function spawnFailure(cause: unknown, output: CompletionCheckDiagnostics): CommandRunnerResult {
  return Object.freeze({
    ok: true,
    value: Object.freeze({
      kind: "spawn-failed" as const,
      process: Object.freeze({ kind: "spawn-failed", message: messageOf(cause) as NonEmptyString }),
      diagnostics: output,
    }),
  });
}

type ProcessGroupProbe =
  | Readonly<{ kind: "gone" }>
  | Readonly<{ kind: "present" }>
  | Readonly<{ kind: "eperm" }>
  | Readonly<{ kind: "error"; message: string }>;
export type { ProcessGroupProbe };

type LeaderProbe =
  | Readonly<{ kind: "present" }>
  | Readonly<{ kind: "gone" }>
  | Readonly<{ kind: "error"; message: string }>;
export type { LeaderProbe };

/** Ports at the containment-policy seam (architecture.md): the group/leader
 *  probes and the wall clock are narrow single-method ports whose production
 *  adapters are the real `process.kill`-backed probes and `Date.now`. Tests
 *  substitute plain closure fakes — no `process.kill` spy, no real waiting —
 *  so the deadline and EPERM-polarity policy below is testable at its own
 *  seam (atl-3). Defaults keep every production call site unchanged. */
export type GroupProbe = (processGroupId: number) => ProcessGroupProbe;
export type LeaderLivenessProbe = (processGroupId: number) => LeaderProbe;
export type WallClock = () => number;

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
    const code = errnoCode(cause);
    if (code === "ESRCH") return Object.freeze({ kind: "gone" });
    // EPERM is its own state, never a generic error: the group contains at
    // least one process we may not signal. Healthy descendants inherit our
    // uid, so our own tree does not normally produce this — but a descendant
    // that changes uid (setuid/sudo execution inside a project command) can:
    // after the leader is reaped, EPERM is exactly the all-survivors-uid-changed
    // state, and it is indistinguishable from a foreign id that recycled the
    // numeric group. EPERM therefore never proves dissolution on its own; it
    // must still be correlated with the leader probe (see
    // observeClosedProcessGroup, waitForProcessGroupGone, and the EPERM arm of
    // terminateProcessGroup).
    if (code === "EPERM") return Object.freeze({ kind: "eperm" });
    return Object.freeze({
      kind: "error",
      message: `process-group ${processGroupId} existence check failed: ${messageOf(cause)}`,
    });
  }
}

/** Liveness of the group LEADER itself (the spawned check process, positive
 *  pid). While the leader exists — including as an unreaped zombie — the
 *  group is legitimately ours. This invariant holds only while the spawned
 *  leader is un-reaped (the containment arm driven by
 *  `terminateProcessGroup`); once Node has reaped the leader, a positive-PID
 *  probe success names a recycled pid and the reaped-context rule of
 *  `observeClosedProcessGroup` applies instead — no negative-PGID signal is
 *  authorized. */
function probeLeaderAlive(processGroupId: number): LeaderProbe {
  try {
    process.kill(processGroupId, 0);
    return Object.freeze({ kind: "present" });
  } catch (cause) {
    return errnoCode(cause) === "ESRCH"
      ? Object.freeze({ kind: "gone" })
      : Object.freeze({
          kind: "error",
          message: `process-group ${processGroupId} leader check failed: ${messageOf(cause)}`,
        });
  }
}

type ClosedProcessGroupObservation =
  | Readonly<{ kind: "gone"; reason: "absent" | "recycled-leader" }>
  | Readonly<{ kind: "surviving-descendants" }>
  | Readonly<{ kind: "unconfirmed"; reason: "foreign-eperm" }>
  | Readonly<{ kind: "error"; message: string }>;
export type { ClosedProcessGroupObservation };

/** Only an ESRCH group probe confirms dissolution after the leader died.
 *
 *  EPERM cannot: it names at least one member we may not signal, which after
 *  the leader is reaped is exactly the all-survivors-changed-uid case (setuid
 *  execution inside a project command), and is indistinguishable from a
 *  foreign id that recycled the numeric group. Claiming either would misreport
 *  surviving descendants as contained. The caller waits for a provable ESRCH
 *  and refuses at its deadline instead; escalation to SIGKILL happens only
 *  where the escalation is identity-bound-authorized — while the spawned
 *  leader is un-reaped (see `decideEpermEscalation` and
 *  `decideSurvivingEscalation`) — never on an id that may no longer name this
 *  check's group.
 *
 *  The probe and clock are defaulted ports (see `GroupProbe`/`WallClock`):
 *  production callers omit them; tests pass plain fakes. */
export async function waitForProcessGroupGone(
  processGroupId: number,
  maximumWaitMs: number,
  groupProbe: GroupProbe = probeProcessGroup,
  now: WallClock = Date.now,
): Promise<ProcessGroupProbe> {
  const deadline = now() + maximumWaitMs;
  let latest = groupProbe(processGroupId);
  while (latest.kind !== "gone" && now() < deadline) {
    await delay(Math.min(GROUP_PROBE_INTERVAL_MS, Math.max(1, deadline - now())));
    latest = groupProbe(processGroupId);
  }
  return latest;
}

/** Classify a group only after Node has reaped the spawned leader.
 *
 * At that point a positive PID probe cannot name our leader. If it succeeds,
 * the PID/PGID has been recycled and no negative-PGID signal is authorized.
 * A still-present group with no leader can only be observed, never signalled:
 * once the leader closes there is no atomic identity-bound group signalling
 * primitive available to Node. And EPERM with a reaped leader is not a
 * dissolution proof either — it names unsignalable members (uid-changed
 * survivors) or a recycled foreign id, so it reports unconfirmed rather than
 * gone; only a provable ESRCH settles the outcome.
 *
 * Both probes are defaulted ports (see `GroupProbe`/`LeaderLivenessProbe`):
 * the group probe is invoked in the body — visible where it happens, and now
 * supplied by the wait loop that drives this classifier — and the leader
 * probe is injectable the same way. Production callers omit them; tests pass
 * plain fakes. */
export function observeClosedProcessGroup(
  processGroupId: number,
  groupProbe: GroupProbe = probeProcessGroup,
  leaderProbe: LeaderLivenessProbe = probeLeaderAlive,
): ClosedProcessGroupObservation {
  const group = groupProbe(processGroupId);
  if (group.kind === "gone") return Object.freeze({ kind: "gone", reason: "absent" });
  if (group.kind === "error") return Object.freeze({ kind: "error", message: group.message });
  const leader = leaderProbe(processGroupId);
  if (leader.kind === "error") return Object.freeze({ kind: "error", message: leader.message });
  if (leader.kind === "present") return Object.freeze({ kind: "gone", reason: "recycled-leader" });
  // Leader reaped. "present" names unsignalled survivors; EPERM names at
  // least one unsignalable member (or a recycled foreign id). Neither is a
  // dissolution proof, so neither may be reported as contained: keep
  // observing (the state may still resolve to a provable ESRCH) and fail
  // closed at the deadline.
  return group.kind === "eperm"
    ? Object.freeze({ kind: "unconfirmed", reason: "foreign-eperm" })
    : Object.freeze({ kind: "surviving-descendants" });
}

export async function waitForClosedProcessGroup(
  processGroupId: number,
  maximumWaitMs: number,
  groupProbe: GroupProbe = probeProcessGroup,
  leaderProbe: LeaderLivenessProbe = probeLeaderAlive,
  now: WallClock = Date.now,
): Promise<ClosedProcessGroupObservation> {
  const deadline = now() + maximumWaitMs;
  let observation = observeClosedProcessGroup(processGroupId, groupProbe, leaderProbe);
  // Both undecided states keep the observation loop alive: surviving
  // descendants may exit, and an EPERM group may still resolve to a provable
  // ESRCH once its uid-changed members exit. Only a confirmed-gone or an
  // expiry ends the wait, and expiry is always the caller's refusal.
  while ((observation.kind === "surviving-descendants" || observation.kind === "unconfirmed") &&
         now() < deadline) {
    await delay(Math.min(GROUP_PROBE_INTERVAL_MS, Math.max(1, deadline - now())));
    observation = observeClosedProcessGroup(processGroupId, groupProbe, leaderProbe);
  }
  return observation;
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

/** Reaping-phase provenance for the containment decision
 *  (type-design-analyzer-1): the spawned check's `exit` event is the knowable
 *  bit. Node reaps the child at `exit`, which precedes `close` whenever a
 *  descendant holds stdio, so `leader-unreaped` is the only phase in which a
 *  positive-PID probe success can still name this check's own leader
 *  (including as an unreaped zombie). */
type LeaderReapingPhase =
  | Readonly<{ kind: "leader-unreaped" }>
  | Readonly<{ kind: "leader-reaped" }>;
export type { LeaderReapingPhase };

/** The EPERM arm's post-SIGTERM decision, phase-explicit and pure so the
 *  polarity table is directly testable. In the leader-reaped phase the numeric
 *  id is no longer identity-bound and the decision refuses further signalling
 *  whatever the leader probe answers. In the leader-unreaped phase the
 *  code-reviewer-1 escalation holds: an EPERM group whose leader probe answers
 *  present is still legitimately ours and escalates, while leader-gone
 *  (and leader-error, recorded) refuse as the ambiguous states they are. */
type EpermEscalationDecision =
  | Readonly<{ kind: "escalate" }>
  | Readonly<{ kind: "refuse-recycled-id" }>
  | Readonly<{ kind: "refuse-ambiguous-leader"; leaderMessage: string | null }>;
export type { EpermEscalationDecision };

function decideEpermEscalation(phase: LeaderReapingPhase, leader: LeaderProbe): EpermEscalationDecision {
  switch (phase.kind) {
    case "leader-reaped":
      return Object.freeze({ kind: "refuse-recycled-id" });
    case "leader-unreaped":
      switch (leader.kind) {
        case "present":
          return Object.freeze({ kind: "escalate" });
        case "gone":
          return Object.freeze({ kind: "refuse-ambiguous-leader", leaderMessage: null });
        case "error":
          return Object.freeze({ kind: "refuse-ambiguous-leader", leaderMessage: leader.message });
      }
  }
}
export { decideEpermEscalation };

/** The plainly-surviving arm's post-SIGTERM decision: escalate only while the
 *  spawned leader is un-reaped (the id is still identity-bound); in the
 *  leader-reaped phase the same present group may name recycled authority and
 *  the decision refuses the SIGKILL the pre-phase code sent unconditionally. */
type SurvivingEscalationDecision =
  | Readonly<{ kind: "escalate" }>
  | Readonly<{ kind: "refuse-recycled-id" }>;
export type { SurvivingEscalationDecision };

function decideSurvivingEscalation(phase: LeaderReapingPhase): SurvivingEscalationDecision {
  return phase.kind === "leader-reaped"
    ? Object.freeze({ kind: "refuse-recycled-id" })
    : Object.freeze({ kind: "escalate" });
}
export { decideSurvivingEscalation };

/** One settled-observation refusal builder for the two post-close-style
 *  flows (parent closed; leader-reaped trigger). The parent-closed prose is
 *  byte-pinned and stays identical; only the subject and the surviving
 *  descendants' trailing clause differ per flow. */
function settledProcessGroupRefusal(
  subject: string,
  survivingClause: string,
  processGroupId: number,
  settled: Exclude<ClosedProcessGroupObservation, { readonly kind: "gone" }>,
): string {
  switch (settled.kind) {
    case "error":
      return `${subject} but process-tree identity could not be observed: ${settled.message}`;
    case "unconfirmed":
      return `${subject} but process-group ${processGroupId} dissolution could not be confirmed ` +
        "(EPERM): a member refuses signalling, so the group is neither provably ours nor provably gone";
    case "surviving-descendants":
      return `${subject} while process-group ${processGroupId} descendants remained; ${survivingClause}`;
  }
}

async function terminateProcessGroup(
  processGroupId: number,
  graceMs: number,
  hardKillWaitMs: number,
  reapingPhase: () => LeaderReapingPhase,
  groupProbe: GroupProbe = probeProcessGroup,
  leaderProbe: LeaderLivenessProbe = probeLeaderAlive,
  now: WallClock = Date.now,
): Promise<Readonly<{ ok: true }> | Readonly<{ ok: false; message: string }>> {
  const errors: string[] = [];
  // Phase gate before the first signal (type-design-analyzer-1): once the
  // spawned leader's exit is observed, the numeric id is no longer
  // identity-bound and this module sends nothing at all. The trigger arm
  // routes that state to the closed-path observer; this guard covers a phase
  // flip between that check and the send.
  if (reapingPhase().kind === "leader-reaped") {
    return Object.freeze({
      ok: false,
      message: `process-group ${processGroupId} containment refused: the spawned leader already exited, ` +
        "so the numeric group id is no longer identity-bound and further signalling is unauthorized",
    });
  }
  const termError = signalProcessGroup(processGroupId, "SIGTERM");
  if (termError !== null) errors.push(termError);

  const afterTerm = await waitForProcessGroupGone(processGroupId, graceMs, groupProbe, now);
  if (afterTerm.kind === "error") errors.push(afterTerm.message);

  // Post-SIGTERM escalation, decided by the phase-explicit decision functions
  // above. The escalation itself is unchanged: signal, then wait for a
  // provable ESRCH through the same injected ports as the pre-kill wait.
  const escalateToSigkill = async (): Promise<void> => {
    const killError = signalProcessGroup(processGroupId, "SIGKILL");
    if (killError !== null) errors.push(killError);
    const afterKill = await waitForProcessGroupGone(processGroupId, hardKillWaitMs, groupProbe, now);
    if (afterKill.kind === "error") errors.push(afterKill.message);
    if (afterKill.kind === "eperm") {
      errors.push(`process-group ${processGroupId} dissolution could not be confirmed after SIGKILL (EPERM)`);
    } else if (afterKill.kind !== "gone") {
      errors.push(`process-group ${processGroupId} still exists after SIGKILL containment`);
    }
  };
  // EPERM after SIGTERM cannot prove dissolution ON ITS OWN (uid-changed
  // survivors vs a recycled foreign id), so the arm correlates the leader
  // probe AND the reaping phase: in the leader-unreaped phase the module's own
  // leader invariant — while the leader exists, including as an unreaped
  // zombie, the group is legitimately ours — binds the numeric id whenever the
  // leader is still alive, so a leader-alive group escalates to SIGKILL
  // exactly like a plainly surviving one; the leader-reaped phase — where the
  // id may already name recycled authority — refuses WITHOUT any further
  // signal, as does the ambiguous leader-gone/leader-error state.
  if (afterTerm.kind === "eperm") {
    const leader = leaderProbe(processGroupId);
    if (leader.kind === "error") errors.push(leader.message);
    const decision = decideEpermEscalation(reapingPhase(), leader);
    switch (decision.kind) {
      case "escalate":
        await escalateToSigkill();
        break;
      case "refuse-recycled-id":
        errors.push(
          `process-group ${processGroupId} dissolution could not be confirmed after SIGTERM (EPERM); ` +
          "the spawned leader already exited, so the numeric group id may name recycled authority and signalling is refused",
        );
        break;
      case "refuse-ambiguous-leader":
        errors.push(
          `process-group ${processGroupId} dissolution could not be confirmed after SIGTERM (EPERM); ` +
          "signalling an id that may no longer name this check's group is refused",
        );
        break;
    }
  } else if (afterTerm.kind !== "gone") {
    const decision = decideSurvivingEscalation(reapingPhase());
    switch (decision.kind) {
      case "escalate":
        await escalateToSigkill();
        break;
      case "refuse-recycled-id":
        errors.push(
          `process-group ${processGroupId} still exists after SIGTERM; the spawned leader already exited, ` +
          "so the numeric group id may name recycled authority and SIGKILL escalation is refused",
        );
        break;
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
  check: RunnerCommand,
  beforeReport: ReportSnapshot | null,
  stdout: DiagnosticTail,
  stderr: DiagnosticTail,
  observation: Extract<ParentObservation, { readonly kind: "closed" }>,
  timedOut: boolean,
  reportMode: "wave-snapshot" | "remediation-reset",
): CommandRunnerResult {
  const output = diagnostics(stdout, stderr);
  const signal = observation.signal === null ? null : parseCompletionSignal(observation.signal);
  if (signal !== null && !signal.ok) {
    return failed({
      kind: "termination-unconfirmed",
      message: `Node reported a signal outside the completion allowlist: ${signal.error.errors.join("; ")}`,
      diagnostics: output,
    });
  }
  return Object.freeze({
    ok: true,
    value: Object.freeze({
      kind: "observed" as const,
      process: Object.freeze({
        kind: "observed" as const,
        exitCode: observation.exitCode,
        timedOut,
        signal: signal === null ? null : signal.value,
      }),
      report: observeReportAfterClose(root, check, beforeReport,
        reportMode === "remediation-reset" ? MAX_STRUCTURED_REPORT_BYTES : undefined),
      diagnostics: output,
    }),
  });
}

/**
 * Execute one parser-proven project command with no shell. On POSIX the child
 * owns a detached process group; no result is returned until that whole group
 * is proven gone. Every expected infrastructure failure is returned as data.
 */
/** The remediation authority type-pins its command's report policy to
 *  `required-file`, so its observed executions can never collect a
 *  `not-required` report — the overload states that promise in the type the
 *  consumer sees instead of a defensive runtime branch. */
async function runProjectCommand(
  selected: AuthorizedRemediationCheck,
  repositoryRoot: CanonicalRepositoryRoot,
  options: CompletionCheckRunnerOptions,
): Promise<CommandRunnerResult<RequiredFileReportPolicy>>;
async function runProjectCommand(
  selected: ProjectCommandCheck | AuthorizedRemediationCheck,
  repositoryRoot: CanonicalRepositoryRoot,
  options: CompletionCheckRunnerOptions,
): Promise<CommandRunnerResult>;
async function runProjectCommand(
  selected: ProjectCommandCheck | AuthorizedRemediationCheck,
  repositoryRoot: CanonicalRepositoryRoot,
  options: CompletionCheckRunnerOptions,
): Promise<CommandRunnerResult> {
  const check = selected.kind === "authorized-remediation-check" ? selected.command : selected;
  const reportMode = selected.kind === "authorized-remediation-check" ? "remediation-reset" : "wave-snapshot";
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

  let cwd: string;
  try {
    if (check.cwd === ".") cwd = repositoryRoot;
    else {
      const inspected = inspectRepositoryPath(repositoryRoot, check.cwd, "completion check cwd", { mustExist: true });
      const stat = lstatSync(inspected.absolute);
      if (!stat.isDirectory()) throw new Error("completion check cwd must be a real directory");
      cwd = inspected.absolute;
    }
  } catch (cause) {
    return failed({ kind: "path-rejected", path: check.cwd, message: messageOf(cause) });
  }

  if (reportMode === "remediation-reset") {
    try {
      resetRemediationReport(repositoryRoot, check);
    } catch (cause) {
      return failed({
        kind: "report-reset-failed",
        path: check.reportPolicy.kind === "required-file" ? check.reportPolicy.path : "",
        message: `required report reset failed before launch: ${messageOf(cause)}`,
      });
    }
  }
  const reportObservation = preSpawnReportSnapshot(repositoryRoot, check);
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
    return spawnFailure(cause, diagnostics(stdout, stderr));
  }
  const parent = parentObservation(child);
  // type-design-analyzer-1: the knowable reaping-phase bit. Node reaps the
  // spawned child at `exit`, which precedes `close` whenever a descendant
  // holds stdio; once observed, the numeric group id is no longer
  // identity-bound and no further negative-PGID signal is authorized.
  let leaderExitObserved = false;
  child.once("exit", () => {
    leaderExitObserved = true;
  });
  const reapingPhase = (): LeaderReapingPhase =>
    leaderExitObserved
      ? Object.freeze({ kind: "leader-reaped" })
      : Object.freeze({ kind: "leader-unreaped" });
  const processGroupId = child.pid;
  if (processGroupId === undefined) {
    return spawnFailure("spawn returned no process id", diagnostics(stdout, stderr));
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
      return spawnFailure(trigger.observation.cause, diagnostics(stdout, stderr));
    }
    const initialGroup = observeClosedProcessGroup(processGroupId);
    if (initialGroup.kind === "gone") {
      return observedExecution(
        repositoryRoot,
        check,
        beforeReport,
        stdout,
        stderr,
        trigger.observation,
        false,
        reportMode,
      );
    }
    if (initialGroup.kind === "error") {
      return failed({
        kind: "termination-unconfirmed",
        message: `completion parent closed but process-tree identity could not be observed: ${initialGroup.message}`,
        diagnostics: diagnostics(stdout, stderr),
      });
    }
    const settled = await waitForClosedProcessGroup(processGroupId, hardKillWaitMs);
    if (settled.kind !== "gone") {
      return failed({
        kind: "termination-unconfirmed",
        message: settledProcessGroupRefusal(
          "completion parent closed",
          "post-close signalling was refused because the numeric group id is no longer identity-bound",
          processGroupId,
          settled,
        ),
        diagnostics: diagnostics(stdout, stderr),
      });
    }
    return failed({
      kind: "process-tree-survived",
      message: `completion parent closed while process-group ${processGroupId} descendants remained; ` +
        "the runner waited for them to exit without signalling an unbound numeric group id",
      exitCode: trigger.observation.exitCode,
      signal: trigger.observation.signal,
      diagnostics: diagnostics(stdout, stderr),
    });
  }

  // type-design-analyzer-1: a timeout/cancellation trigger after the spawned
  // leader's `exit` was observed runs in the leader-reaped phase — Node reaped
  // the child (before `close`, which descendants holding stdio can withhold),
  // so the numeric group id is no longer identity-bound and this module
  // signals nothing further. The state is exactly the closed-parent
  // classification: observe, wait for a provable ESRCH, and report
  // fail-closed. SIGTERM/SIGKILL escalation stays authorized only in the
  // leader-unreaped phase handled below.
  if (reapingPhase().kind === "leader-reaped") {
    const initialGroup = observeClosedProcessGroup(processGroupId);
    if (initialGroup.kind === "error") {
      return failed({
        kind: "termination-unconfirmed",
        message: `${trigger.kind} completion check ended but process-tree identity could not be observed: ${initialGroup.message}`,
        diagnostics: diagnostics(stdout, stderr),
      });
    }
    const settled = initialGroup.kind === "gone"
      ? Object.freeze({ kind: "gone", reason: "absent" } as const)
      : await waitForClosedProcessGroup(processGroupId, hardKillWaitMs);
    if (settled.kind !== "gone") {
      return failed({
        kind: "termination-unconfirmed",
        message: settledProcessGroupRefusal(
          `${trigger.kind} completion check ended`,
          "post-exit signalling was refused because the numeric group id is no longer identity-bound",
          processGroupId,
          settled,
        ),
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
        message: "completion check cancelled after its process group dissolved without signalling",
        exitCode: closed.exitCode,
        signal: closed.signal,
        diagnostics: diagnostics(stdout, stderr),
      });
    }
    if (initialGroup.kind !== "gone") {
      return failed({
        kind: "process-tree-survived",
        message: `${trigger.kind} completion check ended while process-group ${processGroupId} descendants remained; ` +
          "the runner waited for them to exit without signalling an unbound numeric group id",
        exitCode: closed.exitCode,
        signal: closed.signal,
        diagnostics: diagnostics(stdout, stderr),
      });
    }
    return observedExecution(
      repositoryRoot,
      check,
      beforeReport,
      stdout,
      stderr,
      closed,
      true,
      reportMode,
    );
  }

  const containment = await terminateProcessGroup(processGroupId, graceMs, hardKillWaitMs, reapingPhase);
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
    repositoryRoot,
    check,
    beforeReport,
    stdout,
    stderr,
    closed,
    true,
    reportMode,
  );
}

function validatedRepositoryRoot(
  repositoryRoot: CanonicalRepositoryRoot,
): Readonly<{ ok: true; value: CanonicalRepositoryRoot }> |
   Readonly<{ ok: false; error: CompletionCheckRunnerFailure }> {
  const parsed = parseCanonicalRepositoryRoot(repositoryRoot);
  if (parsed.ok) return Object.freeze({ ok: true, value: parsed.value });
  const message = "message" in parsed.error ? parsed.error.message : "repository root observation drifted";
  return failed({ kind: "invalid-runner-authority", message });
}

/** Existing Wave wrapper. Its public result and report projection remain unchanged. */
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
  const root = validatedRepositoryRoot(repositoryRoot);
  if (!root.ok) return root;
  const execution = await runProjectCommand(parsedCheck.value, root.value, options);
  if (!execution.ok) return execution;
  const outcome: CompletionProcessOutcome = execution.value.kind === "spawn-failed"
    ? execution.value.process
    : Object.freeze({
        ...execution.value.process,
        report: completionReportOutcome(execution.value.report),
      });
  const checkResult: CompletionCheckResult = Object.freeze({
    checkId: parsedCheck.value.checkId,
    scope: "wave",
    outcome,
  });
  return completionSucceeded({ checkResult, diagnostics: execution.value.diagnostics });
}

function remediationReportObservation(
  report: Exclude<CollectedReport, { readonly kind: "not-required" }>,
): RemediationReportObservation {
  if (!("outcome" in report)) return Object.freeze({ outcome: report });
  return Object.freeze({
    outcome: report.outcome,
    bytes: report.bytes,
    mode: report.mode,
    parsedReportFacts: parseStructuredTestReportBytes(report.bytes),
  });
}

/**
 * Execute one core-authorized standalone remediation check. The returned facts
 * are raw event ingredients, never a pass or installation authority.
 */
export async function runRemediationCheck(
  check: AuthorizedRemediationCheck,
  repositoryRoot: CanonicalRepositoryRoot,
  options: CompletionCheckRunnerOptions = {},
): Promise<RemediationCheckRunnerResult> {
  if (check.kind !== "authorized-remediation-check" ||
      check.scope.kind !== "standalone-remediation" ||
      check.command.kind !== "project-command" ||
      check.command.reportPolicy.kind !== "required-file") {
    return failed({
      kind: "invalid-runner-authority",
      message: "runner requires a core-authorized standalone remediation project command with a required report",
    });
  }
  const root = validatedRepositoryRoot(repositoryRoot);
  if (!root.ok) return root;
  const execution = await runProjectCommand(check, root.value, options);
  if (!execution.ok) return execution;
  // A spawn failure never collected a report; an observed required-file check
  // always has one whose `not-required` arm does not exist (see the
  // `runProjectCommand` overload promise). One envelope, discriminated by the
  // CommandExecution ADT at the single field the arms differ in.
  return Object.freeze({
    ok: true,
    value: Object.freeze({
      kind: "remediation-check-execution" as const,
      checkId: check.command.checkId,
      scope: check.scope,
      manifestDigest: check.manifestDigest,
      authorityDigest: check.authorityDigest,
      process: execution.value.process,
      report: execution.value.kind === "spawn-failed"
        ? null
        : remediationReportObservation(execution.value.report),
      diagnostics: execution.value.diagnostics,
    }),
  });
}
