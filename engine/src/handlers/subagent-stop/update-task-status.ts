/**
 * Mark task "implemented" when impl agent completes.
 *
 * 1. Resolve test evidence — the agent's own epoch in the evidence ledger
 *    (execution-time ground truth) first; transcript regex as the labeled,
 *    lower-trust fallback
 * 2. Verify new tests written via git diff + assertion density
 * 3. Atomic state write: files_modified, test_result, new_tests_written
 * 4. Detect wave completion → signal /wave-gate
 */

import { existsSync, readFileSync } from "node:fs";
import type { HookHandler, HookResult, SubagentStopInput, TaskGraph, TaskTestResult } from "../../types";
import { legacyTestsPassedNote, newWaveGate } from "../../types";
import { IMPL_AGENTS, machinesDir } from "../../config";
import { StateManager } from "../../state-manager";
import { stripNamespace } from "../../utils/strip-namespace";
import { extractTaskId } from "../../utils/extract-task-id";
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

/**
 * Is the agent's machine BOUND for evidence purposes? "invalid" counts as
 * bound: a machine definition exists for this agent — ground truth was
 * expected — so an empty ledger must surface as "degraded", not be
 * mislabeled as an unbound/legacy "fallback" run.
 */
export function isMachineBound(loaded: LoadedMachine): boolean {
  return loaded.kind !== "none";
}

// --- Pure: extract test pass evidence from bash output ---

interface TestEvidence {
  passed: boolean;
  evidence: string;
}

// Helper to get last regex match with its position (handles multiple test runs in concatenated output)
interface MatchWithIndex extends RegExpMatchArray {
  index: number;
}

function lastMatch(str: string, regex: RegExp): MatchWithIndex | null {
  const flags = regex.flags.includes("g") ? regex.flags : regex.flags + "g";
  const matches = [...str.matchAll(new RegExp(regex.source, flags))];
  if (matches.length === 0) return null;
  const last = matches[matches.length - 1];
  return last as MatchWithIndex;
}

export function extractTestEvidence(bashOutput: string): TestEvidence {
  // Java/Maven
  if (/BUILD SUCCESS/.test(bashOutput)) {
    const cleaned = bashOutput.replace(/\*\*/g, "");
    const maven = lastMatch(cleaned, /Tests run: \d+, Failures: 0, Errors: 0/);
    if (maven) return { passed: true, evidence: `maven: ${maven[0]}` };
  }

  // Node/Mocha: "N passing" without "N failing" (or failing comes before passing)
  const passing = lastMatch(bashOutput, /(\d+) passing/);
  if (passing) {
    const failMatch = lastMatch(bashOutput, /(\d+) failing/);
    if (!failMatch || failMatch[1] === "0" || failMatch.index < passing.index) {
      return { passed: true, evidence: `node: ${passing[0]}` };
    }
  }

  // Vitest: "Tests  N passed" or "Test Files  N passed"
  const vitest = lastMatch(bashOutput, /Tests?\s+\d+ passed/);
  if (vitest) {
    const vitestFailed = lastMatch(bashOutput, /Tests?\s+\d+ failed/);
    if (!vitestFailed || vitestFailed.index < vitest.index) {
      return { passed: true, evidence: `vitest: ${vitest[0]}` };
    }
  }

  // Rust/cargo test: "test result: ok. N passed; 0 failed"
  const cargoTest = lastMatch(bashOutput, /test result: ok\. (\d+) passed/);
  if (cargoTest) {
    const cargoFail = lastMatch(bashOutput, /test result:.*(\d+) failed/);
    if (!cargoFail || cargoFail[1] === "0" || cargoFail.index < cargoTest.index) {
      return { passed: true, evidence: `cargo: ${cargoTest[1]} passed` };
    }
  }

  // pytest: "N passed … in X.XXs" (runner summary shape) without "N failed"
  // (or failed comes before passed). Anchored to the timing suffix so prose
  // like "3 passed review" cannot mint a passing result — this path already
  // yields only untrusted evidence, but unbound/legacy agents' gates accept it.
  const pytest = lastMatch(bashOutput, /(\d+) passed\b[^\n]*\bin \d+(?:\.\d+)?s/);
  if (pytest) {
    const pyFail = lastMatch(bashOutput, /(\d+) failed/);
    if (!pyFail || pyFail[1] === "0" || pyFail.index < pytest.index) {
      return { passed: true, evidence: `pytest: ${pytest[0]}` };
    }
  }

  // Bun: "N pass" without "N fail" (or "0 fail" or fail comes before pass).
  // Line-start anchored (bun prints each counter on its own line) so
  // mid-sentence prose like "all 5 pass rates" never matches.
  const bunPass = lastMatch(bashOutput, /^\s*(\d+) pass\b/m);
  if (bunPass) {
    const bunFail = lastMatch(bashOutput, /^\s*(\d+) fail\b/m);
    if (!bunFail || bunFail[1] === "0" || bunFail.index < bunPass.index) {
      return { passed: true, evidence: `bun: ${bunPass[0]}` };
    }
  }

  return { passed: false, evidence: "" };
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
export function resolveTestEvidence(
  ledgerEvents: readonly Evidence[],
  bashOutput: string,
  machineBound: boolean,
  snapshotFailed: boolean = false,
): ResolvedTestEvidence {
  if (snapshotFailed) {
    const label = "snapshot-read-failed (ledger snapshot unreadable; transcript-regex)";
    const fromTranscript = extractTestEvidence(bashOutput);
    if (!fromTranscript.passed) {
      return { result: { verdict: "untrusted", passed: false, label }, evidence: "" };
    }
    return {
      result: { verdict: "untrusted", passed: true, label },
      evidence: `${label}: ${fromTranscript.evidence}`,
    };
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

  const label = demotionLabel
    ?? (judged.some((j) => j.run.exit === 0)
      ? "low-trust (exit 0, no report artifact; transcript-regex)"
      : machineBound && ledgerEvents.length === 0
        ? "degraded (machine bound, no ledger evidence; transcript-regex)"
        : "transcript-regex (fallback)");
  const fallback = extractTestEvidence(bashOutput);
  if (!fallback.passed) {
    return { result: { verdict: "untrusted", passed: false, label }, evidence: "" };
  }
  return {
    result: { verdict: "untrusted", passed: true, label },
    evidence: `${label}: ${fallback.evidence}`,
  };
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
    result: { verdict: "untrusted", passed: true, label },
    evidence: `${label} — ${resolved.evidence}`,
  };
}

// --- Pure: untrusted Stop-resolution TOCTOU re-check (shared with pi) ---

/** What an untrusted Stop-handler resolution wants to persist on the task. */
export interface UntrustedStopResolution {
  readonly testResult: Extract<TaskTestResult, { verdict: "untrusted" }>;
  readonly testEvidence: string;
  /** Files the agent modified (parsed from its transcript) — persisted on
   *  the task because lint-wave-gate collects its lint targets EXCLUSIVELY
   *  from `files_modified`; a resolution that omits it makes every wave-gate
   *  lint run over an empty set and report clean (round-16 pi finding). */
  readonly filesModified: readonly string[];
  readonly newTestsWritten: boolean;
  readonly newTestEvidence: string;
}

export interface AppliedStopResolution {
  readonly state: TaskGraph;
  /** true → an existing trusted verdict / completed task stood; nothing was overwritten. */
  readonly skipped: boolean;
}

/**
 * The verdict-resolution decision for an UNTRUSTED Stop-handler resolution,
 * meant to run INSIDE the locked state update (pi/extension.ts's Stop
 * handler): a pre-lock snapshot can be outdated by a concurrent writer
 * before the write lands (TOCTOU), so the target is re-found and re-checked
 * against the CURRENT state here. An untrusted resolution never overwrites
 * an existing trusted-pass/trusted-fail verdict and never reopens a
 * completed task — but the agent still STOPPED either way, so the task is
 * always removed from executing_tasks (leaving it would ghost-block
 * duplicate-spawn checks for the rest of the session).
 */
export function applyUntrustedStopResolution(
  s: TaskGraph,
  taskId: string,
  resolution: UntrustedStopResolution,
): AppliedStopResolution {
  const clearedExecuting = (s.executing_tasks ?? []).filter((id) => id !== taskId);
  const target = s.tasks.find((t) => t.id === taskId);
  const verdict = target?.test_result?.verdict;
  const existingTrusted = verdict === "trusted-pass" || verdict === "trusted-fail";
  if (!target || target.status === "completed" || existingTrusted) {
    return { state: { ...s, executing_tasks: clearedExecuting }, skipped: true };
  }
  return {
    skipped: false,
    state: {
      ...s,
      tasks: s.tasks.map((t) =>
        t.id === taskId
          ? {
              ...t,
              status: "implemented" as const,
              test_result: resolution.testResult,
              test_evidence: resolution.testEvidence,
              files_modified: [...resolution.filesModified],
              new_tests_written: resolution.newTestsWritten,
              new_test_evidence: resolution.newTestEvidence,
            }
          : t,
      ),
      executing_tasks: clearedExecuting,
    },
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
  return !state.tasks
    .filter((t) => t.wave === wave)
    .some((t) => t.status !== "implemented" && t.status !== "completed");
}

// --- Pure: determine new test evidence from diff ---

interface NewTestEvidence {
  written: boolean;
  evidence: string;
}

export function analyzeNewTests(
  diff: string,
  newTestsRequired: boolean | undefined,
): NewTestEvidence {
  if (newTestsRequired === false) {
    return { written: false, evidence: "new_tests_required=false (skipped)" };
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
export interface DiffDeps {
  readonly isTracked: (file: string) => boolean;
  readonly diffFiles: (files: string[]) => string;
  readonly diffFilesStaged: (files: string[]) => string;
  readonly diffUntracked: (file: string) => string;
  readonly listUntrackedTestFiles: () => string[];
  readonly diff: (from?: string, to?: string) => string;
  readonly diffStaged: () => string;
  readonly defaultBranch: () => string;
  readonly mergeBase: (branch: string) => string | null;
  readonly fileExists: (path: string) => boolean;
}

const REAL_DIFF_DEPS: DiffDeps = {
  isTracked: git.isTracked,
  diffFiles: git.diffFiles,
  diffFilesStaged: git.diffFilesStaged,
  diffUntracked: git.diffUntracked,
  listUntrackedTestFiles: git.listUntrackedTestFiles,
  diff: git.diff,
  diffStaged: git.diffStaged,
  defaultBranch: git.defaultBranch,
  mergeBase: git.mergeBase,
  fileExists: existsSync,
};

export function collectDiff(
  filesModified: string[],
  startSha: string | undefined,
  deps: DiffDeps = REAL_DIFF_DEPS,
): string {
  if (filesModified.length > 0) {
    const tracked = filesModified.filter((f) => deps.isTracked(f));
    const untracked = filesModified.filter((f) => deps.fileExists(f) && !deps.isTracked(f));

    const parts = [
      deps.diffFiles(tracked),
      deps.diffFilesStaged(tracked),
      ...untracked.map((f) => deps.diffUntracked(f)),
    ];

    // Also include untracked test files NOT already in filesModified.
    // parseFilesModified often misses test files due to transcript parsing gaps
    // (e.g. tool name casing, truncated transcripts, partial captures).
    const alreadyIncluded = new Set(filesModified);
    const untrackedTests = deps.listUntrackedTestFiles();
    for (const f of untrackedTests) {
      if (!alreadyIncluded.has(f)) {
        parts.push(deps.diffUntracked(f));
      }
    }

    const combined = parts.join("\n");
    if (combined.trim()) return combined;
  }

  // Fallback: SHA-based or branch-based diff + untracked test files
  const parts: string[] = [];

  if (startSha) {
    parts.push(deps.diff(startSha, "HEAD"), deps.diff(), deps.diffStaged());
  } else {
    const branch = deps.defaultBranch();
    const base = deps.mergeBase(branch);
    parts.push(base ? deps.diff(base, "HEAD") : deps.diff("HEAD~1", "HEAD"));
    parts.push(deps.diff(), deps.diffStaged());
  }

  // Also include untracked test files (common when agent creates new test files
  // without committing — e.g. pi subagents working on unstaged branches)
  const untrackedTests = deps.listUntrackedTestFiles();
  for (const f of untrackedTests) {
    parts.push(deps.diffUntracked(f));
  }

  return parts.join("\n");
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
 * captured BEFORE cleanup unbound the machine — a subsequent bind truncates
 * the ledger, so reading the file here can race a fresh run's truncation.
 * Standalone invocation (no snapshot) reads the ledger directly.
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
  const agentType = stripNamespace(input.agent_type ?? "");

  // Skip non-impl agents
  if (!IMPL_AGENTS.has(agentType)) return { kind: "passthrough" };

  const mgr = StateManager.fromSession(input.session_id);
  if (!mgr) return { kind: "passthrough" };

  // Parse transcript (read file content, then parse)
  // Expand ~ in transcript path (Claude Code may send tilde-prefixed paths)
  const transcriptPath = input.agent_transcript_path?.replace(/^~/, process.env.HOME ?? "~") ?? "";
  const transcriptContent = transcriptPath && existsSync(transcriptPath)
    ? readFileSync(transcriptPath, "utf-8")
    : "";
  const transcript = parseTranscript(transcriptContent);
  const filesModified = parseFilesModified(transcriptContent);
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
      if (executing.length > 0) {
        process.stderr.write(`WARNING: ${agentType} completed without task ID, ${executing.length} tasks executing (ambiguous)\n`);
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
  if (!task) return { kind: "passthrough" };

  // Pre-refactor graphs carried `tests_passed` on the task (replaced by
  // `test_result`, no compat read — unshipped branch). Explain the
  // otherwise-mystifying "missing evidence" once, where we touch the task.
  const legacyNote = legacyTestsPassedNote(task);
  if (legacyNote) process.stderr.write(`[loom] ${legacyNote}\n`);

  // Section 1: Test evidence — the agent's OWN epoch in the ledger first
  // (execution-time ground truth, attribution via agent_id), transcript
  // regex as explicit labeled fallback. Foreign epochs are never consulted.
  // Identity is PARSED before epoch construction AND before loadMachine: a
  // reserved or path-unsafe character in the hook input could never have
  // been bound/recorded (the bind boundary rejects it) and must never name
  // a machine file, so it yields no epoch events, no machine, and routes to
  // the existing fallback path instead of silently mis-keying the lookup.
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
  const records: readonly EvidenceRecord[] =
    evidenceSnapshot === undefined
      ? standaloneSessionId
        ? readEvidence(standaloneSessionId)
        : []
      : evidenceSnapshot.kind === "snapshot"
        ? evidenceSnapshot.events
        : [];
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

  // Section 2: New test verification via git diff
  let newTestEvidence: NewTestEvidence = { written: false, evidence: "" };
  if (git.isGitRepo()) {
    const fullDiff = collectDiff(filesModified, task.start_sha);
    newTestEvidence = analyzeNewTests(fullDiff, task.new_tests_required);
  }

  // Section 3: Atomic state write. The preserve-evidence guards run INSIDE
  // the locked update (a pre-lock read can be outdated by a concurrent
  // writer before this write lands — TOCTOU) and are TRUST-aware ON BOTH
  // SIDES: an existing ledger-trusted verdict is preserved only against an
  // UNTRUSTED incoming resolution. An untrusted result — e.g. a
  // helper-reported "pass" from agent-controlled stdin — must never preempt
  // ground truth (mirrors store-test-evidence's skippedTrustedVerdict
  // pattern), but NEWER ground truth supersedes older: a re-spawned agent's
  // fresh epoch yielding trusted-pass/trusted-fail must land, or the first
  // real red run would wedge the task forever (the gate treats trusted-fail
  // as missing evidence and store-test-evidence also refuses trusted).
  // A completed task is never reopened, at any trust level.
  let skippedExistingVerdict = false;
  await mgr.update((s) => {
    const target = s.tasks.find((t) => t.id === taskId);
    const verdict = target?.test_result?.verdict;
    const existingTrusted = verdict === "trusted-pass" || verdict === "trusted-fail";
    const incomingTrusted = testEvidence.result.verdict !== "untrusted";
    if (
      !target ||
      target.status === "completed" ||
      (existingTrusted && !incomingTrusted)
    ) {
      skippedExistingVerdict = true;
      // The verdict stands down, but the agent still STOPPED: leaving the
      // task on executing_tasks would ghost-block validate-task-execution's
      // duplicate-spawn check for the rest of the session.
      return {
        ...s,
        executing_tasks: (s.executing_tasks ?? []).filter((id) => id !== taskId),
      };
    }

    const updatedTasks = s.tasks.map((t) =>
      t.id === taskId
        ? {
            ...t,
            status: "implemented" as const,
            test_result: testEvidence.result,
            test_evidence: testEvidence.evidence,
            files_modified: filesModified,
            new_tests_written: newTestEvidence.written,
            new_test_evidence: newTestEvidence.evidence,
          }
        : t
    );

    return {
      ...s,
      tasks: updatedTasks,
      executing_tasks: (s.executing_tasks ?? []).filter((id) => id !== taskId),
    };
  });

  if (skippedExistingVerdict) {
    process.stderr.write(
      `update-task-status: ${taskId} is completed or carries a trusted verdict this untrusted resolution cannot supersede — leaving it untouched\n`,
    );
    return { kind: "passthrough" };
  }

  process.stderr.write(`Task ${taskId} implemented.\n`);

  // Check wave completion (shared pure predicate — pi's Stop mirror uses
  // the same one, inside its locked update)
  const updated = mgr.load();
  const currentWave = updated.current_wave ?? 1;

  if (isWaveComplete(updated, currentWave)) {
    await mgr.update((s) => ({
      ...s,
      wave_gates: {
        ...s.wave_gates,
        [String(currentWave)]: {
          ...(s.wave_gates[String(currentWave)] ?? newWaveGate()),
          impl_complete: true,
        },
      },
    }));
    process.stderr.write(`\nWave ${currentWave} implementation complete. Run: /wave-gate\n`);
  }

  return { kind: "passthrough" };
};

const handler: HookHandler = (stdin, args) => runUpdateTaskStatus(stdin, args);

export default handler;
