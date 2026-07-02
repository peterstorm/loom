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
import type { HookHandler, HookResult, SubagentStopInput, TaskTestResult } from "../../types";
import { legacyTestsPassedNote, testResultPassed } from "../../types";
import { IMPL_AGENTS } from "../../config";
import { StateManager } from "../../state-manager";
import { stripNamespace } from "../../utils/strip-namespace";
import { extractTaskId } from "../../utils/extract-task-id";
import { parseTranscript } from "../../parsers/parse-transcript";
import { parseFilesModified } from "../../parsers/parse-files-modified";
import { parseBashTestOutput } from "../../parsers/parse-bash-test-output";
import * as git from "../../utils/git";
import { MACHINES_DIR } from "../../config";
import {
  epochOf,
  eventsForEpoch,
  judgeTestRun,
  loadMachine,
  parseAgentId,
  parseAgentType,
  readEvidence,
} from "../../machine";
import type { Evidence, EvidenceRecord, TrustedTestVerdict } from "../../machine";

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
  const matches = [...str.matchAll(new RegExp(regex.source, 'g'))];
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

  // pytest: "N passed" without "N failed" (or failed comes before passed)
  const pytest = lastMatch(bashOutput, /(\d+) passed/);
  if (pytest) {
    const pyFail = lastMatch(bashOutput, /(\d+) failed/);
    if (!pyFail || pyFail[1] === "0" || pyFail.index < pytest.index) {
      return { passed: true, evidence: `pytest: ${pytest[0]}` };
    }
  }

  // Bun: "N pass" without "N fail" (or "0 fail" or fail comes before pass)
  const bunPass = lastMatch(bashOutput, /(\d+) pass\b/);
  if (bunPass) {
    const bunFail = lastMatch(bashOutput, /(\d+) fail\b/);
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
 *                  be trusted (no report artifact for the deciding run)
 * - "degraded"   — the machine was bound but the ledger is empty (recorder
 *                  failure: the fallback is running where ground truth was
 *                  expected)
 * - "fallback"   — no ledger coverage at all (unbound/legacy runs)
 */
export function resolveTestEvidence(
  ledgerEvents: readonly Evidence[],
  bashOutput: string,
  machineBound: boolean,
): ResolvedTestEvidence {
  const runs = ledgerEvents.filter((e): e is TestRunEvidence => e.kind === "TestRun");
  const judged = runs.map((r) => ({ run: r, verdict: judgeTestRun(r.exit, r.report) }));

  // Last GROUND-TRUTH run (trusted-pass or trusted-fail), with its index.
  const lastTrusted = judged.reduce<
    { index: number; run: TestRunEvidence; verdict: TrustedTestVerdict } | null
  >((acc, { run, verdict }, index) => {
    return verdict.verdict === "untrusted" ? acc : { index, run, verdict };
  }, null);

  if (lastTrusted !== null) {
    // A stale trusted failure must not outrank a later untrusted exit-0
    // run — but that later run earns only the low-trust fallback below,
    // never a trusted pass.
    const laterExitZero = judged.slice(lastTrusted.index + 1).some((j) => j.run.exit === 0);
    if (lastTrusted.verdict.verdict === "trusted-pass" || !laterExitZero) {
      const report = lastTrusted.run.report
        ? `, report: ${lastTrusted.run.report.total} tests / ${lastTrusted.run.report.failed} failed`
        : "";
      return {
        result: lastTrusted.verdict,
        evidence: `ledger: exit ${lastTrusted.run.exit}${report} (${lastTrusted.run.command})`,
      };
    }
  }

  const label = judged.some((j) => j.run.exit === 0)
    ? "low-trust (exit 0, no report artifact; transcript-regex)"
    : machineBound && ledgerEvents.length === 0
      ? "degraded (machine bound, no ledger evidence; transcript-regex)"
      : "transcript-regex (fallback)";
  const fallback = extractTestEvidence(bashOutput);
  if (!fallback.passed) {
    return { result: { verdict: "untrusted", passed: false, label }, evidence: "" };
  }
  return {
    result: { verdict: "untrusted", passed: true, label },
    evidence: `${label}: ${fallback.evidence}`,
  };
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
 * Handler core. `evidenceSnapshot` lets the dispatcher pass ledger records
 * captured BEFORE cleanup unbound the machine — a subsequent bind truncates
 * the ledger, so reading the file here can race a fresh run's truncation.
 * Standalone invocation (no snapshot) reads the ledger directly.
 */
export const runUpdateTaskStatus = async (
  stdin: string,
  _args: string[],
  evidenceSnapshot?: readonly EvidenceRecord[],
): Promise<HookResult> => {
  const input: SubagentStopInput = JSON.parse(stdin);
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

  // Skip if already completed or has valid test evidence (regardless of status).
  // Guards against crash-detection cascade: if another agent's hook set status="failed"
  // via crash detection, we still preserve previously-set test evidence.
  if (task.status === "completed") return { kind: "passthrough" };
  if (testResultPassed(task.test_result)) return { kind: "passthrough" };

  // Section 1: Test evidence — the agent's OWN epoch in the ledger first
  // (execution-time ground truth, attribution via agent_id), transcript
  // regex as explicit labeled fallback. Foreign epochs are never consulted.
  // Identity is PARSED before epoch construction: a reserved character in
  // the hook input could never have been bound/recorded (the bind boundary
  // rejects it), so it yields no epoch events and routes to the existing
  // degraded/fallback path instead of silently mis-keying the lookup.
  const machineBound = loadMachine(MACHINES_DIR, agentType).kind === "machine";
  const records = evidenceSnapshot ?? readEvidence(input.session_id);
  const epochAgentId = input.agent_id ? parseAgentId(input.agent_id) : null;
  const epochAgentType = parseAgentType(agentType);
  const epochEvents = epochAgentId && epochAgentType
    ? eventsForEpoch(records, epochOf(epochAgentId, epochAgentType))
    : [];
  const testEvidence = resolveTestEvidence(epochEvents, bashTestOutput, machineBound);

  // Section 2: New test verification via git diff
  let newTestEvidence: NewTestEvidence = { written: false, evidence: "" };
  if (git.isGitRepo()) {
    const fullDiff = collectDiff(filesModified, task.start_sha);
    newTestEvidence = analyzeNewTests(fullDiff, task.new_tests_required);
  }

  // Section 3: Atomic state write
  await mgr.update((s) => {
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

  process.stderr.write(`Task ${taskId} implemented.\n`);

  // Check wave completion
  const updated = mgr.load();
  const currentWave = updated.current_wave ?? 1;
  const waveIncomplete = updated.tasks
    .filter((t) => t.wave === currentWave)
    .some((t) => t.status !== "implemented" && t.status !== "completed");

  if (!waveIncomplete) {
    await mgr.update((s) => ({
      ...s,
      wave_gates: {
        ...s.wave_gates,
        [String(currentWave)]: {
          ...(s.wave_gates[String(currentWave)] ?? { impl_complete: false, tests_passed: null, reviews_complete: false, blocked: false }),
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
