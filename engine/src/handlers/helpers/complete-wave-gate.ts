/**
 * Complete wave gate after reviews pass.
 * Verifies: test evidence, new tests, reviews, spec alignment, no critical findings.
 * Then marks wave tasks completed, updates GitHub issue checkboxes, advances wave.
 *
 * Usage: bun cli.ts helper complete-wave-gate [--wave N]
 */

import { execSync } from "node:child_process";
import type { HookHandler, TaskGraph, Task, WaveGate } from "../../types";
import { TASK_GRAPH_PATH } from "../../config";
import { StateManager } from "../../state-manager";

function parseWaveArg(args: string[]): number | null {
  const idx = args.indexOf("--wave");
  if (idx >= 0 && args[idx + 1]) return Number(args[idx + 1]);
  return null;
}

interface GateCheck {
  passed: boolean;
  message: string;
}

/** Check 1: All tasks have test evidence */
export function checkTestEvidence(tasks: Task[]): GateCheck {
  const missing = tasks.filter((t) => !t.tests_passed);
  if (missing.length > 0) {
    return {
      passed: false,
      message: `FAILED: Not all tasks have test evidence.\n  Missing: ${missing.map((t) => t.id).join(", ")}`,
    };
  }
  const lines = tasks.map((t) => `     ${t.id}: ${t.test_evidence ?? "evidence present"}`);
  return { passed: true, message: `1. Test evidence verified (${tasks.length}/${tasks.length} tasks):\n${lines.join("\n")}` };
}

/** Check 1b: New tests written or not required */
export function checkNewTests(tasks: Task[]): GateCheck {
  const missing = tasks.filter((t) => t.new_tests_required !== false && !t.new_tests_written);
  if (missing.length > 0) {
    return {
      passed: false,
      message: `FAILED: Not all tasks satisfied new-test requirement.\n  Missing: ${missing.map((t) => t.id).join(", ")}`,
    };
  }
  const lines = tasks.map((t) => {
    const evidence = t.new_test_evidence ?? (t.new_tests_required === false ? "not required" : "new tests present");
    return `     ${t.id}: ${evidence}`;
  });
  return { passed: true, message: `   New tests verified (${tasks.length}/${tasks.length} tasks):\n${lines.join("\n")}` };
}

/** Check 2: All tasks reviewed */
export function checkReviews(tasks: Task[]): GateCheck {
  const reviewed = tasks.filter((t) => t.review_status === "passed" || t.review_status === "blocked");
  if (reviewed.length !== tasks.length) {
    const unreviewed = tasks.filter((t) => !t.review_status || t.review_status === "pending").map((t) => t.id);
    const failed = tasks.filter((t) => t.review_status === "evidence_capture_failed").map((t) => t.id);
    const parts = ["FAILED: Not all tasks have been reviewed."];
    if (failed.length > 0) parts.push(`  Evidence capture failed: ${failed.join(", ")}`);
    if (unreviewed.length > 0) parts.push(`  Unreviewed: ${unreviewed.join(", ")}`);
    return { passed: false, message: parts.join("\n") };
  }
  const lines = tasks.map((t) => `     ${t.id}: ${t.review_status}`);
  return { passed: true, message: `2. Reviews verified (${tasks.length}/${tasks.length} tasks):\n${lines.join("\n")}` };
}

/** Check 3: Spec alignment */
export function checkSpecAlignment(state: TaskGraph, wave: number): GateCheck {
  if (!state.spec_check) {
    return { passed: true, message: "3. Spec alignment: skipped (no spec-check data)." };
  }
  if (state.spec_check.wave !== wave) {
    return { passed: false, message: `FAILED: Spec alignment was run for wave ${state.spec_check.wave}, not ${wave}. Re-run /spec-check for wave ${wave}.` };
  }
  if ((state.spec_check.critical_count ?? 0) > 0) {
    const findings = (state.spec_check.critical_findings ?? []).map((f) => `  - ${f}`).join("\n");
    return {
      passed: false,
      message: `FAILED: Spec alignment has ${state.spec_check.critical_count} critical findings.\n${findings}`,
    };
  }
  return { passed: true, message: `3. Spec alignment verified (verdict: ${state.spec_check.verdict}).` };
}

/** Check 4: No critical code review findings */
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
    return { passed: false, message: `FAILED: ${totalCritical} critical code review findings.\n${details}` };
  }
  return { passed: true, message: "4. No critical code review findings." };
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

    execSync(`gh issue edit ${issue} ${repoFlag} --body ${JSON.stringify(updated)}`, { stdio: "pipe" });
    process.stderr.write(`Updated checkboxes in issue #${issue}\n`);
  } catch {}
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

/** Post GitHub comment summarizing wave gate results */
async function postWaveGateSummary(mgr: StateManager, waveArg: number | null): Promise<void> {
  const state = mgr.load();
  const currentWave = waveArg ?? state.current_wave ?? 1;
  const githubIssue = state.github_issue;

  if (!githubIssue) return;

  try {
    const waveTasks = state.tasks.filter((t) => t.wave === currentWave);
    const body = generateWaveGateSummary(currentWave, waveTasks, state.spec_check);

    const repoFlag = state.github_repo ? `--repo ${state.github_repo}` : "";
    execSync(`gh issue comment ${githubIssue} ${repoFlag} --body ${JSON.stringify(body)}`, {
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 15000,
    });
    process.stderr.write(`Posted wave ${currentWave} summary to issue #${githubIssue}\n`);
  } catch (e) {
    // Non-blocking — don't fail the gate on comment failure
    process.stderr.write(`WARNING: Failed to post GH comment: ${(e as Error).message}\n`);
  }
}

const handler: HookHandler = async (_stdin, args) => {
  const mgr = StateManager.fromPath(TASK_GRAPH_PATH);
  if (!mgr) return { kind: "error", message: `No task graph at ${TASK_GRAPH_PATH}` };

  const waveArg = parseWaveArg(args);

  // Single locked update: run all checks on locked state, then mutate atomically
  let errorMessage: string | null = null;
  let taskIds: string[] = [];
  let nextWave: number | null = null;
  let githubState: { issue?: number; repo?: string } = {};

  await mgr.update((s) => {
    const wave = waveArg ?? s.current_wave ?? 1;
    const waveTasks = s.tasks.filter((t) => t.wave === wave);

    process.stderr.write(`Completing wave ${wave} gate...\n\n`);

    // Run all checks on locked state
    const checks = [
      checkTestEvidence(waveTasks),
      checkNewTests(waveTasks),
      checkReviews(waveTasks),
      checkSpecAlignment(s, wave),
      checkCriticalFindings(waveTasks),
    ];

    for (const check of checks) {
      process.stderr.write(check.message + "\n");
      if (!check.passed) {
        errorMessage = check.message;
        return s; // Return state unchanged
      }
    }

    process.stderr.write("\nAll checks passed. Advancing...\n");

    taskIds = waveTasks.map((t) => t.id);
    githubState = { issue: s.github_issue, repo: s.github_repo };

    // Compute next wave from actual wave numbers
    nextWave = computeNextWave(s.tasks, wave);

    const defaultGate: WaveGate = { impl_complete: false, tests_passed: null, reviews_complete: false, blocked: false };

    // Build updated state atomically
    const updated: TaskGraph = {
      ...s,
      tasks: s.tasks.map((t) =>
        t.wave === wave
          ? { ...t, status: "completed" as const, review_status: "passed" as const }
          : t
      ),
      wave_gates: {
        ...s.wave_gates,
        [String(wave)]: {
          ...(s.wave_gates[String(wave)] ?? defaultGate),
          tests_passed: true,
          reviews_complete: true,
          blocked: false,
        },
        ...(nextWave != null ? {
          [String(nextWave)]: {
            ...(s.wave_gates[String(nextWave)] ?? defaultGate),
          },
        } : {}),
      },
      ...(nextWave != null ? { current_wave: nextWave } : {}),
    };

    return updated;
  });

  if (errorMessage) {
    return { kind: "error", message: errorMessage };
  }

  // I/O at edge: update GitHub issue outside lock
  if (githubState.issue) {
    updateGitHubIssue({ github_issue: githubState.issue, github_repo: githubState.repo } as TaskGraph, taskIds);
  }

  if (nextWave != null) {
    process.stderr.write(`Advanced to wave ${nextWave}.\n`);
  } else {
    process.stderr.write("\n=== All waves complete! ===\nRun /loom --complete to finalize.\n");
  }

  // Post GitHub comment with wave summary
  await postWaveGateSummary(mgr, waveArg);

  return { kind: "passthrough" };
};

export default handler;
