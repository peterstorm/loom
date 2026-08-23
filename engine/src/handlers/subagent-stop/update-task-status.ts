/**
 * Resolve implementation completion into the Task's proof state.
 *
 * 1. Resolve test evidence — the agent's own epoch in the evidence ledger
 *    (execution-time ground truth) first; transcript regex as the labeled,
 *    lower-trust fallback
 * 2. Verify new tests written via git diff + assertion density
 * 3. Atomically persist evidence and the derived Proof aggregate
 * 4. Mark implemented only when every obligation is satisfied; otherwise keep
 *    the Task pending, then signal /wave-gate only when the Wave is complete
 */

import { lstatSync, readFileSync } from "node:fs";
import type { HookHandler, HookResult, SubagentStopInput, Task, TaskGraph, TaskTestResult } from "../../types";
import { legacyTestsPassedNote, newWaveGate, testResultPassed } from "../../types";
import { IMPL_AGENTS, machinesDir } from "../../config";
import { StateManager } from "../../state-manager";
import { stripNamespace } from "../../utils/strip-namespace";
import { extractTaskId } from "../../utils/extract-task-id";
import { resolveAgentTranscriptPath, resolveAgentType } from "../../utils/agent-transcript-path";
import { canonicalRepositoryPaths } from "../../utils/repository-path";
import {
  compareAttemptBaseline,
} from "../../utils/artifact-baseline";
import { attributedChangedArtifacts } from "../../core/artifact-baseline";
import { invalidateTaskReview } from "../../core/review-output";
import { parseTranscript } from "../../parsers/parse-transcript";
import { parseFilesModified } from "../../parsers/parse-files-modified";
import { parseBashTestOutput } from "../../parsers/parse-bash-test-output";
import * as git from "../../utils/git";
import {
  epochOf,
  eventsForEpoch,
  foldEvidence,
  judgeTestRun,
  loadMachine,
  missingRequirements,
  parseAgentId,
  parseAgentType,
  parseSessionId,
  readEvidence,
} from "../../machine";
import type { Evidence, EvidenceRecord, LoadedMachine, Requirement, TrustedTestVerdict } from "../../machine";
import {
  evaluateTaskProof,
  PI_STRUCTURED_EVIDENCE_POLICY,
  TRUSTED_LEDGER_ONLY_POLICY,
  type ProofEvaluationPolicy,
} from "../../core/proof-obligations";
import { passthroughDiagnostic } from "../../utils/hook-diagnostic";
import { extractTestEvidence } from "../../core/test-evidence";
import {
  taskVerificationPolicy,
  type NewTestWaiverReason,
  type VerificationRequirement,
} from "../../core/verification-policy";

/**
 * Is the agent's machine BOUND for evidence purposes? "invalid" counts as
 * bound: a machine definition exists for this agent — ground truth was
 * expected — so an empty ledger must surface as "degraded", not be
 * mislabeled as an unbound/legacy "fallback" run.
 */
export function isMachineBound(loaded: LoadedMachine): boolean {
  return loaded.kind !== "none";
}

// --- Pure: resolve test evidence, ledger first ---

export interface ResolvedTestEvidence {
  /** Verdict + trust provenance — exactly what gets persisted on the Task. */
  readonly result: TaskTestResult;
  /** Human-readable provenance line for test_evidence. */
  readonly evidence: string;
}

type TestRunEvidence = Extract<Evidence, { kind: "TestRun" }>;

/**
 * Ground truth beats transcript regex. The agent's own epoch in the
 * evidence ledger decides when it has a trusted TestRun (judgment derived
 * from stored FACTS via judgeTestRun — never read back from the ledger).
 * The verdict comes from the LAST trusted run — except that a trusted
 * FAILURE is considered stale once a later exit-0 run exists (the agent
 * plausibly fixed and re-ran without a report artifact): that case routes
 * to the labeled low-trust fallback, and an untrusted run is NEVER
 * promoted to a trusted pass. The transcript-regex extractor is the
 * explicit lower-trust fallback, labeled by exactly how weak it is:
 * - "low-trust"  — some exit-0 ledger run exists but the verdict could not
 *                  be trusted (no report artifact for the deciding run), OR
 *                  files were modified AFTER the deciding trusted pass (the
 *                  pass vouches for code that no longer exists)
 * - "degraded"   — the machine was bound but the ledger is empty (recorder
 *                  failure: the fallback is running where ground truth was
 *                  expected)
 * - "fallback"   — no machine is bound for this agent type (unbound/legacy
 *                  runs): ground truth was never expected here, so the
 *                  transcript regex is the NORMAL source for the run, not a
 *                  degradation — the label still marks it untrusted
 * - "snapshot-read-failed" — the dispatcher could not READ the ledger
 *                  (`snapshotFailed`): ledger contents are unknown, which is
 *                  distinct from a genuinely-empty ledger — never mislabel
 *                  it "degraded". `ledgerEvents` are ignored in this mode.
 */
function fallbackEvidenceLabel(
  demotionLabel: string | null,
  sawExitZero: boolean,
  machineBound: boolean,
  ledgerEmpty: boolean,
): string {
  if (demotionLabel !== null) return demotionLabel;
  if (sawExitZero) return "low-trust (exit 0, no report artifact; transcript-regex)";
  if (machineBound && ledgerEmpty) {
    return "degraded (machine bound, no ledger evidence; transcript-regex)";
  }
  return "transcript-regex (fallback)";
}

function untrustedTranscriptEvidence(label: string, bashOutput: string): ResolvedTestEvidence {
  const transcript = extractTestEvidence(bashOutput);
  return transcript.passed
    ? {
        result: { verdict: "untrusted", passed: true, label, provenance: "unverified" },
        evidence: `${label}: ${transcript.evidence}`,
      }
    : {
        result: { verdict: "untrusted", passed: false, label, provenance: "unverified" },
        evidence: "",
      };
}

export function resolveTestEvidence(
  ledgerEvents: readonly Evidence[],
  bashOutput: string,
  machineBound: boolean,
  snapshotFailed: boolean = false,
): ResolvedTestEvidence {
  if (snapshotFailed) {
    return untrustedTranscriptEvidence(
      "snapshot-read-failed (ledger snapshot unreadable; transcript-regex)",
      bashOutput,
    );
  }
  // Judge TestRuns keeping their POSITION in the ordered ledger, so later
  // non-TestRun events (FileWrite) can be related to the deciding run.
  const judged = ledgerEvents.flatMap((event, index) =>
    event.kind === "TestRun"
      ? [{ run: event as TestRunEvidence, index, verdict: judgeTestRun(event.exit, event.report) }]
      : [],
  );

  // Last GROUND-TRUTH run (trusted-pass or trusted-fail), with its ledger index.
  const lastTrusted = judged.reduce<
    { index: number; run: TestRunEvidence; verdict: TrustedTestVerdict } | null
  >((acc, { run, index, verdict }) => {
    return verdict.verdict === "untrusted" ? acc : { index, run, verdict };
  }, null);

  let demotionLabel: string | null = null;
  if (lastTrusted !== null) {
    // A trusted PASS is stale once any FileWrite follows it in the ledger:
    // the run vouched for code that has since been modified. Demote to the
    // labeled low-trust fallback — never keep (or re-mint) trusted-pass.
    const laterFileWrite = ledgerEvents
      .slice(lastTrusted.index + 1)
      .some((e) => e.kind === "FileWrite");
    // A stale trusted failure must not outrank a later untrusted exit-0
    // run — but that later run earns only the low-trust fallback below,
    // never a trusted pass.
    const laterExitZero = judged.some((j) => j.index > lastTrusted.index && j.run.exit === 0);

    const keepTrusted =
      lastTrusted.verdict.verdict === "trusted-pass" ? !laterFileWrite : !laterExitZero;
    if (keepTrusted) {
      const report = lastTrusted.run.report
        ? `, report: ${lastTrusted.run.report.total} tests / ${lastTrusted.run.report.failed} failed`
        : "";
      return {
        result: lastTrusted.verdict,
        evidence: `ledger: exit ${lastTrusted.run.exit}${report} (${lastTrusted.run.command})`,
      };
    }
    if (lastTrusted.verdict.verdict === "trusted-pass") {
      demotionLabel = "low-trust (files modified after last trusted pass; transcript-regex)";
    }
  }

  const label = fallbackEvidenceLabel(
    demotionLabel,
    judged.some((judgment) => judgment.run.exit === 0),
    machineBound,
    ledgerEvents.length === 0,
  );
  return untrustedTranscriptEvidence(label, bashOutput);
}

/**
 * The machine's completion judgment, applied to the resolved verdict: when
 * the agent's machine declares terminal requirements the epoch's evidence
 * does not satisfy, a resolution claiming a TRUSTED PASS is capped at
 * untrusted with a "machine-incomplete" label naming exactly what is
 * missing — completion must not be self-reported past the machine. A
 * trusted FAIL is already ground truth of non-completion (the gate treats
 * it as missing evidence) and is kept as-is; untrusted resolutions are
 * already at the floor.
 */
export function capVerdictForMachineCompletion(
  resolved: ResolvedTestEvidence,
  missing: readonly Requirement[],
): ResolvedTestEvidence {
  if (missing.length === 0 || resolved.result.verdict !== "trusted-pass") return resolved;
  const reqs = missing.map((r) => `${r.event} ≥ ${r.min}`).join(", ");
  const label = `machine-incomplete: ${reqs}`;
  return {
    result: { verdict: "untrusted", passed: true, label, provenance: "unverified" },
    evidence: `${label} — ${resolved.evidence}`,
  };
}

// --- Pure: untrusted Stop-resolution TOCTOU re-check (shared with pi) ---

/** What an untrusted Stop-handler resolution wants to persist on the task. */
export interface UntrustedStopResolution {
  /** Process-level completion observed by the harness. A failed child may
   * retain structural attribution, but it must never mint completion proof. */
  readonly taskCompleted: boolean;
  readonly testResult: Extract<TaskTestResult, { verdict: "untrusted" }>;
  readonly testEvidence: string;
  /** Files the agent modified (parsed from its transcript) — persisted on
   *  the task because lint-wave-gate collects its lint targets EXCLUSIVELY
   *  from `files_modified`; a resolution that omits it makes every wave-gate
   *  lint run over an empty set and report clean (round-16 pi finding). */
  readonly filesModified: readonly string[];
  /** Declared artifacts whose current bytes differ from the first task
   *  baseline. This, not attempted tool calls, discharges artifact proof. */
  readonly changedDeclaredArtifacts: readonly string[];
  /** Whether declared bytes differ from the baseline captured for this exact
   * attempt. This invalidates older test/review evidence independently of
   * transcript tool attribution. */
  readonly bytesChangedSinceAttempt: boolean;
  readonly newTestsWritten: boolean;
  readonly newTestEvidence: string;
}

export function cumulativeModifiedPaths(
  previous: readonly string[] | undefined,
  current: readonly string[],
): string[] {
  return [...new Set([...(previous ?? []), ...current])].sort();
}

export interface AppliedStopResolution {
  readonly state: TaskGraph;
  /** true → the target was missing/completed; task evidence was not updated. */
  readonly skipped: boolean;
}

/**
 * Install one resolved task and reset its wave gate — the ONE transition both
 * harnesses make when an implementation child stops.
 *
 * It was written twice: once on the Claude-side path and once in pi's Stop
 * mirror, whose own comment called itself "Mirror of the Claude-side reset
 * above". Only convention kept the copies equal, and they encode a rule that
 * must not drift — a code change invalidates the task's review AND drops the
 * evidence the wave gate would otherwise read as green: `tests_passed` and
 * `reviews_complete` reset, and `blocked` clears only when the cause it
 * tracks (this wave's critical spec-check record, dropped here) goes with it.
 * Leaving `blocked: true` behind used to print "BLOCKED due to:" with no
 * listed reason.
 *
 * The two callers differ ONLY in which fields they write onto the task, so
 * that is the one thing passed in.
 */
function applyResolvedTask(
  s: TaskGraph,
  taskId: string,
  wave: number,
  codeChanged: boolean,
  clearedExecuting: readonly string[],
  resolveTask: (task: Task) => Task,
): TaskGraph {
  const resolved: TaskGraph = {
    ...s,
    tasks: s.tasks.map((t) => {
      if (t.id !== taskId) return t;
      const updated = resolveTask(t);
      return codeChanged ? invalidateTaskReview(updated) : updated;
    }),
    executing_tasks: [...clearedExecuting],
  };
  const specCheckCleared = codeChanged && resolved.spec_check?.wave === wave;
  return {
    ...resolved,
    ...(specCheckCleared ? { spec_check: undefined } : {}),
    wave_gates: {
      ...resolved.wave_gates,
      [String(wave)]: {
        ...(resolved.wave_gates[String(wave)] ?? newWaveGate()),
        impl_complete: isWaveComplete(resolved, wave),
        ...(codeChanged
          ? {
              tests_passed: null,
              reviews_complete: false,
              ...(specCheckCleared ? { blocked: false } : {}),
            }
          : {}),
      },
    },
  };
}

/** Infrastructure could not observe completion. Historical evidence remains
 * audit data, but pending + revalidation removes its completion authority. */
export function applyCompletionInfrastructureFailure(
  state: TaskGraph,
  taskId: string,
  bytesChangedSinceAttempt: boolean,
): TaskGraph {
  const target = state.tasks.find((task) => task.id === taskId);
  const clearedExecuting = (state.executing_tasks ?? []).filter((id) => id !== taskId);
  if (target === undefined || target.status === "completed") {
    return { ...state, executing_tasks: clearedExecuting };
  }
  return applyResolvedTask(
    state,
    taskId,
    target.wave,
    bytesChangedSinceAttempt,
    clearedExecuting,
    (task) => ({ ...task, status: "pending", revalidation_required: true }),
  );
}

/**
 * The verdict-resolution decision for an UNTRUSTED Stop-handler resolution,
 * meant to run INSIDE the locked state update (pi/extension.ts's Stop
 * handler): a pre-lock snapshot can be outdated by a concurrent writer
 * before the write lands (TOCTOU), so the target is re-found and re-checked
 * against the CURRENT state here. Unless explicit revalidation is required,
 * an untrusted resolution never overwrites a trusted failure and preserves a
 * trusted pass only while no newer code bytes were attributed to this retry;
 * historical green evidence cannot prove changed bytes. A completed task is never reopened — but the agent still
 * STOPPED either way, so the task is
 * always removed from executing_tasks (leaving it would ghost-block
 * duplicate-spawn checks for the rest of the session).
 */
export function applyUntrustedStopResolution(
  s: TaskGraph,
  taskId: string,
  resolution: UntrustedStopResolution,
  proofPolicy: ProofEvaluationPolicy = PI_STRUCTURED_EVIDENCE_POLICY,
): AppliedStopResolution {
  const clearedExecuting = (s.executing_tasks ?? []).filter((id) => id !== taskId);
  const target = s.tasks.find((t) => t.id === taskId);
  if (!target || target.status === "completed") {
    return { state: { ...s, executing_tasks: clearedExecuting }, skipped: true };
  }
  const codeChanged = resolution.bytesChangedSinceAttempt;
  const preserveExistingTrusted = target.revalidation_required !== true && (
    target.test_result?.verdict === "trusted-fail" ||
    (target.test_result?.verdict === "trusted-pass" && !codeChanged)
  );
  const cumulativeFiles = cumulativeModifiedPaths(target.files_modified, resolution.filesModified);
  const currentNewTests: NewTestEvidence = {
    written: resolution.newTestsWritten,
    evidence: resolution.newTestEvidence,
  };
  const proofTestResult = preserveExistingTrusted ? target.test_result : resolution.testResult;
  const proofArtifactsChanged = attributedChangedArtifacts(
    resolution.changedDeclaredArtifacts,
    cumulativeFiles,
  );
  const proof = evaluateTaskProof(
    {
      verificationPolicy: taskVerificationPolicy(target),
      declaredArtifacts: target.file_list ?? [],
    },
    {
      taskCompleted: resolution.taskCompleted,
      testResult: proofTestResult,
      filesModified: proofArtifactsChanged,
      newTestsWritten: currentNewTests.written,
      newTestEvidence: currentNewTests.evidence,
    },
    proofPolicy,
  );
  return {
    skipped: false,
    state: applyResolvedTask(s, taskId, target.wave, codeChanged, clearedExecuting, (t) => ({
      ...t,
      status: proof.state === "satisfied" ? "implemented" : "pending",
      proof,
      test_result: proofTestResult,
      test_evidence: preserveExistingTrusted ? t.test_evidence : resolution.testEvidence,
      files_modified: cumulativeFiles,
      new_tests_written: currentNewTests.written,
      new_test_evidence: currentNewTests.evidence,
      ...(resolution.taskCompleted && testResultPassed(resolution.testResult)
        ? { revalidation_required: undefined }
        : {}),
    })),
  };
}

/**
 * Wave completion: no task in the wave is still short of
 * implemented/completed. Shared by the engine's update-task-status and pi's
 * Stop mirror so the two harnesses cannot drift; pi calls it INSIDE its
 * locked update so the impl_complete gate write is decided against the same
 * state the resolution landed on. Note (long-standing semantics both
 * callers inlined): a wave with NO tasks counts as complete.
 */
export function isWaveComplete(state: TaskGraph, wave: number): boolean {
  return state.tasks
    .filter((task) => task.wave === wave)
    .every((task) => task.status === "implemented" || task.status === "completed");
}

// --- Pure: determine new test evidence from diff ---

export interface NewTestEvidence {
  readonly written: boolean;
  readonly evidence: string;
}

type NewTestRequirement = boolean | undefined | VerificationRequirement<NewTestWaiverReason>;

function newTestWaiverReason(requirement: NewTestRequirement): NewTestWaiverReason | null {
  if (requirement === false) return "legacy-new-tests-required-false";
  return typeof requirement === "object" && requirement.kind === "waived"
    ? requirement.reason
    : null;
}

export function analyzeNewTests(
  diff: string,
  requirement: NewTestRequirement,
): NewTestEvidence {
  const waiverReason = newTestWaiverReason(requirement);
  if (waiverReason !== null) {
    return {
      written: false,
      evidence: `verification_policy.new_tests waived: ${waiverReason}`,
    };
  }

  const tests = git.countNewTests(diff);
  const assertions = tests.total > 0 ? git.countAssertions(diff) : 0;

  if (tests.total > 0 && assertions > 0) {
    const details = [
      tests.java > 0 ? `java: ${tests.java} @Test/@Property` : "",
      tests.ts > 0 ? `ts: ${tests.ts} it/test/describe` : "",
      tests.python > 0 ? `python: ${tests.python} test functions` : "",
      tests.rust > 0 ? `rust: ${tests.rust} #[test]` : "",
    ].filter(Boolean).join("; ");
    return {
      written: true,
      evidence: `${tests.total} new test methods, ${assertions} assertions (${details})`,
    };
  }

  if (tests.total > 0 && assertions === 0) {
    return { written: false, evidence: `${tests.total} test methods but 0 assertions (empty stubs?)` };
  }

  return { written: false, evidence: "" };
}

// --- Git diff collection ---

/**
 * Injectable I/O seam for collectDiff — tests substitute plain object
 * literals (no module mocking, which bun's vitest shim does not support).
 */
export type FilePresenceResult =
  | Readonly<{ ok: true; exists: boolean }>
  | Readonly<{ ok: false; error: string }>;

export interface DiffDeps {
  readonly isTracked: (file: string) => git.GitTrackedResult;
  readonly diffFiles: (files: string[]) => git.GitDiffResult;
  readonly diffFilesStaged: (files: string[]) => git.GitDiffResult;
  readonly diffFilesSince: (revision: string, files: string[]) => git.GitDiffResult;
  readonly diffUntracked: (file: string) => git.GitDiffResult;
  readonly inspectFilePresence: (path: string) => FilePresenceResult;
}

function inspectFilePresence(path: string): FilePresenceResult {
  try {
    lstatSync(path);
    return { ok: true, exists: true };
  } catch (error) {
    const code = error instanceof Error && "code" in error ? error.code : undefined;
    return code === "ENOENT"
      ? { ok: true, exists: false }
      : { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

const REAL_DIFF_DEPS: DiffDeps = {
  isTracked: git.isTracked,
  diffFiles: git.diffFiles,
  diffFilesStaged: git.diffFilesStaged,
  diffFilesSince: git.diffFilesSince,
  diffUntracked: git.diffUntracked,
  inspectFilePresence,
};

export function collectDiff(
  filesModified: readonly string[],
  deps: DiffDeps = REAL_DIFF_DEPS,
  startSha?: string,
): string {
  // New-test proof is task-scoped evidence. A branch-wide fallback or a scan of
  // every untracked test lets a sibling task's test satisfy this task. Missing
  // attribution therefore fails closed instead of broadening the evidence set.
  if (filesModified.length === 0) return "";

  const classified = filesModified.map((file) => ({ file, result: deps.isTracked(file) }));
  const failed = classified.find(({ result }) => !result.ok);
  if (failed !== undefined && !failed.result.ok) {
    throw new Error(`new-test diff authority unavailable: ${failed.result.error}`);
  }
  const tracked = classified.flatMap(({ file, result }) => result.ok && result.tracked ? [file] : []);
  const inspectedUntracked = classified.flatMap(({ file, result }) =>
    result.ok && !result.tracked ? [{ file, presence: deps.inspectFilePresence(file) }] : []);
  const inaccessible = inspectedUntracked.find(({ presence }) => !presence.ok);
  if (inaccessible !== undefined && !inaccessible.presence.ok) {
    throw new Error(`new-test diff authority unavailable: cannot inspect ${inaccessible.file}: ${inaccessible.presence.error}`);
  }
  const untracked = inspectedUntracked.flatMap(({ file, presence }) =>
    presence.ok && presence.exists ? [file] : []);
  const diffs = [
    startSha === undefined ? { ok: true as const, diff: "" } : deps.diffFilesSince(startSha, tracked),
    deps.diffFiles(tracked),
    deps.diffFilesStaged(tracked),
    ...untracked.map((file) => deps.diffUntracked(file)),
  ];
  const unavailable = diffs.find((result) => !result.ok);
  if (unavailable !== undefined && !unavailable.ok) {
    throw new Error(`new-test diff authority unavailable: ${unavailable.error}`);
  }
  return diffs.flatMap((result) => result.ok ? [result.diff] : []).join("\n");
}

/** Shared shell operation for both Claude and Pi completion paths. Keeping
 * worktree, index, committed, and untracked-test collection here prevents one
 * harness from proving fewer test changes than the other. */
export function collectNewTestEvidence(
  filesModified: readonly string[],
  requirement: NewTestRequirement,
  startSha?: string,
  deps: DiffDeps = REAL_DIFF_DEPS,
): NewTestEvidence {
  if (newTestWaiverReason(requirement) !== null) return analyzeNewTests("", requirement);
  return analyzeNewTests(collectDiff(filesModified, deps, startSha), requirement);
}

/**
 * The dispatcher's pre-unbind ledger snapshot, as a discriminated union so
 * a FAILED read is never confused with a genuinely empty ledger:
 * - "snapshot"        — the ledger was read; `events` may legitimately be []
 * - "snapshot-failed" — the read THREW; ledger contents are unknown, so the
 *                       verdict is labeled snapshot-read-failed instead of
 *                       minting a misleading "degraded"
 * dispatch.ts builds it; this module consumes it — keep both in sync.
 */
export type EvidenceSnapshot =
  | { readonly kind: "snapshot"; readonly events: readonly EvidenceRecord[] }
  | { readonly kind: "snapshot-failed" };

/**
 * Handler core. `evidenceSnapshot` lets the dispatcher pass ledger records
 * captured BEFORE cleanup unbound the machine: attribution runs through the
 * live binding, so once cleanup has unbound it this epoch's own records can no
 * longer be told apart from a sibling's by reading the file here. (The bind
 * itself no longer truncates — see `bindMachineAgent` in machine/ledger.ts,
 * which documents why that was removed.) Standalone invocation (no snapshot)
 * reads the ledger directly.
 */
export const runUpdateTaskStatus = async (
  stdin: string,
  _args: string[],
  evidenceSnapshot?: EvidenceSnapshot,
): Promise<HookResult> => {
  // Guard the standalone CLI route: dispatch parses stdin before calling
  // handlers, but this handler is also registered directly (KNOWN_HANDLERS),
  // where a bare JSON.parse throw would surface as an uncontextualized
  // "Hook error" (mirrors cleanup-subagent-flag).
  let input: SubagentStopInput;
  try {
    input = JSON.parse(stdin);
  } catch (e) {
    return {
      kind: "error",
      message: `update-task-status: malformed SubagentStop input — task status and test evidence NOT updated: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
  // Claude Code does not send agent_type; fall back to the metadata the
  // harness writes beside the transcript. This handler is also registered
  // standalone (KNOWN_HANDLERS), so it cannot assume the dispatcher already
  // resolved it.
  const agentType = stripNamespace(resolveAgentType(input));

  // Skip non-impl agents
  if (!IMPL_AGENTS.has(agentType)) return { kind: "passthrough" };

  const mgr = StateManager.fromSession(input.session_id);
  if (!mgr) return { kind: "passthrough" };

  // Parse transcript (read file content, then parse). The path is RESOLVED,
  // not read off the payload: a supplied `agent_transcript_path` wins, and a
  // harness that sends none falls back to the derived on-disk location. This
  // handler is the only writer of task status, so an unlocatable transcript
  // costs the whole record — see utils/agent-transcript-path.
  const transcriptPath = resolveAgentTranscriptPath(input);
  let transcriptContent = "";
  if (transcriptPath) {
    try {
      transcriptContent = readFileSync(transcriptPath, "utf-8");
    } catch (e) {
      // The path existed a moment ago (the resolver proved it), so this is a
      // permission or I/O fault, not a miss. Say so and fall through to the
      // executing_tasks inference rather than throwing out of the hook.
      process.stderr.write(
        `[loom] update-task-status: cannot read transcript at ${transcriptPath}: ${e instanceof Error ? e.message : String(e)}\n`,
      );
    }
  }
  const transcript = parseTranscript(transcriptContent);
  const rawFilesModified = parseFilesModified(transcriptContent);
  const bashTestOutput = parseBashTestOutput(transcriptContent);

  // Extract task ID
  let taskId = extractTaskId(transcript);

  // When transcript parse fails, try to infer task ID from executing_tasks.
  // If exactly one task is executing, it's unambiguous.
  if (!taskId) {
    const state = mgr.load();
    const executing = state.executing_tasks ?? [];
    if (executing.length === 1) {
      process.stderr.write(`WARNING: ${agentType} transcript parse failed, inferred task ${executing[0]} from executing_tasks\n`);
      taskId = executing[0];
      // Fall through with inferred taskId
    } else {
      // Ambiguous or empty — just clear executing_tasks, don't mark tasks as failed.
      // Marking all executing tasks as "failed" causes a cascade where subsequent hooks
      // bypass the guard and overwrite valid test evidence.
      //
      // Both arms MUST speak. The empty arm used to return here in total
      // silence, which is how a harness that recorded no `executing_tasks` and
      // sent no transcript path looked exactly like a run with nothing to do:
      // every task stayed `pending`, no test_result was ever written, and
      // nothing on stderr said why. An unrecorded task is a wave gate reading
      // green on no evidence — it has to be loud.
      if (executing.length > 0) {
        process.stderr.write(`WARNING: ${agentType} completed without task ID, ${executing.length} tasks executing (ambiguous)\n`);
      } else {
        process.stderr.write(
          `WARNING: ${agentType} completed but task status was NOT recorded — no task ID in the transcript ` +
            `(${transcriptPath ? `read ${transcriptPath}` : "no transcript found: the payload named none and none was derivable from session/agent id"}) ` +
            `and executing_tasks is empty, so there is nothing to attribute the run to\n`,
        );
      }
      await mgr.update((s) => ({
        ...s,
        executing_tasks: [],
      }));
      return { kind: "passthrough" };
    }
  }

  const state = mgr.load();
  const task = state.tasks.find((t) => t.id === taskId);
  if (!task) {
    return {
      kind: "error",
      message:
        `update-task-status: transcript named unknown task ${taskId}; ` +
        `known tasks: ${state.tasks.map((candidate) => candidate.id).join(", ") || "<none>"}. ` +
        "Implementation evidence was NOT stored.",
    };
  }

  let filesModified: string[];
  try {
    filesModified = [...canonicalRepositoryPaths(
      git.repositoryRoot() ?? process.cwd(),
      rawFilesModified,
      "transcript files_modified",
    )];
  } catch (error) {
    // An agent that edited outside the repository cannot satisfy task proof.
    // Clear its live marker, leave the task pending, and fail loudly rather
    // than persisting a path later consumers might read.
    await mgr.update((s) => ({
      ...s,
      executing_tasks: (s.executing_tasks ?? []).filter((id) => id !== taskId),
    }));
    return {
      kind: "error",
      message: `update-task-status: unsafe modified-file evidence for ${taskId}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  // Pre-refactor graphs carried `tests_passed` on the task (replaced by
  // `test_result`, no compat read — unshipped branch). Explain the
  // otherwise-mystifying "missing evidence" once, where we touch the task.
  const legacyNote = legacyTestsPassedNote(task);
  if (legacyNote) process.stderr.write(`[loom] ${legacyNote}\n`);

  // Section 1: Test evidence — the agent's OWN epoch in the ledger first
  // (execution-time ground truth, attribution via agent_id), transcript
  // regex as explicit labeled fallback. Foreign epochs are never consulted.
  // Identity is PARSED before epoch construction AND before loadMachine: a
  // reserved or path-unsafe character in the hook input could never have been
  // bound/recorded (the bind boundary rejects it) and must never name a machine
  // file. The two parses are independent, so the consequences are too: an
  // unparseable `agent_id` yields no epoch events, and an unparseable
  // `agentType` yields no machine. Either way the lookup is never mis-keyed —
  // the missing half routes to the existing fallback path instead.
  const epochAgentId = input.agent_id ? parseAgentId(input.agent_id) : null;
  const epochAgentType = parseAgentType(agentType);
  // machinesDir() is resolved at call time (not the import-frozen constant)
  // so a re-pointed LOOM_MACHINES_DIR is honored without a module reload —
  // the same dir the gate and recorder consult.
  const loadedMachine: LoadedMachine =
    epochAgentType !== null ? loadMachine(machinesDir(), epochAgentType) : { kind: "none" };
  const machineBound = isMachineBound(loadedMachine);
  // A failed dispatcher snapshot means ledger contents are UNKNOWN — say so
  // and let resolveTestEvidence label the verdict snapshot-read-failed
  // instead of pretending the ledger was empty ("degraded").
  const snapshotFailed = evidenceSnapshot?.kind === "snapshot-failed";
  if (snapshotFailed) {
    process.stderr.write(
      `update-task-status: evidence snapshot for ${input.session_id} failed — ledger unavailable; verdict will be labeled snapshot-read-failed\n`,
    );
  }
  // Standalone route (no dispatcher snapshot): read the ledger directly, but
  // parse the session id at this boundary first — an unparseable id names no
  // ledger file, so it resolves to no evidence rather than throwing.
  const standaloneSessionId =
    evidenceSnapshot === undefined && input.session_id ? parseSessionId(input.session_id) : null;
  // A PRESENT-but-unparseable session id yields no records here, which is
  // indistinguishable from a genuinely empty ledger downstream — the verdict
  // would be mislabeled "degraded"/"fallback" instead of reflecting that the
  // ledger was never read. Say so once, mirroring dispatch.ts.
  if (evidenceSnapshot === undefined && input.session_id && standaloneSessionId === null) {
    process.stderr.write(
      `update-task-status: invalid session id ${input.session_id} — ledger not read; verdict may be mislabeled\n`,
    );
  }
  let records: readonly EvidenceRecord[] = [];
  if (evidenceSnapshot === undefined) {
    records = standaloneSessionId === null ? [] : readEvidence(standaloneSessionId);
  } else if (evidenceSnapshot.kind === "snapshot") {
    records = evidenceSnapshot.events;
  }
  const epochEvents = epochAgentId && epochAgentType
    ? eventsForEpoch(records, epochOf(epochAgentId, epochAgentType))
    : [];
  let testEvidence = resolveTestEvidence(epochEvents, bashTestOutput, machineBound, snapshotFailed);
  // Machine-bound agents don't self-report completion: fold this epoch's
  // evidence through the machine and consult its terminal requirements —
  // unmet requirements cap a trusted-pass at untrusted, labeled with what is
  // missing. Skipped when the snapshot failed (ledger contents unknown — the
  // snapshot-read-failed label already says so) and for invalid machines
  // (nothing to fold; the gate fails closed on those independently).
  if (!snapshotFailed && loadedMachine.kind === "machine") {
    const missing = missingRequirements(
      loadedMachine.machine,
      foldEvidence(loadedMachine.machine, epochEvents),
    );
    const capped = capVerdictForMachineCompletion(testEvidence, missing);
    if (capped !== testEvidence) {
      process.stderr.write(
        `update-task-status: machine ${loadedMachine.machine.agent} reports unmet terminal requirements — capping verdict at untrusted (${capped.result.verdict === "untrusted" ? capped.result.label : ""})\n`,
      );
      testEvidence = capped;
    }
  }

  // Section 3: Atomic state write. Attempt-baseline comparison, cumulative
  // attribution, and new-test evidence are derived from the locked Task below,
  // never the stale pre-lock read; the preserve-evidence guards also run INSIDE
  // the locked update (a pre-lock read can be outdated by a concurrent
  // writer before this write lands — TOCTOU) and are TRUST-aware ON BOTH
  // SIDES: an existing trusted failure is preserved against an UNTRUSTED
  // incoming resolution, while a trusted pass is preserved only if this retry
  // changed no code. Historical green evidence cannot prove newer bytes. An
  // untrusted result — e.g. a helper-reported "pass" from agent-controlled
  // stdin — otherwise cannot preempt ground truth (mirrors
  // store-test-evidence's skippedTrustedVerdict pattern), but NEWER ground
  // truth supersedes older: a re-spawned agent's
  // fresh epoch yielding trusted-pass/trusted-fail must land, or the first
  // real red run would wedge the task forever (the gate treats trusted-fail
  // as missing evidence and store-test-evidence also refuses trusted).
  // A completed task is never reopened, at any trust level.
  let skippedExistingVerdict = false;
  let comparisonFailure: string | null = null;
  let newTestEvidenceFailure: string | null = null;
  const repositoryRoot = git.repositoryRoot() ?? process.cwd();
  await mgr.update((s) => {
    const target = s.tasks.find((t) => t.id === taskId);
    const verdict = target?.test_result?.verdict;
    const incomingTrusted = testEvidence.result.verdict !== "untrusted";
    if (!target || target.status === "completed") {
      skippedExistingVerdict = true;
      // The verdict stands down, but the agent still STOPPED: leaving the
      // task on executing_tasks would ghost-block validate-task-execution's
      // duplicate-spawn check for the rest of the session.
      return {
        ...s,
        executing_tasks: (s.executing_tasks ?? []).filter((id) => id !== taskId),
      };
    }

    // This synchronous repository observation runs under the same StateManager
    // lock as settlement, so it is derived from this exact attempt authority.
    const comparison = compareAttemptBaseline(
      repositoryRoot,
      target,
      { kind: "repository-or-declared", extraModifiedPaths: filesModified },
    );
    if (comparison.failure !== null) {
      comparisonFailure = comparison.failure;
      return applyCompletionInfrastructureFailure(s, taskId, comparison.bytesChangedSinceAttempt);
    }
    const codeChanged = comparison.bytesChangedSinceAttempt;
    const preserveExistingTrusted = target.revalidation_required !== true && !incomingTrusted && (
      verdict === "trusted-fail" || (verdict === "trusted-pass" && !codeChanged)
    );
    const resolvedTestResult = preserveExistingTrusted ? target.test_result : testEvidence.result;
    const resolvedTestEvidence = preserveExistingTrusted ? target.test_evidence : testEvidence.evidence;
    const cumulativeFiles = cumulativeModifiedPaths(target.files_modified, filesModified);
    const proofArtifactsChanged = attributedChangedArtifacts(comparison.changedDeclaredArtifacts, cumulativeFiles);
    const verificationPolicy = taskVerificationPolicy(target);
    let currentNewTestEvidence: NewTestEvidence;
    try {
      currentNewTestEvidence = collectNewTestEvidence(
        cumulativeFiles,
        verificationPolicy.newTests,
        target.start_sha,
      );
    } catch (error) {
      const cause = error instanceof Error ? error.message : String(error);
      newTestEvidenceFailure = `update-task-status: cannot collect new-test evidence for ${taskId}: ${cause}`;
      return applyCompletionInfrastructureFailure(s, taskId, codeChanged);
    }
    const proof = evaluateTaskProof(
      {
        verificationPolicy,
        declaredArtifacts: target.file_list ?? [],
      },
      {
        taskCompleted: true,
        testResult: resolvedTestResult,
        filesModified: proofArtifactsChanged,
        newTestsWritten: currentNewTestEvidence.written,
        newTestEvidence: currentNewTestEvidence.evidence,
      },
      TRUSTED_LEDGER_ONLY_POLICY,
    );
    return applyResolvedTask(
      s,
      taskId,
      target.wave,
      codeChanged,
      (s.executing_tasks ?? []).filter((id) => id !== taskId),
      (t) => ({
        ...t,
        status: proof.state === "satisfied" ? "implemented" : "pending",
        proof,
        test_result: resolvedTestResult,
        test_evidence: resolvedTestEvidence,
        files_modified: cumulativeFiles,
        new_tests_written: currentNewTestEvidence.written,
        new_test_evidence: currentNewTestEvidence.evidence,
        ...(testResultPassed(testEvidence.result) ? { revalidation_required: undefined } : {}),
      }),
    );
  });

  if (comparisonFailure !== null) {
    return {
      kind: "error",
      message: `update-task-status: cannot compare declared-artifact baseline for ${taskId}: ${comparisonFailure}`,
    };
  }
  if (newTestEvidenceFailure !== null) {
    return { kind: "error", message: newTestEvidenceFailure };
  }

  if (skippedExistingVerdict) {
    return passthroughDiagnostic(`update-task-status: ${taskId} is completed or missing — leaving task evidence untouched\n`);
  }

  const persistedTask = mgr.load().tasks.find((candidate) => candidate.id === taskId);
  if (persistedTask?.proof?.state === "satisfied") {
    process.stderr.write(`Task ${taskId} implemented with all proof obligations satisfied.\n`);
  } else {
    const failures = persistedTask?.proof?.state === "failed"
      ? persistedTask.proof.failures.map((failure) => failure.kind).join(", ")
      : "proof unavailable";
    process.stderr.write(`Task ${taskId} remains pending — proof obligations failed: ${failures}.\n`);
  }

  // The same locked update that landed the resolution reconciled the wave's
  // implementation bit in both directions. Report completion from that state.
  const updated = mgr.load();
  const currentWave = updated.current_wave ?? 1;
  if (isWaveComplete(updated, currentWave)) {
    process.stderr.write(`\nWave ${currentWave} implementation complete. Run: /wave-gate\n`);
  }

  return { kind: "passthrough" };
};

const handler: HookHandler = (stdin, args) => runUpdateTaskStatus(stdin, args);

export default handler;
