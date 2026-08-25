/**
 * Git utilities — pure functions for test counting, thin wrappers for I/O
 * Uses node:child_process (bun-compatible) — execFileSync for user input, execSync for fixed commands
 */

import { execSync, execFileSync } from "node:child_process";
import { isExactGitSha } from "../core/git-sha";

/**
 * Resolve the git repository root FRESH: CLAUDE_PROJECT_DIR > git rev-parse >
 * undefined (caller falls back to cwd).
 *
 * The shared resolver for callers that need a repository ROOT. It was
 * previously duplicated in `utils/agent-definition.ts` with a bare `catch {}`,
 * so the same failure was loud here and invisible there — and an unresolved
 * root there silently drops repository-relative agent-definition candidates.
 * One implementation, one diagnostic.
 *
 * It is deliberately NOT the only path to `git` in the engine, and claiming
 * otherwise would be false: `utils/artifact-baseline.ts` and several
 * handlers/orchestration modules shell out directly because they need failures
 * to THROW, where this module's `exec`/`execArgs` warn and return `""`. Two
 * failure contracts, chosen per call site; a caller that wants the warning
 * contract uses this module.
 *
 * `context` names the caller so a stderr line identifies which resolution
 * failed, not just that one did.
 */
export function resolveRepositoryRoot(context = "repository root"): string | undefined {
  if (process.env.CLAUDE_PROJECT_DIR) return process.env.CLAUDE_PROJECT_DIR;
  try {
    return execSync("git rev-parse --show-toplevel", { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim() || undefined;
  } catch (error) {
    // Never silent: every downstream helper runs against cwd: undefined and
    // its failures read as "no tests written" — the one indistinguishable
    // lie this module must not tell without a trace.
    process.stderr.write(
      `loom: git rev-parse --show-toplevel failed at ${context} (${error instanceof Error ? error.message : String(error)}) — ` +
        `remaining git helpers run against process.cwd and their failures will read as absent evidence\n`,
    );
    return undefined;
  }
}

/**
 * The resolution this module's own git commands run from, resolved FRESH.
 *
 * It used to be `const repoRoot = resolveRepositoryRoot()` — one resolution
 * captured at import time, inherited by every helper here for the life of the
 * process. `repositoryContext` below already refused to inherit such a root,
 * and that refusal is the correct rule; it was simply not applied to the rest
 * of the file. In a worktree-driven engine, whichever caller imports this
 * module first decided the root for every later caller.
 *
 * Memoized on the resolution key (`CLAUDE_PROJECT_DIR`, else the cwd) rather
 * than on nothing: repeat calls under an unchanged environment cost no extra
 * `git rev-parse`, and a changed environment re-resolves instead of silently
 * answering for the old one.
 */
let rootCache: Readonly<{ key: string; root: string | undefined }> | null = null;

function currentRepoRoot(context = "git helper"): string | undefined {
  const key = process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
  if (rootCache !== null && rootCache.key === key) return rootCache.root;
  const root = resolveRepositoryRoot(context);
  rootCache = Object.freeze({ key, root });
  return root;
}

export type GitRepositoryContext =
  | Readonly<{ ok: true; root: string; headSha: string }>
  | Readonly<{ ok: false; error: string }>;

function commandFailure(error: unknown): string {
  if (!error || typeof error !== "object") return String(error);
  const detail = error as { code?: unknown; status?: unknown; stderr?: unknown; message?: unknown };
  const code = typeof detail.code === "string" ? detail.code : null;
  const status = typeof detail.status === "number" ? `exit ${detail.status}` : null;
  const stderr = detail.stderr === undefined ? "" : String(detail.stderr).trim();
  const message = typeof detail.message === "string" ? detail.message : "git command failed";
  return [code, status, stderr || message].filter((part): part is string => part !== null && part !== "").join(": ");
}

/** Resolve the repository root and exact HEAD as one typed proof boundary. */
export function repositoryContext(): GitRepositoryContext {
  const cwd = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  try {
    const root = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    if (root === "") return { ok: false, error: `git returned an empty repository root for ${cwd}` };
    const headSha = execFileSync("git", ["rev-parse", "--verify", "HEAD"], {
      cwd: root,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    if (!isExactGitSha(headSha)) {
      return { ok: false, error: `git returned an invalid HEAD for ${root}: ${JSON.stringify(headSha)}` };
    }
    return { ok: true, root, headSha };
  } catch (error) {
    return { ok: false, error: `cannot resolve repository root and HEAD from ${cwd}: ${commandFailure(error)}` };
  }
}

/**
 * The repository root this module's own git commands run from — the `cwd` for
 * `exec`/`execArgs` and the base every path helper here resolves against.
 *
 * Still NOT the same boundary as `repositoryContext` above: that one resolves
 * root AND exact HEAD together in one `execFileSync` pass, because a proof
 * needs both to come from a single observation. This one answers only "where
 * do my commands run", and both now resolve against the live environment
 * rather than one captured at module load.
 */
export function repositoryRoot(): string | undefined {
  return currentRepoRoot("repositoryRoot");
}

/** Run a fixed git command (no user input in args) */
function exec(cmd: string): string {
  try {
    return execSync(cmd, { encoding: "utf-8", cwd: currentRepoRoot("exec"), stdio: ["pipe", "pipe", "pipe"] });
  } catch (e: unknown) {
    const stderr = e && typeof e === "object" && "stderr" in e ? String((e as { stderr: unknown }).stderr) : "";
    // Warn even when stderr is empty: a failure without stderr (spawn ENOENT,
    // killed process, permission error) must not be the silent one.
    process.stderr.write(`git warning: ${stderr.trim() || (e instanceof Error ? e.message : String(e))}\n`);
    return "";
  }
}

/** Run git with array args (safe against shell injection) */
function execArgs(args: string[]): string {
  try {
    return execFileSync("git", args, { encoding: "utf-8", cwd: currentRepoRoot("execArgs"), stdio: ["pipe", "pipe", "pipe"] });
  } catch (error: unknown) {
    const detail = error && typeof error === "object" ? error as { stderr?: unknown; status?: unknown } : {};
    const stderr = detail.stderr === undefined ? "" : String(detail.stderr).trim();
    const status = typeof detail.status === "number" ? ` (exit ${detail.status})` : "";
    const command = args.map((arg) => JSON.stringify(arg)).join(" ");
    process.stderr.write(
      `git warning: git ${command} failed${status}${stderr === "" ? "" : `: ${stderr}`}\n`,
    );
    return "";
  }
}

export type GitHeadObservation =
  | Readonly<{ ok: true; headSha: string }>
  | Readonly<{ ok: false; error: string }>;

/** Fixed-argv exact HEAD observation for implementation authority checks. */
export function observeExactHead(root: string): GitHeadObservation {
  try {
    const headSha = execFileSync("git", ["rev-parse", "--verify", "HEAD"], {
      cwd: root,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    return isExactGitSha(headSha)
      ? { ok: true, headSha }
      : { ok: false, error: `git returned an invalid HEAD for ${root}: ${JSON.stringify(headSha)}` };
  } catch (error) {
    return { ok: false, error: `cannot read Git HEAD for ${root}: ${commandFailure(error)}` };
  }
}

/** Get current HEAD SHA through the legacy warning-contract adapter. */
export function headSha(): string | null {
  const result = exec("git rev-parse HEAD").trim();
  return result || null;
}

/** Check if in a git repo */
export function isGitRepo(): boolean {
  const root = currentRepoRoot("isGitRepo");
  try {
    execSync("git rev-parse --git-dir", { cwd: root, stdio: "ignore" });
    return true;
  } catch (error) {
    process.stderr.write(
      `loom: isGitRepo could not verify a git repository` +
        `${root === undefined ? " (repo root unresolved)" : ` at ${root}`}: ` +
        `${error instanceof Error ? error.message : String(error)} — new-test evidence will read as 'no tests written'\n`,
    );
    return false;
  }
}

/** Get default branch name */
export function defaultBranch(): string {
  const ref = exec("git symbolic-ref refs/remotes/origin/HEAD").trim();
  return ref.replace(/^refs\/remotes\/origin\//, "") || "main";
}

/** Get merge base between HEAD and default branch */
export function mergeBase(branch: string): string | null {
  const result = execArgs(["merge-base", "HEAD", `origin/${branch}`]).trim();
  return result || null;
}

/** Get git diff between two refs */
export function diff(from?: string, to?: string): string {
  if (from && to) return execArgs(["diff", from, to]);
  if (from) return execArgs(["diff", from]);
  return exec("git diff");
}

export type GitDiffResult =
  | Readonly<{ ok: true; diff: string }>
  | Readonly<{ ok: false; error: string }>;

/** Git diff proof boundary: command failure is not an empty diff. */
function diffArgs(args: readonly string[]): GitDiffResult {
  const root = currentRepoRoot("diffArgs");
  if (root === undefined) return { ok: false, error: "cannot collect a diff outside a Git repository" };
  try {
    return {
      ok: true,
      diff: execFileSync("git", [...args], {
        encoding: "utf-8",
        cwd: root,
        stdio: ["pipe", "pipe", "pipe"],
      }),
    };
  } catch (error) {
    return {
      ok: false,
      error: `git ${args.map((arg) => JSON.stringify(arg)).join(" ")} failed: ${commandFailure(error)}`,
    };
  }
}

/** Diff specific files (unstaged). */
export function diffFiles(files: string[]): GitDiffResult {
  return files.length === 0 ? { ok: true, diff: "" } : diffArgs(["diff", "--", ...files]);
}

/** Diff specific files (staged). */
export function diffFilesStaged(files: string[]): GitDiffResult {
  return files.length === 0 ? { ok: true, diff: "" } : diffArgs(["diff", "--cached", "--", ...files]);
}

/** Diff committed changes for specific files from one trusted task baseline. */
export function diffFilesSince(revision: string, files: string[]): GitDiffResult {
  return files.length === 0
    ? { ok: true, diff: "" }
    : diffArgs(["diff", revision, "HEAD", "--", ...files]);
}

export type GitTrackedResult =
  | Readonly<{ ok: true; tracked: boolean }>
  | Readonly<{ ok: false; error: string }>;

/**
 * Parse Git's tracking answer without collapsing infrastructure failure into
 * "untracked". `ls-files --error-unmatch` uses exit 1 for the one expected
 * negative answer; every other failure leaves tracking authority unknown.
 */
export function isTracked(file: string): GitTrackedResult {
  const root = currentRepoRoot("isTracked");
  if (root === undefined) return { ok: false, error: "cannot inspect tracking outside a Git repository" };
  try {
    execFileSync("git", ["ls-files", "--error-unmatch", "--", file], { cwd: root, stdio: "ignore" });
    return { ok: true, tracked: true };
  } catch (error) {
    const status = typeof error === "object" && error !== null && "status" in error
      ? (error as { status?: unknown }).status
      : undefined;
    return status === 1
      ? { ok: true, tracked: false }
      : { ok: false, error: `cannot determine whether ${JSON.stringify(file)} is tracked: ${commandFailure(error)}` };
  }
}

/** Diff untracked file against /dev/null without collapsing command failure. */
export function diffUntracked(file: string): GitDiffResult {
  const root = currentRepoRoot("diffUntracked");
  if (root === undefined) return { ok: false, error: "cannot diff an untracked file outside a Git repository" };
  try {
    return {
      ok: true,
      diff: execFileSync("git", ["diff", "--no-index", "/dev/null", file], {
        encoding: "utf-8",
        cwd: root,
        stdio: ["pipe", "pipe", "pipe"],
      }),
    };
  } catch (error: unknown) {
    // git diff --no-index exits 1 both for a real difference and for some
    // access failures. Only an actual patch is positive evidence.
    const detail = error && typeof error === "object"
      ? error as { status?: unknown; stdout?: unknown }
      : null;
    const stdout = detail?.stdout === undefined ? "" : String(detail.stdout);
    if (detail?.status === 1 && /^diff --git /m.test(stdout)) {
      return { ok: true, diff: stdout };
    }
    return {
      ok: false,
      error: `git diff --no-index ${JSON.stringify(file)} failed: ${commandFailure(error)}`,
    };
  }
}

// --- Pure functions for test evidence (no git calls) ---

export interface TestCount {
  readonly java: number;
  readonly ts: number;
  readonly python: number;
  readonly rust: number;
  readonly total: number;
}

/** Heuristically count added test and suite declarations in a diff string (pure). */
export function countNewTests(diffContent: string): TestCount {
  const lines = diffContent.split("\n");
  let java = 0;
  let ts = 0;
  let python = 0;
  let rust = 0;

  for (const line of lines) {
    if (!line.startsWith("+")) continue;
    if (/@(Test|Property|ParameterizedTest)\b/.test(line)) java++;
    if (/\s(it|test|describe)\(/.test(line)) ts++;
    if (/(def test_|class Test)/.test(line)) python++;
    if (/#\[test\]/.test(line)) rust++;
  }

  return { java, ts, python, rust, total: java + ts + python + rust };
}

/** Count assertions in a diff string (pure) */
export function countAssertions(diffContent: string): number {
  const lines = diffContent.split("\n");
  let count = 0;

  for (const line of lines) {
    if (!line.startsWith("+")) continue;
    // Match at most one per line to avoid cross-language double-counting
    if (/(assertThat|assertEquals|assertNotNull|assertThrows|verify\()/.test(line)) { count++; continue; }
    if (/(expect\(|toEqual|toBe|toHaveBeenCalled|toThrow|\.should\.)/.test(line)) { count++; continue; }
    if (/(assert\w*\(|assert [^=]|self\.assert|pytest\.raises)/.test(line)) { count++; continue; }
    if (/(assert(_eq)?!|assert_ne!)/.test(line)) { count++; continue; }
  }

  return count;
}

/** Pure filter: given a list of file paths, return those that look like test files */
export function filterTestFiles(files: string[]): string[] {
  return files.filter((f) =>
    // Match files in test directories at any depth
    /(?:^|\/)(?:tests?|__tests__|spec)\//.test(f) ||
    // Match files with test/spec suffix (e.g. foo.test.ts, bar.spec.js)
    /\.(?:test|spec)\.[jt]sx?$/.test(f)
  );
}
