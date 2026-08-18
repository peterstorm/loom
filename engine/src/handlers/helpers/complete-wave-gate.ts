/**
 * Complete wave gate after reviews pass.
 * Verifies: implementation proof, test evidence, new tests, reviews, spec
 * alignment, no critical findings, lifecycle machine artifacts.
 * Then marks wave tasks completed, updates GitHub issue checkboxes, advances wave.
 *
 * Usage: bun cli.ts helper complete-wave-gate [--wave N]
 */

import { execFileSync } from "node:child_process";
import { closeSync, constants as fsConstants, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { HookHandler, HookResult, TaskGraph, Task } from "../../types";
import { legacyTestsPassedNote } from "../../types";
import { taskGraphPath } from "../../config";
import {
  deriveLegacyWaveGateCompatibilityAuthority,
  findLegacyWaveGateCompletionReplay,
  findRegisteredWaveGateCompletionReplay,
  PostCommitStateProtectionError,
  StateManager,
  type LegacyWaveGateCompatibilityAuthority,
} from "../../state-manager";
import { parsePlanModels } from "../../parsers/parse-plan-models";
import { pathsMatch } from "./validate-model-bindings";
import { inspectRepositoryPath } from "../../utils/repository-path";
import {
  commitWaveGateCompletion,
  deriveWaveReadiness,
  evaluateWaveGate as evaluateCoreWaveGate,
  gateCheckMessage as coreGateCheckMessage,
  type GateCheck as CoreGateCheck,
  type GateDecision as CoreGateDecision,
  type GateDeps as CoreGateDeps,
  type PlanModelsSource as CorePlanModelsSource,
} from "../../core/wave-gate-machine";

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

export { parseWaveArg } from "./wave-args";
import { parseWaveArg } from "./wave-args";

export type GateCheck = CoreGateCheck;


/** How the plan's executable models were obtained for gate checks */
export type PlanModelsSource = CorePlanModelsSource;

// --- Gate decision (evaluate once, apply pure) ---

/** I/O seams the gate evaluation needs — injected so evaluation is testable
 * with plain data. Completion resolves them while holding the StateManager
 * lock, so lifecycle paths are re-read and re-stat'ed at commit time. */
export type GateDeps = CoreGateDeps;

/** The real fs seams snapshotGateDeps resolves — same shape as GateDeps. */
export type GateIO = GateDeps;

/** Resolve the exact plan and lifecycle-path observations used by one
 * evaluation. Production completion calls this inside the protected-state
 * lock; callers that cache it before locking do not have commit authority. */
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
 * snapshot. Built inside the locked update from locked state and lifecycle
 * observations made under that same lock.
 */
export type GateDecision = CoreGateDecision;

export interface GitHubIssuePort {
  readonly readBody: (issue: number, repository?: string) => string;
  readonly editBody: (issue: number, body: string, repository?: string) => void;
  readonly postComment: (issue: number, body: string, repository?: string) => void;
}

/** Deterministic notification-boundary rendering for Error and non-Error
 * throws. Notification failures are advisory, but their causes must not become
 * the misleading string `undefined`. */
export function notificationCauseMessage(cause: unknown): string {
  try {
    if (cause instanceof Error && typeof cause.message === "string" && cause.message.length > 0) {
      return cause.message;
    }
    if (cause === null || cause === undefined) return "[no notification failure cause provided]";
    return String(cause);
  } catch {
    return "[uninspectable thrown notification cause]";
  }
}

function repositoryArgs(repository: string | undefined): readonly string[] {
  return repository === undefined ? [] : ["--repo", repository];
}

export const githubCliIssuePort: GitHubIssuePort = Object.freeze({
  readBody: (issue: number, repository?: string) => execFileSync("gh", [
    "issue", "view", String(issue), ...repositoryArgs(repository), "--json", "body", "-q", ".body",
  ], { encoding: "utf-8", timeout: 15000 }),
  editBody: (issue: number, body: string, repository?: string) => {
    execFileSync("gh", ["issue", "edit", String(issue), ...repositoryArgs(repository), "--body-file", "-"], {
      input: body,
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 15000,
    });
  },
  postComment: (issue: number, body: string, repository?: string) => {
    execFileSync("gh", ["issue", "comment", String(issue), ...repositoryArgs(repository), "--body-file", "-"], {
      input: body,
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 15000,
    });
  },
});

/** Update GitHub issue checkboxes through the injected notification port. */
export function updateGitHubIssue(
  state: TaskGraph,
  taskIds: readonly string[],
  port: GitHubIssuePort = githubCliIssuePort,
): void {
  const issue = state.github_issue;
  if (!issue) return;

  try {
    const body = port.readBody(issue, state.github_repo);
    let updated = body;
    for (const id of taskIds) {
      updated = updated.replace(new RegExp(`- \\[ \\] ${id}:`, "g"), `- [x] ${id}:`);
    }
    port.editBody(issue, updated, state.github_repo);
    process.stderr.write(`Updated checkboxes in issue #${issue}\n`);
  } catch (e) {
    process.stderr.write(`WARNING: Failed to update GH issue #${issue} checkboxes: ${notificationCauseMessage(e)}\n`);
  }
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
    const refuted = task.refuted_findings ?? [];
    if (refuted.length > 0) {
      lines.push('<details>');
      lines.push(`<summary>${refuted.length} refuted critical findings</summary>\n`);
      for (const record of refuted) {
        lines.push(`- ${record.finding.id}: ${record.finding.claim}`);
        for (const refutation of record.refutations) {
          lines.push(`  - ${refutation.lens}: ${refutation.reason}`);
        }
      }
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

/** Persist the durable fallback promised by the wave-gate runbook. */
export function persistWaveGateSummaryFallback(
  completedWave: number,
  body: string,
  root: string = process.cwd(),
): string {
  const relativePath = join(".claude", "reviews", `wave-${completedWave}-review.md`);
  const initial = inspectRepositoryPath(root, relativePath, "wave-gate summary fallback");
  mkdirSync(dirname(initial.absolute), { recursive: true });
  const target = inspectRepositoryPath(root, relativePath, "wave-gate summary fallback");
  const descriptor = openSync(
    target.absolute,
    fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC | fsConstants.O_NOFOLLOW,
    0o600,
  );
  try {
    writeFileSync(descriptor, body);
  } finally {
    closeSync(descriptor);
  }
  return target.absolute;
}

/** Post GitHub comment summarizing wave gate results.
 *  Takes a snapshot of state captured under the update lock to avoid a second read. */
export function postWaveGateSummary(
  state: TaskGraph,
  completedWave: number,
  port: GitHubIssuePort = githubCliIssuePort,
  fallbackRoot: string = process.cwd(),
): void {
  const githubIssue = state.github_issue;
  if (!githubIssue) return;
  const waveTasks = state.tasks.filter((t) => t.wave === completedWave);
  const body = generateWaveGateSummary(completedWave, waveTasks, state.spec_check);

  try {
    port.postComment(githubIssue, body, state.github_repo);
    process.stderr.write(`Posted wave ${completedWave} summary to issue #${githubIssue}\n`);
  } catch (e) {
    // Non-blocking — don't fail the gate on comment failure, but preserve the
    // summary in the documented durable fallback rather than losing it with
    // this process's stderr.
    const notificationCause = notificationCauseMessage(e);
    try {
      const fallback = persistWaveGateSummaryFallback(completedWave, body, fallbackRoot);
      process.stderr.write(
        `WARNING: Failed to post GH comment: ${notificationCause}; wrote fallback summary to ${fallback}\n`,
      );
    } catch (fallbackError) {
      process.stderr.write(
        `WARNING: Failed to post GH comment: ${notificationCause}; ` +
        `failed to write fallback summary: ${notificationCauseMessage(fallbackError)}\n`,
      );
    }
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

function completionCommitErrorMessage(error: Error): string {
  if (error instanceof PostCommitStateProtectionError) return postCommitProtectionFailureMessage(error);
  if (error instanceof AggregateError) {
    const nested = [...error.errors].map((cause, index) =>
      `cause ${index + 1}: ${cause instanceof Error ? completionCommitErrorMessage(cause) : notificationCauseMessage(cause)}`);
    return nested.length === 0 ? error.message : `${error.message}; ${nested.join("; ")}`;
  }
  return notificationCauseMessage(error);
}

function postCommitProtectionFailureMessage(error: PostCommitStateProtectionError<unknown>): string {
  const committed = typeof error.committedValue === "object" && error.committedValue !== null
    ? error.committedValue as Record<string, unknown>
    : null;
  const receipt = committed !== null && typeof committed.receipt === "object" && committed.receipt !== null
    ? committed.receipt as Record<string, unknown>
    : null;
  const effectId = typeof receipt?.effectId === "string" ? receipt.effectId : "<unavailable>";
  const revision = typeof receipt?.committedRevision === "number" ? receipt.committedRevision : "<unavailable>";
  return (
    `[loom] complete-wave-gate: protected Wave state was committed with receipt ${effectId} at revision ${revision}, ` +
    `but read-only permission restoration failed: ${notificationCauseMessage(error.permissionCause)}. ` +
    `Remediation: restore protection with chmod 0444 ${JSON.stringify(error.statePath)}, then inspect ` +
    `wave_gate_history for receipt ${effectId}; do not rerun completion as if this were an idempotent replay until protection is restored.`
  );
}

async function runCompleteWaveGate(
  _stdin: string,
  args: string[],
  resolveManager: (path: string) => StateManager | null,
): Promise<HookResult> {
  // Resolved at call time (not import time) so env re-pointing is honored.
  const statePath = taskGraphPath();
  const mgr = resolveManager(statePath);
  if (!mgr) return { kind: "error", message: `No task graph at ${statePath}` };

  let waveArg: number | null;
  try {
    waveArg = parseWaveArg(args);
  } catch (e) {
    return { kind: "error", message: `[loom] complete-wave-gate: ${(e as Error).message}` };
  }

  let preRead = mgr.load();
  const registeredCompletionAuthority = preRead.active_wave_gate?.terminalOutcome === null
    ? preRead.active_wave_gate
    : null;
  let compatibilityAuthority: LegacyWaveGateCompatibilityAuthority | null = null;
  if (preRead.active_wave_gate === undefined) {
    const compatibility = deriveLegacyWaveGateCompatibilityAuthority(preRead, waveArg);
    if (!compatibility.ok) {
      return {
        kind: "error",
        message: `[loom] complete-wave-gate: explicit legacy authority migration rejected: ${compatibility.error.message}`,
      };
    }
    compatibilityAuthority = compatibility.value;
    const existingCompletion = findLegacyWaveGateCompletionReplay(preRead, compatibilityAuthority);
    if (!existingCompletion.ok) {
      return {
        kind: "error",
        message: `[loom] complete-wave-gate: conflicting compatibility completion replay: ${existingCompletion.error.message}`,
      };
    }
    if (existingCompletion.value !== null) {
      process.stderr.write(
        `Wave ${existingCompletion.value.wave} was already completed by ${existingCompletion.value.runId}; ` +
        `reusing receipt ${existingCompletion.value.completionReceipt.effectId}.\n`,
      );
      return { kind: "passthrough" };
    }
    try {
      await mgr.migrateLegacyWaveGateRegistration(compatibilityAuthority);
      preRead = mgr.load();
    } catch (e) {
      // Another completion invocation may have won both locks after our
      // pre-read. Re-read terminal history and classify only the exact outcome
      // as idempotent; a different run/digest remains a hard conflict.
      try {
        const racedCompletion = findLegacyWaveGateCompletionReplay(mgr.load(), compatibilityAuthority);
        if (!racedCompletion.ok) {
          return {
            kind: "error",
            message: `[loom] complete-wave-gate: conflicting compatibility completion replay: ${racedCompletion.error.message}`,
          };
        }
        if (racedCompletion.value !== null) {
          process.stderr.write(
            `Wave ${racedCompletion.value.wave} was concurrently completed by ${racedCompletion.value.runId}; ` +
            `reusing receipt ${racedCompletion.value.completionReceipt.effectId}.\n`,
          );
          return { kind: "passthrough" };
        }
      } catch (replayReadError) {
        return {
          kind: "error",
          message: `[loom] complete-wave-gate: explicit legacy authority migration failed: ${notificationCauseMessage(e)}; ` +
            `terminal replay read also failed: ${notificationCauseMessage(replayReadError)}`,
        };
      }
      return {
        kind: "error",
        message: `[loom] complete-wave-gate: explicit legacy authority migration failed: ${notificationCauseMessage(e)}`,
      };
    }
  }
  if (preRead.current_wave !== undefined) {
    warnLegacyTestsPassed(preRead.tasks, waveArg ?? preRead.current_wave);
  }

  // One locked authority transaction: load graph, re-read plan, re-stat every
  // lifecycle artifact, derive canonical readiness, archive terminal
  // registration, and advance Tasks/Wave together. No pre-lock fs observation
  // can authorize completion.
  let decision: GateDecision | null = null;
  let committed: Awaited<ReturnType<StateManager["commitActiveWaveGateCompletion"]>> | null = null;
  let commitError: Error | null = null;
  try {
    committed = await mgr.commitActiveWaveGateCompletion((state) => {
      const liveDeps = snapshotGateDeps(state, {
        loadPlanModels: loadPlanModelsSource,
        fileExists: existsSync,
      });
      decision = evaluateCoreWaveGate(state, waveArg, liveDeps);
      if (decision.verdict.kind !== "pass") {
        return {
          ok: false,
          error: {
            kind: "wave-completion-commit-rejected" as const,
            message: decision.verdict.reason,
          },
        };
      }
      const readiness = deriveWaveReadiness(state, liveDeps);
      return readiness.ok
        ? commitWaveGateCompletion(readiness.value)
        : {
            ok: false,
            error: {
              kind: "wave-completion-commit-rejected" as const,
              message: readiness.error.reasons.map(({ message }) => message).join("; "),
            },
          };
    });
  } catch (e) {
    commitError = e instanceof Error ? e : new Error(String(e));
  }

  if (commitError instanceof PostCommitStateProtectionError) {
    return { kind: "error", message: postCommitProtectionFailureMessage(commitError) };
  }
  const formattedCommitError = commitError === null ? null : completionCommitErrorMessage(commitError);

  if (commitError !== null && compatibilityAuthority !== null) {
    try {
      const racedCompletion = findLegacyWaveGateCompletionReplay(mgr.load(), compatibilityAuthority);
      if (!racedCompletion.ok) {
        return {
          kind: "error",
          message: `[loom] complete-wave-gate: conflicting compatibility completion replay: ${racedCompletion.error.message}`,
        };
      }
      if (racedCompletion.value !== null) {
        process.stderr.write(
          `Wave ${racedCompletion.value.wave} was concurrently completed by ${racedCompletion.value.runId}; ` +
          `reusing receipt ${racedCompletion.value.completionReceipt.effectId}.\n`,
        );
        return { kind: "passthrough" };
      }
    } catch (replayReadError) {
      return {
        kind: "error",
        message: `[loom] complete-wave-gate: locked completion failed: ${formattedCommitError}; ` +
          `compatibility terminal replay read also failed: ${notificationCauseMessage(replayReadError)}`,
      };
    }
  }

  if (commitError !== null && registeredCompletionAuthority !== null) {
    try {
      const racedCompletion = findRegisteredWaveGateCompletionReplay(mgr.load(), registeredCompletionAuthority);
      if (!racedCompletion.ok) {
        return {
          kind: "error",
          message: `[loom] complete-wave-gate: conflicting registered completion replay: ${racedCompletion.error.message}`,
        };
      }
      if (racedCompletion.value !== null) {
        process.stderr.write(
          `Wave ${racedCompletion.value.wave} was concurrently completed by ${racedCompletion.value.runId}; ` +
          `reusing committed receipt ${racedCompletion.value.completionReceipt.effectId}.\n`,
        );
        return { kind: "passthrough" };
      }
    } catch (replayReadError) {
      return {
        kind: "error",
        message: `[loom] complete-wave-gate: locked completion failed: ${formattedCommitError}; ` +
          `registered terminal replay read also failed: ${notificationCauseMessage(replayReadError)}`,
      };
    }
  }

  if (decision === null) {
    return {
      kind: "error",
      message: `[loom] complete-wave-gate: failed to evaluate/persist wave gate: ${formattedCommitError ?? "completion produced no decision"}`,
    };
  }
  const lockedDecision: GateDecision = decision;
  process.stderr.write(`Completing wave ${lockedDecision.wave} gate...\n\n`);
  for (const check of lockedDecision.checks) {
    process.stderr.write(coreGateCheckMessage(check) + "\n");
    if (!check.passed) break;
  }

  if (lockedDecision.verdict.kind === "fail" || committed === null) {
    const decisionFailure = lockedDecision.verdict.kind === "fail" ? lockedDecision.verdict.reason : null;
    return {
      kind: "error",
      message: formattedCommitError === null
        ? decisionFailure ?? "[loom] complete-wave-gate: completion produced no committed receipt"
        : decisionFailure === null
          ? `[loom] complete-wave-gate: failed to persist exact completion receipt: ${formattedCommitError}`
          : `${decisionFailure}\n[loom] complete-wave-gate: locked state transaction also failed: ${formattedCommitError}`,
    };
  }
  const verdict = lockedDecision.verdict;
  const snapshot = committed.graph;

  process.stderr.write("\nAll checks passed. Advancing...\n");

  // I/O at edge: update GitHub issue outside lock
  const github: TaskGraph = snapshot;
  if (github.github_issue) {
    updateGitHubIssue(github, [...verdict.taskIds]);
  }

  if (verdict.nextWave != null) {
    process.stderr.write(`Advanced to wave ${verdict.nextWave}.\n`);
  } else {
    process.stderr.write("\n=== All waves complete! ===\nRun /loom --complete to finalize.\n");
  }

  // Post GitHub comment with wave summary using the snapshot from inside the lock
  postWaveGateSummary(snapshot, lockedDecision.wave);
  process.stderr.write(`Committed receipt ${committed.receipt.effectId} at revision ${committed.receipt.committedRevision}.\n`);

  return { kind: "passthrough" };
}

export function createCompleteWaveGateHandler(
  resolveManager: (path: string) => StateManager | null = StateManager.fromPath,
): HookHandler {
  return (stdin, args) => runCompleteWaveGate(stdin, args, resolveManager);
}

const handler = createCompleteWaveGateHandler();
export default handler;
