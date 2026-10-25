/**
 * The isolated workspace owner verification mutates (AD-8; FR-015, FR-016,
 * AS-016, AS-017). Every effect of mutant isolation lives here, and nothing
 * here decides an outcome:
 *
 * - `git worktree add --detach <mkdtemp> HEAD`, outside the repository, so the
 *   worktree shares the object store and costs one checkout.
 * - The reviewed workspace's uncommitted state is overlaid onto it: every
 *   changed, untracked-not-ignored and deleted path that
 *   `git status --porcelain=v2 -z --untracked-files=all` names is copied (or
 *   deleted) exactly, so the matrix test runs against the Wave's bytes.
 * - The repository root's and the runner cwd's `node_modules` are shared by
 *   symlink, never copied, and never written through.
 * - `runWithOwner` rewrites only the owner file, deletes the runner's stale
 *   report, runs, and restores the owner's original bytes afterwards, even
 *   when the run throws; a restore that fails after a throwing run keeps the
 *   run's throw as the cause.
 * - The worktree is removed (`git worktree remove --force`, then the directory
 *   itself, then `git worktree prune`) in `finally`, whatever the use did.
 *
 * Setup and removal failures are the named `worktree-failed` infrastructure
 * failure, returned as data; a throw from the use itself is rethrown after the
 * worktree is removed, so the caller decides what it means. When that removal
 * fails too, the rethrown error names both, with the use's throw as its
 * `cause`, so a leaked worktree is never silent.
 */

import {
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { failure, success, type DomainResult } from "../core/orchestration-contract/identity";
import { statusPaths } from "../core/owner-verification/status-paths";
import type { OwnerInfrastructureFailure } from "../core/owner-verification/types";
import { parseReviewPath } from "../core/review-packet";
import { GIT_PROBE_OUTPUT_LIMIT, spawnGit } from "../utils/git-execution-policy";
import { describeGitOutcome, gitExitedWith } from "../utils/git-spawn-outcome";
import { describeCause } from "../utils/describe-cause";
import { parseCanonicalRepositoryRoot, type CanonicalRepositoryRoot } from "../utils/workspace-digest";

/** What one isolated workspace is for: the real workspace, the one file a mutant rewrites, and the runner's report and cwd. */
export type MutationWorkspaceSpec = Readonly<{
  /** The real, reviewed workspace. It is only ever read. */
  repositoryRoot: CanonicalRepositoryRoot;
  /** Repository-relative: the only file a run rewrites. */
  ownerPath: string;
  /** Repository-relative: deleted before every run, so a stale report can never be read as this run's. */
  reportPath: string;
  /** Repository-relative, or "."; its `node_modules` is shared beside the root's. */
  runnerCwd: string;
}>;

export type MutationWorkspace = Readonly<{
  /** The worktree's canonical root: where the runner's cwd and report resolve. */
  root: CanonicalRepositoryRoot;
  /**
   * One run with the owner's bytes replaced by `ownerText` (or left as the
   * Wave's for `null`, the baseline), the report deleted first, and the
   * owner's original bytes restored afterwards, even when `execute` throws.
   */
  runWithOwner: <R>(ownerText: string | null, execute: (root: CanonicalRepositoryRoot) => Promise<R>) => Promise<R>;
}>;

type Step<T> = DomainResult<T, string>;


const worktreeFailed = (detail: string): OwnerInfrastructureFailure => ({ kind: "worktree-failed", detail });

/** One policy-bound Git command in `cwd`: its stdout, or why it failed. */
function git(cwd: string, args: readonly string[]): Step<Buffer> {
  const outcome = spawnGit(["-C", cwd, ...args], { maxBuffer: GIT_PROBE_OUTPUT_LIMIT * 64 });
  return gitExitedWith(outcome, [0])
    ? success(outcome.stdout)
    : failure(`git ${args[0] ?? ""} ${describeGitOutcome(outcome)}`);
}

/** A repository-relative path in canonical POSIX form, or why it is not one. */
function relativePath(raw: string, label: string): Step<string> {
  const parsed = parseReviewPath(raw, label);
  return parsed.ok ? success(parsed.value) : failure(parsed.errors.join("; "));
}

const absolute = (root: string, path: string): string => (path === "." ? root : join(root, ...path.split("/")));

// ---------------------------------------------------------------------------
// The overlay: every path the reviewed workspace differs from HEAD in
// ---------------------------------------------------------------------------

/** Make the worktree's `path` exactly what the reviewed workspace holds there: its bytes, its link, or nothing. */
function overlayPath(source: string, target: string, path: string): void {
  const trimmed = path.endsWith("/") ? path.slice(0, -1) : path;
  const from = absolute(source, trimmed);
  const to = absolute(target, trimmed);
  rmSync(to, { recursive: true, force: true });
  let stat;
  try {
    stat = lstatSync(from);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return;
    throw cause;
  }
  mkdirSync(dirname(to), { recursive: true });
  if (stat.isSymbolicLink()) symlinkSync(readlinkSync(from), to);
  else if (stat.isDirectory()) cpSync(from, to, { recursive: true, verbatimSymlinks: true });
  else if (stat.isFile()) copyFileSync(from, to);
  else throw new Error(`${trimmed} is neither a file, a directory nor a symlink`);
}

function overlay(source: CanonicalRepositoryRoot, target: string): Step<void> {
  const status = git(source, ["status", "--porcelain=v2", "-z", "--untracked-files=all"]);
  if (!status.ok) return status;
  const paths = statusPaths(status.value.toString("utf-8"));
  if (!paths.ok) return paths;
  try {
    for (const path of paths.value) overlayPath(source, target, path);
    return success(undefined);
  } catch (cause) {
    return failure(`overlaying the reviewed workspace failed: ${describeCause(cause)}`);
  }
}

/** Symlink each directory's `node_modules` from the real workspace; the links this created, for removal. */
function shareNodeModules(source: CanonicalRepositoryRoot, target: string, runnerCwd: string): Step<readonly string[]> {
  const links: string[] = [];
  try {
    for (const directory of [...new Set([".", runnerCwd])]) {
      const from = join(absolute(source, directory), "node_modules");
      const to = join(absolute(target, directory), "node_modules");
      if (!existsSync(from) || existsSync(to)) continue;
      mkdirSync(dirname(to), { recursive: true });
      symlinkSync(from, to);
      links.push(to);
    }
    return success(links);
  } catch (cause) {
    return failure(`sharing node_modules failed: ${describeCause(cause)}`);
  }
}

// ---------------------------------------------------------------------------
// Opening and removing the worktree
// ---------------------------------------------------------------------------

type Opened = Readonly<{ directory: string; links: readonly string[]; workspace: MutationWorkspace }>;

/** Remove the worktree: its node_modules links first (never followed), then Git's registration and the directory. Null when it is gone. */
function remove(repositoryRoot: CanonicalRepositoryRoot, directory: string, links: readonly string[]): string | null {
  const problems: string[] = [];
  for (const link of links) {
    try {
      unlinkSync(link);
    } catch (cause) {
      problems.push(`unlinking ${link} failed: ${describeCause(cause)}`);
    }
  }
  const removed = git(repositoryRoot, ["worktree", "remove", "--force", directory]);
  try {
    rmSync(directory, { recursive: true, force: true });
  } catch (cause) {
    problems.push(`removing ${directory} failed: ${describeCause(cause)}`);
  }
  const pruned = git(repositoryRoot, ["worktree", "prune"]);
  if (!removed.ok && !pruned.ok) problems.push(`${removed.error}; ${pruned.error}`);
  return problems.length === 0 && !existsSync(directory) ? null : problems.join("; ") || `${directory} still exists`;
}

/**
 * Rethrow `cause`, a run's own throw, after restoring the owner. When the
 * restore throws too, the rethrown error names both and keeps `cause` as its
 * cause, as `withMutationWorkspace` does for a failed removal.
 */
function restoreAndRethrow(restore: () => void, cause: unknown): never {
  try {
    restore();
  } catch (restoreFailure) {
    throw new Error(`${describeCause(cause)}; the owner's original bytes could not be restored afterwards: ${describeCause(restoreFailure)}`, { cause });
  }
  throw cause;
}

function workspaceAt(root: CanonicalRepositoryRoot, ownerPath: string, reportPath: string): MutationWorkspace {
  const owner = absolute(root, ownerPath);
  const report = absolute(root, reportPath);
  const original = existsSync(owner) ? Uint8Array.from(readFileSync(owner)) : null;
  const restore = (): void => {
    if (original === null) rmSync(owner, { force: true });
    else writeFileSync(owner, original);
  };
  return Object.freeze({
    root,
    runWithOwner: async <R>(ownerText: string | null, execute: (at: CanonicalRepositoryRoot) => Promise<R>): Promise<R> => {
      rmSync(report, { force: true });
      let value: R;
      try {
        if (ownerText !== null) {
          mkdirSync(dirname(owner), { recursive: true });
          writeFileSync(owner, ownerText);
        }
        value = await execute(root);
      } catch (cause) {
        return restoreAndRethrow(restore, cause);
      }
      restore();
      return value;
    },
  });
}

function open(spec: MutationWorkspaceSpec): DomainResult<Opened, OwnerInfrastructureFailure> {
  const ownerPath = relativePath(spec.ownerPath, "owner path");
  const reportPath = relativePath(spec.reportPath, "report path");
  const runnerCwd = spec.runnerCwd === "." ? success(".") : relativePath(spec.runnerCwd, "runner cwd");
  if (!ownerPath.ok || !reportPath.ok || !runnerCwd.ok) {
    return failure(worktreeFailed([ownerPath, reportPath, runnerCwd].flatMap((step) => step.ok ? [] : [step.error]).join("; ")));
  }

  let directory: string;
  try {
    directory = realpathSync.native(mkdtempSync(join(tmpdir(), "loom-owner-mutation-")));
  } catch (cause) {
    return failure(worktreeFailed(`the isolated copy's directory could not be made: ${describeCause(cause)}`));
  }
  const abandon = (detail: string, links: readonly string[] = []): DomainResult<Opened, OwnerInfrastructureFailure> => {
    const leftover = remove(spec.repositoryRoot, directory, links);
    return failure(worktreeFailed(leftover === null ? detail : `${detail}; cleanup: ${leftover}`));
  };

  const added = git(spec.repositoryRoot, ["worktree", "add", "--detach", directory, "HEAD"]);
  if (!added.ok) return abandon(`the isolated copy could not be made: ${added.error}`);
  const overlaid = overlay(spec.repositoryRoot, directory);
  if (!overlaid.ok) return abandon(overlaid.error);
  const shared = shareNodeModules(spec.repositoryRoot, directory, runnerCwd.value);
  if (!shared.ok) return abandon(shared.error);
  const root = parseCanonicalRepositoryRoot(directory);
  if (!root.ok) return abandon(`the isolated copy's root is not canonical: ${"message" in root.error ? root.error.message : root.error.kind}`, shared.value);
  try {
    return success({ directory, links: shared.value, workspace: workspaceAt(root.value, ownerPath.value, reportPath.value) });
  } catch (cause) {
    return abandon(`the isolated copy's owner could not be read: ${describeCause(cause)}`, shared.value);
  }
}

/**
 * Open one isolated workspace, hand it to `use`, and remove it in `finally`.
 * A copy that cannot be made or removed is `worktree-failed`; `use` never runs
 * on a copy that could not be made. A throwing `use` is rethrown, carrying the
 * removal failure in its message (and the original throw as `cause`) when the
 * copy could not be removed either.
 */
export async function withMutationWorkspace<T>(
  spec: MutationWorkspaceSpec,
  use: (workspace: MutationWorkspace) => Promise<T>,
): Promise<DomainResult<T, OwnerInfrastructureFailure>> {
  const opened = open(spec);
  if (!opened.ok) return opened;
  const { directory, links, workspace } = opened.value;
  let value: T;
  try {
    value = await use(workspace);
  } catch (cause) {
    const leftover = remove(spec.repositoryRoot, directory, links);
    if (leftover === null) throw cause;
    throw new Error(`${describeCause(cause)}; the isolated copy could not be removed afterwards: ${leftover}`, { cause });
  }
  const leftover = remove(spec.repositoryRoot, directory, links);
  return leftover === null ? success(value) : failure(worktreeFailed(`the isolated copy could not be removed: ${leftover}`));
}
