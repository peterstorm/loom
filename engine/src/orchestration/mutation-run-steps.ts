/**
 * The effectful steps both mutation shells take: Owner Verification at the
 * Wave Gate (`owner-verification-runner.ts`, ADR-0036) and the Task mutation
 * check (`task-mutation-runner.ts`, ADR-0071). Neither shell reaches into the
 * other; both import these, so they cannot drift on how a changed module is
 * read against its base or on how a runner command is formed and run.
 *
 * - Reading: `readRepositoryText` reads a repository file under the one
 *   absence rule (`utils/file-absence.ts`): only absence is "not there", any
 *   other refusal is `repository-file-unreadable`.
 * - The base: `resolveWaveBase` resolves a chosen base with Git, and
 *   `ownerAtBase` reads a module's text there (null for a module that did not
 *   exist, so every line counts as changed).
 * - Running: `matrixTestCommand` forms the frozen `affectedRunner`'s command
 *   over one file with its time limit clamped by `mutantTimeoutMs`, and
 *   `runOnce` executes it once in an isolated worktree, as `matrixTestRunOf`
 *   reads the execution. No command text ever comes from a plan.
 *
 * Every function returns its fault as data and none throws, except where a
 * caller-supplied workspace step throws through `runOnce`.
 */

import { posix } from "node:path";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { parseAuthorizedWaveCompletionCheck, type AuthorizedWaveCompletionCheck } from "../core/completion-suite";
import { failure, success, type DomainResult } from "../core/orchestration-contract/identity";
import { MODULE_ABSENT } from "../core/owner-verification/coverage";
import { ownerAtBaseEntry } from "../core/owner-verification/ls-tree";
import { mutantTimeoutMs } from "../core/owner-verification/mutation-plan";
import type {
  MatrixTestRun,
  ModuleRead,
  OwnerInfrastructureFailure,
  OwnerInfrastructureFailureKind,
} from "../core/owner-verification/types";
import type { WaveBase } from "../core/owner-verification/wave-base";
import { affectedRunnerCheck, type AffectedRunner } from "../core/verification-manifest";
import { describeCause } from "../utils/describe-cause";
import { isAbsence } from "../utils/file-absence";
import { runGit } from "../utils/git-execution-policy";
import type { CanonicalRepositoryRoot } from "../utils/workspace-digest";
import { runProjectCommandAt, type CommandExecutionResult } from "./completion-check-runner";
import type { MutationWorkspace, OwnerVariant } from "./owner-mutation-workspace";

export const infrastructure = (kind: OwnerInfrastructureFailureKind, detail: string): OwnerInfrastructureFailure => ({ kind, detail });

// ---------------------------------------------------------------------------
// Real-workspace reads
// ---------------------------------------------------------------------------

/**
 * A repository-relative path's text, its absence, or why the filesystem
 * refused it. `absent` is only "not there": an absence errno, not a regular
 * file, or a path resolving outside the repository. A file the filesystem
 * refuses for any other reason is `unreadable`, never absent, so it can never
 * pass for a missing sibling. Never throws.
 */
export function readRepositoryText(root: CanonicalRepositoryRoot, path: string): ModuleRead {
  const absolute = posix.join(root, path);
  try {
    if (!statSync(absolute).isFile()) return MODULE_ABSENT;
    const real = realpathSync.native(absolute);
    if (!real.startsWith(`${root}/`)) return MODULE_ABSENT;
    return { kind: "text", text: readFileSync(real, "utf-8") };
  } catch (cause) {
    if (isAbsence(cause)) return MODULE_ABSENT;
    return { kind: "unreadable", failure: infrastructure("repository-file-unreadable", `${path} cannot be read: ${describeCause(cause)}`) };
  }
}

// ---------------------------------------------------------------------------
// The base
// ---------------------------------------------------------------------------

function gitText(root: CanonicalRepositoryRoot, args: readonly string[]): DomainResult<string, string> {
  try {
    return success(runGit(["-C", root, ...args], { output: "text" }));
  } catch (cause) {
    return failure(`git ${args[0] ?? ""} failed: ${describeCause(cause)}`);
  }
}

type ResolvableBase = Exclude<WaveBase, { readonly kind: "owner-unchanged" }>;

/** The commit `waveBaseOf` chose, resolved in the real repository: the one start, or the octopus merge-base of several. */
export function resolveWaveBase(root: CanonicalRepositoryRoot, owner: string, base: ResolvableBase): DomainResult<string, OwnerInfrastructureFailure> {
  const shas = base.kind === "commit" ? [base.sha] : base.shas;
  const resolved = base.kind === "commit"
    ? gitText(root, ["rev-parse", "--verify", "--quiet", `${base.sha}^{commit}`])
    : gitText(root, ["merge-base", "--octopus", ...base.shas]);
  return resolved.ok && resolved.value.trim() !== ""
    ? success(resolved.value.trim())
    : failure(infrastructure("missing-wave-base", `the Wave base of ${owner} (${shas.join(", ")}) cannot be resolved${resolved.ok ? "" : `: ${resolved.error}`}`));
}

/** The owner's text at the Wave base, or null when the owner did not exist there (a new file: every line changed). */
export function ownerAtBase(root: CanonicalRepositoryRoot, base: string, owner: string): DomainResult<string | null, OwnerInfrastructureFailure> {
  const listed = gitText(root, ["ls-tree", "-z", base, "--", owner]);
  if (!listed.ok) return failure(infrastructure("missing-wave-base", `${owner} at the Wave base ${base} cannot be listed: ${listed.error}`));
  const entry = ownerAtBaseEntry(listed.value);
  if (entry.kind === "absent") return success(null);
  if (entry.kind === "not-a-file") return failure(infrastructure("missing-wave-base", `${owner} at the Wave base ${base} is not a file`));
  const blob = gitText(root, ["cat-file", "blob", entry.blob]);
  return blob.ok ? success(blob.value) : failure(infrastructure("missing-wave-base", `${owner} at the Wave base ${base} cannot be read: ${blob.error}`));
}

// ---------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------

/**
 * One runner execution as the run the classifiers read. A runner that could
 * not run the command to an observed end (refused authority, unconfirmed
 * containment, a surviving process tree) never produced a report this check
 * may read, so it is the run that could not start, never a report.
 */
export function matrixTestRunOf(execution: CommandExecutionResult, elapsedMs: number): MatrixTestRun {
  if (!execution.ok) return { kind: "spawn-failed", message: `${execution.error.kind}: ${execution.error.message}` };
  const value = execution.value.execution;
  if (value.kind === "spawn-failed") return { kind: "spawn-failed", message: value.process.message };
  if (value.process.timedOut) return { kind: "timed-out", elapsedMs };
  const report = value.report;
  return {
    kind: "exited",
    exitCode: value.process.exitCode,
    signal: value.process.signal,
    report: "outcome" in report ? { kind: "produced", bytes: report.bytes }
      : report.kind === "unreadable" ? { kind: "unreadable", reason: report.message }
      : { kind: "missing" },
  };
}

export type MatrixTestCommand = Extract<AuthorizedWaveCompletionCheck, { readonly kind: "project-command" }>;

/**
 * The frozen runner's command over one file alone (the Wave Gate's matrix
 * test, or one of a Task's implementation files), formed by
 * `affectedRunnerCheck` and re-authorized with its time limit clamped by
 * `mutantTimeoutMs`: no command text ever comes from the plan.
 */
export function matrixTestCommand(runner: AffectedRunner, file: string): DomainResult<MatrixTestCommand, string> {
  const formed = affectedRunnerCheck(runner, [file]);
  if (!formed.ok) return failure(formed.error.errors.join("; "));
  const clamped = parseAuthorizedWaveCompletionCheck({ ...formed.value, timeoutMs: mutantTimeoutMs(formed.value.timeoutMs) });
  if (!clamped.ok) return failure(clamped.error.errors.join("; "));
  return clamped.value.kind === "project-command" ? success(clamped.value) : failure("the clamped runner command is not a project command");
}

/** One execution of `command` in the isolated workspace, with the workspace's one rewritable file as `owner` says. */
export async function runOnce(workspace: MutationWorkspace, command: MatrixTestCommand, owner: OwnerVariant): Promise<MatrixTestRun> {
  return workspace.runWithOwner(owner, async (at) => {
    const started = Date.now();
    const execution = await runProjectCommandAt(command, at);
    return matrixTestRunOf(execution, Date.now() - started);
  });
}
