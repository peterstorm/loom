/**
 * Complete wave gate after reviews pass.
 * Verifies: test evidence, new tests, reviews, spec alignment, no critical findings.
 * Then marks wave tasks completed, updates GitHub issue checkboxes, advances wave.
 *
 * Usage: bun cli.ts helper complete-wave-gate [--wave N]
 */

import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import type { HookHandler, TaskGraph, Task, WaveGate } from "../../types";
import { legacyTestsPassedNote, testResultPassed } from "../../types";
import { taskGraphPath } from "../../config";
import { StateManager } from "../../state-manager";
import { parsePlanModels, type PlanModels } from "../../parsers/parse-plan-models";
import { pathsMatch } from "./validate-model-bindings";

/** Resolve the plan's executable models from state — effectful shell helper */
export function loadPlanModelsSource(planFile: string | null | undefined): PlanModelsSource {
  if (typeof planFile !== "string" || planFile.trim().length === 0) return { kind: "none" };
  try {
    return { kind: "loaded", models: parsePlanModels(readFileSync(planFile, "utf-8")) };
  } catch (e) {
    // Carry the cause: ENOENT (typo'd path) and EACCES (permissions) demand
    // different operator responses — a bare "unreadable" hides which.
    return { kind: "unreadable", path: planFile, error: e instanceof Error ? e.message : String(e) };
  }
}

function parseWaveArg(args: string[]): number | null {
  const idx = args.indexOf("--wave");
  if (idx >= 0 && args[idx + 1]) return Number(args[idx + 1]);
  return null;
}

export type GateCheck =
  | { passed: true;  summary: string }
  | { passed: false; reason: string };

const pass = (summary: string): GateCheck => ({ passed: true, summary });
const fail = (reason: string): GateCheck => ({ passed: false, reason });

/** Render a check for stderr output. */
export function gateCheckMessage(c: GateCheck): string {
  return c.passed ? c.summary : c.reason;
}

/** Check 1: All tasks have test evidence (skipped for tasks declaring no tests required) */
export function checkTestEvidence(tasks: Task[]): GateCheck {
  const missing = tasks.filter((t) => t.new_tests_required !== false && !testResultPassed(t.test_result));
  if (missing.length > 0) {
    return fail(`FAILED: Not all tasks have test evidence.\n  Missing: ${missing.map((t) => t.id).join(", ")}`);
  }
  const lines = tasks.map((t) => {
    const evidence = t.new_tests_required === false
      ? "not required"
      : (t.test_evidence ?? "evidence present");
    return `     ${t.id}: ${evidence}`;
  });
  return pass(`1. Test evidence verified (${tasks.length}/${tasks.length} tasks):\n${lines.join("\n")}`);
}

/** Check 2: New tests written or not required */
export function checkNewTests(tasks: Task[]): GateCheck {
  const missing = tasks.filter((t) => t.new_tests_required !== false && !t.new_tests_written);
  if (missing.length > 0) {
    return fail(`FAILED: Not all tasks satisfied new-test requirement.\n  Missing: ${missing.map((t) => t.id).join(", ")}`);
  }
  const lines = tasks.map((t) => {
    const evidence = t.new_test_evidence ?? (t.new_tests_required === false ? "not required" : "new tests present");
    return `     ${t.id}: ${evidence}`;
  });
  return pass(`2. New tests verified (${tasks.length}/${tasks.length} tasks):\n${lines.join("\n")}`);
}

/** Check 3: All tasks reviewed */
export function checkReviews(tasks: Task[]): GateCheck {
  const reviewed = tasks.filter((t) => t.review_status === "passed" || t.review_status === "blocked");
  if (reviewed.length !== tasks.length) {
    const unreviewed = tasks.filter((t) => !t.review_status || t.review_status === "pending").map((t) => t.id);
    const failedReview = tasks.filter((t) => t.review_status === "evidence_capture_failed").map((t) => t.id);
    const parts = ["FAILED: Not all tasks have been reviewed."];
    if (failedReview.length > 0) parts.push(`  Evidence capture failed: ${failedReview.join(", ")}`);
    if (unreviewed.length > 0) parts.push(`  Unreviewed: ${unreviewed.join(", ")}`);
    return fail(parts.join("\n"));
  }
  const lines = tasks.map((t) => `     ${t.id}: ${t.review_status}`);
  return pass(`3. Reviews verified (${tasks.length}/${tasks.length} tasks):\n${lines.join("\n")}`);
}

/** Check 4: Spec alignment */
export function checkSpecAlignment(state: TaskGraph, wave: number): GateCheck {
  if (!state.spec_check) {
    return pass("4. Spec alignment: skipped (no spec-check data).");
  }
  if (state.spec_check.wave !== wave) {
    return fail(`FAILED: Spec alignment was run for wave ${state.spec_check.wave}, not ${wave}. Re-run /spec-check for wave ${wave}.`);
  }
  if ((state.spec_check.critical_count ?? 0) > 0) {
    const findings = (state.spec_check.critical_findings ?? []).map((f) => `  - ${f}`).join("\n");
    return fail(`FAILED: Spec alignment has ${state.spec_check.critical_count} critical findings.\n${findings}`);
  }
  return pass(`4. Spec alignment verified (verdict: ${state.spec_check.verdict}).`);
}

/** Check 5: No critical code review findings */
export function checkCriticalFindings(tasks: Task[]): GateCheck {
  const totalCritical = tasks.reduce(
    (sum, t) => sum + (t.critical_findings?.filter(f => f.trim() !== '').length ?? 0),
    0
  );
  if (totalCritical > 0) {
    const details = tasks
      .filter((t) => (t.critical_findings?.filter(f => f.trim() !== '').length ?? 0) > 0)
      .map((t) => `  ${t.id}: ${t.critical_findings!.filter(f => f.trim() !== '').join(", ")}`)
      .join("\n");
    return fail(`FAILED: ${totalCritical} critical code review findings.\n${details}`);
  }
  return pass("5. No critical code review findings.");
}

/** How the plan's executable models were obtained for gate checks */
export type PlanModelsSource =
  | { kind: "none" }
  | { kind: "unreadable"; path: string; error: string }
  | { kind: "loaded"; models: PlanModels };

/**
 * Check 6: Lifecycle machine artifacts exist (executable-models policy).
 *
 * Decompose-time binding is a promise; this is the evidence check — any
 * lifecycle machine file bound to a task in this wave must exist on disk
 * before the wave can pass. No plan in state → skipped (legacy flows);
 * plan named but unreadable → fail closed (Phase 3 committed it, so a
 * missing plan at gate time is an error, never an opt-out).
 */
export function checkLifecycleArtifacts(
  source: PlanModelsSource,
  waveTasks: Task[],
  fileExists: (path: string) => boolean,
): GateCheck {
  if (source.kind === "none") {
    return pass("6. Lifecycle artifacts: skipped (no plan file in state).");
  }
  if (source.kind === "unreadable") {
    return fail(`FAILED: plan file '${source.path}' is unreadable — cannot verify lifecycle machine artifacts (fail-closed): ${source.error}`);
  }
  const waveFiles = waveTasks.flatMap((t) => t.file_list ?? []);
  const bound = source.models.lifecycles.filter(
    (lc) => lc.machineFile !== null && waveFiles.some((f) => pathsMatch(f, lc.machineFile!))
  );
  if (bound.length === 0) {
    return pass("6. Lifecycle artifacts: none bound to this wave.");
  }
  // An artifact is satisfied when ANY matched form exists: binding
  // validation (pathsMatch) accepts a task file_list path that is a deeper
  // /absolute form of the declared plan path, so the artifact may live at
  // the task's spelling (e.g. plan declares src/machines/x.machine.json,
  // the task wrote engine/src/machines/x.machine.json).
  const missing = bound.filter((lc) => {
    const variants = [lc.machineFile!, ...waveFiles.filter((f) => pathsMatch(f, lc.machineFile!))];
    return !variants.some(fileExists);
  });
  if (missing.length > 0) {
    return fail(
      `FAILED: lifecycle machine files declared in the plan were not created by this wave:\n` +
      missing.map((lc) => `  ${lc.id}: ${lc.machineFile}`).join("\n")
    );
  }
  return pass(
    `6. Lifecycle artifacts verified (${bound.length}):\n` +
    bound.map((lc) => `     ${lc.id}: ${lc.machineFile}`).join("\n")
  );
}

// --- Gate decision (evaluate once, apply pure) ---

/** I/O seams the gate evaluation needs — injected so evaluation is testable
 *  with plain data. In production these are PRE-RESOLVED into plain data
 *  (snapshotGateDeps) before the state lock, so evaluation inside the locked
 *  update is pure and retry-safe. */
export interface GateDeps {
  readonly loadPlanModels: (planFile: string | null | undefined) => PlanModelsSource;
  readonly fileExists: (path: string) => boolean;
}

/** The real fs seams snapshotGateDeps resolves — same shape as GateDeps. */
export type GateIO = GateDeps;

/**
 * Resolve every fs input the gate checks can need into plain data, BEFORE
 * the state lock: the plan's models are read once, and every machine file
 * a lifecycle can name is stat'ed once. The returned GateDeps are pure
 * closures over that snapshot, so `evaluateWaveGate(lockedState, ...)`
 * INSIDE the update callback is deterministic and repeats no I/O if the
 * write retries — while the checks themselves see the LOCKED state, never
 * a pre-lock snapshot that a concurrent SubagentStop may have outdated.
 *
 * The plan file is resolved from the pre-lock state: it is written once at
 * decompose time and never mutated by the SubagentStop handlers this lock
 * races with. Paths outside the snapshot resolve to false (fail closed).
 */
export function snapshotGateDeps(state: TaskGraph, io: GateIO): GateDeps {
  const snapshotPlan = state.plan_file ?? state.phase_artifacts?.architecture ?? null;
  const source = io.loadPlanModels(snapshotPlan);
  const exists = new Map<string, boolean>();
  if (source.kind === "loaded") {
    // Stat every form a lifecycle artifact can legitimately live at: the
    // declared plan path AND every task file_list entry that suffix-matches
    // it (pathsMatch — the same tolerance binding validation applies), so
    // checkLifecycleArtifacts can count ANY matched form as satisfied.
    const taskFiles = state.tasks.flatMap((t) => t.file_list ?? []);
    for (const lc of source.models.lifecycles) {
      if (lc.machineFile === null) continue;
      const candidates = [lc.machineFile, ...taskFiles.filter((f) => pathsMatch(f, lc.machineFile!))];
      for (const path of candidates) {
        if (!exists.has(path)) exists.set(path, io.fileExists(path));
      }
    }
  }
  return {
    // The snapshot was taken for ONE plan path. Evaluation passes the
    // LOCKED state's plan path back in — they must agree (plan_file is
    // written once at decompose and never mutated by the handlers this
    // lock races). If they ever diverge, serving the snapshot would
    // silently check the wrong plan: fail closed with the drift on record.
    loadPlanModels: (requested) => {
      const requestedPlan = typeof requested === "string" ? requested : null;
      if (requestedPlan === snapshotPlan) return source;
      return {
        kind: "unreadable",
        path: requestedPlan ?? "<none>",
        error: `gate deps were snapshotted for plan '${snapshotPlan ?? "<none>"}' but evaluation requested '${requestedPlan ?? "<none>"}' — plan path drifted between snapshot and locked evaluation`,
      };
    },
    fileExists: (path) => exists.get(path) ?? false,
  };
}

/**
 * The immutable result of evaluating every gate check against one state
 * snapshot. Built INSIDE the locked update from the locked state and
 * pre-resolved deps (snapshotGateDeps) — evaluation is pure there, so a
 * retried state write repeats no fs read or stderr write, while a
 * SubagentStop landing before the lock is still seen by every check.
 */
export interface GateDecision {
  readonly wave: number;
  /** All checks, in evaluation order (rendering stops at the first failure). */
  readonly checks: readonly GateCheck[];
  readonly verdict:
    | { readonly kind: "fail"; readonly reason: string }
    | { readonly kind: "pass"; readonly taskIds: readonly string[]; readonly nextWave: number | null };
}

/** Evaluate every gate check against a state snapshot. Deterministic given
 *  its deps; performs no writes. */
export function evaluateWaveGate(state: TaskGraph, waveArg: number | null, deps: GateDeps): GateDecision {
  const wave = waveArg ?? state.current_wave ?? 1;
  const waveTasks = state.tasks.filter((t) => t.wave === wave);

  const checks: readonly GateCheck[] = [
    checkTestEvidence(waveTasks),
    checkNewTests(waveTasks),
    checkReviews(waveTasks),
    checkSpecAlignment(state, wave),
    checkCriticalFindings(waveTasks),
    checkLifecycleArtifacts(
      deps.loadPlanModels(state.plan_file ?? state.phase_artifacts?.architecture),
      waveTasks,
      deps.fileExists,
    ),
  ];

  const failed = checks.find((c): c is Extract<GateCheck, { passed: false }> => !c.passed);
  if (failed) {
    return { wave, checks, verdict: { kind: "fail", reason: failed.reason } };
  }
  return {
    wave,
    checks,
    verdict: {
      kind: "pass",
      taskIds: waveTasks.map((t) => t.id),
      nextWave: computeNextWave(state.tasks, wave),
    },
  };
}

/**
 * Pure: apply a passing decision to the task graph — complete the wave's
 * tasks, stamp the wave gate, advance current_wave. A failing decision
 * returns the state unchanged. Safe to re-run: no side effects, and
 * applying the same decision twice yields the same state.
 */
export function applyGateDecision(state: TaskGraph, decision: GateDecision): TaskGraph {
  if (decision.verdict.kind !== "pass") return state;
  const { wave } = decision;
  const { nextWave } = decision.verdict;
  const defaultGate: WaveGate = { impl_complete: false, tests_passed: null, reviews_complete: false, blocked: false };

  return {
    ...state,
    tasks: state.tasks.map((t) =>
      t.wave === wave
        ? { ...t, status: "completed" as const, review_status: "passed" as const }
        : t
    ),
    wave_gates: {
      ...state.wave_gates,
      [String(wave)]: {
        ...(state.wave_gates[String(wave)] ?? defaultGate),
        tests_passed: true,
        reviews_complete: true,
        blocked: false,
      },
      ...(nextWave != null ? {
        [String(nextWave)]: {
          ...(state.wave_gates[String(nextWave)] ?? defaultGate),
        },
      } : {}),
    },
    ...(nextWave != null ? { current_wave: nextWave } : {}),
  };
}

/** Update GitHub issue checkboxes */
function updateGitHubIssue(state: TaskGraph, taskIds: string[]): void {
  const issue = state.github_issue;
  if (!issue) return;

  try {
    const repoFlag = state.github_repo ? `--repo ${state.github_repo}` : "";
    const body = execSync(`gh issue view ${issue} ${repoFlag} --json body -q '.body'`, { encoding: "utf-8" });

    let updated = body;
    for (const id of taskIds) {
      updated = updated.replace(new RegExp(`- \\[ \\] ${id}:`, "g"), `- [x] ${id}:`);
    }

    execSync(`gh issue edit ${issue} ${repoFlag} --body-file -`, { input: updated, stdio: ["pipe", "pipe", "pipe"] });
    process.stderr.write(`Updated checkboxes in issue #${issue}\n`);
  } catch (e) {
    process.stderr.write(`WARNING: Failed to update GH issue #${issue} checkboxes: ${(e as Error).message}\n`);
  }
}

/** Compute next wave from actual wave numbers (handles non-contiguous waves) */
export function computeNextWave(tasks: Task[], currentWave: number): number | null {
  const allWaves = [...new Set(tasks.map((t) => t.wave))].sort((a, b) => a - b);
  return allWaves.find((w) => w > currentWave) ?? null;
}

/** Pure: Generate wave gate summary markdown */
export function generateWaveGateSummary(
  wave: number,
  tasks: Task[],
  specCheck?: TaskGraph["spec_check"]
): string {
  const lines: string[] = [`## Wave ${wave} — Gate Passed\n`];

  // Spec check
  if (specCheck) {
    lines.push(`### Spec Alignment: ${specCheck.verdict} (${specCheck.critical_count ?? 0} critical)`);
    if (specCheck.medium_findings?.length) {
      specCheck.medium_findings.forEach((f) => lines.push(`- MEDIUM: ${f}`));
    }
    lines.push('');
  }

  // Per-task review summary
  lines.push('### Code Review\n');
  for (const task of tasks) {
    const critCount = task.critical_findings?.length ?? 0;
    const advCount = task.advisory_findings?.length ?? 0;
    lines.push(`#### ${task.id}: ${task.description?.slice(0, 60) ?? ''}`);
    lines.push(`**Status:** ${task.review_status} — ${critCount} critical, ${advCount} advisory`);

    if (task.advisory_findings?.length) {
      lines.push('<details>');
      lines.push(`<summary>${advCount} advisories</summary>\n`);
      task.advisory_findings.forEach((a) => lines.push(`- ${a}`));
      lines.push('</details>');
    }
    lines.push('');
  }

  // Test summary
  lines.push('### Tests');
  for (const task of tasks) {
    lines.push(`- ${task.id}: ${task.test_evidence ?? 'no evidence'}`);
  }

  return lines.join('\n');
}

/** Post GitHub comment summarizing wave gate results.
 *  Takes a snapshot of state captured under the update lock to avoid a second read. */
function postWaveGateSummary(state: TaskGraph, completedWave: number): void {
  const githubIssue = state.github_issue;
  if (!githubIssue) return;

  try {
    const waveTasks = state.tasks.filter((t) => t.wave === completedWave);
    const body = generateWaveGateSummary(completedWave, waveTasks, state.spec_check);

    const repoFlag = state.github_repo ? `--repo ${state.github_repo}` : "";
    execSync(`gh issue comment ${githubIssue} ${repoFlag} --body-file -`, {
      input: body,
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 15000,
    });
    process.stderr.write(`Posted wave ${completedWave} summary to issue #${githubIssue}\n`);
  } catch (e) {
    // Non-blocking — don't fail the gate on comment failure
    process.stderr.write(`WARNING: Failed to post GH comment: ${(e as Error).message}\n`);
  }
}

/** One stderr line per wave task still carrying the pre-refactor
 *  `tests_passed` field — otherwise its "missing evidence" gate failure is
 *  inexplicable to the operator. Advisory only; never affects the verdict. */
function warnLegacyTestsPassed(tasks: readonly Task[], wave: number): void {
  for (const task of tasks) {
    if (task.wave !== wave) continue;
    const note = legacyTestsPassedNote(task);
    if (note) process.stderr.write(`[loom] ${note}\n`);
  }
}

const handler: HookHandler = async (_stdin, args) => {
  // Resolved at call time (not import time) so env re-pointing is honored.
  const statePath = taskGraphPath();
  const mgr = StateManager.fromPath(statePath);
  if (!mgr) return { kind: "error", message: `No task graph at ${statePath}` };

  const waveArg = parseWaveArg(args);

  // Pre-resolve the fs inputs (plan read + machine-file stats) into plain
  // data BEFORE the lock. These never race the SubagentStop handlers this
  // lock contends with — but the task graph does, so the checks themselves
  // must run on the LOCKED state below, never this pre-lock read.
  const preRead = mgr.load();
  const gateDeps = snapshotGateDeps(preRead, {
    loadPlanModels: loadPlanModelsSource,
    fileExists: existsSync,
  });

  warnLegacyTestsPassed(preRead.tasks, waveArg ?? preRead.current_wave ?? 1);

  // Single locked update: evaluate every check against the locked state —
  // a SubagentStop landing between the pre-read and this lock (reviewer
  // findings, a trusted-fail test_result, a crash status) is seen by the
  // checks instead of being force-overwritten by a stale decision. With
  // deps pre-resolved, evaluation is pure, so a retried callback repeats
  // no I/O; stderr rendering stays outside, after the lock.
  let decision: GateDecision | undefined;
  let snapshot: TaskGraph | null = null;
  try {
    await mgr.update((s) => {
      const d = evaluateWaveGate(s, waveArg, gateDeps);
      decision = d;
      if (d.verdict.kind !== "pass") return s;
      const updated = applyGateDecision(s, d);
      snapshot = updated;
      return updated;
    });
  } catch (e) {
    return {
      kind: "error",
      message: `[loom] complete-wave-gate: failed to evaluate/persist wave gate: ${(e as Error).message}`,
    };
  }
  if (decision === undefined) {
    // Unreachable: mgr.update either ran the callback or threw above.
    return { kind: "error", message: "[loom] complete-wave-gate: state update returned without evaluating the gate" };
  }

  process.stderr.write(`Completing wave ${decision.wave} gate...\n\n`);
  for (const check of decision.checks) {
    process.stderr.write(gateCheckMessage(check) + "\n");
    if (!check.passed) break;
  }

  if (decision.verdict.kind === "fail") {
    return { kind: "error", message: decision.verdict.reason };
  }
  const verdict = decision.verdict;

  process.stderr.write("\nAll checks passed. Advancing...\n");

  // I/O at edge: update GitHub issue outside lock
  const github: TaskGraph = snapshot ?? mgr.load();
  if (github.github_issue) {
    updateGitHubIssue(github, [...verdict.taskIds]);
  }

  if (verdict.nextWave != null) {
    process.stderr.write(`Advanced to wave ${verdict.nextWave}.\n`);
  } else {
    process.stderr.write("\n=== All waves complete! ===\nRun /loom --complete to finalize.\n");
  }

  // Post GitHub comment with wave summary using the snapshot from inside the lock
  if (snapshot) {
    postWaveGateSummary(snapshot, decision.wave);
  }

  return { kind: "passthrough" };
};

export default handler;
