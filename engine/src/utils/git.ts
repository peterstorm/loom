/**
 * Git utilities — pure functions for test counting, thin wrappers for I/O
 * Uses node:child_process (bun-compatible) — execFileSync for user input, execSync for fixed commands
 */

import { execSync, execFileSync } from "node:child_process";

/**
 * Resolve the git repository root FRESH: CLAUDE_PROJECT_DIR > git rev-parse >
 * undefined (caller falls back to cwd).
 *
 * The single resolver every caller shares. It was previously duplicated in
 * `utils/agent-definition.ts` with a bare `catch {}`, so the same failure was
 * loud here and invisible there — and an unresolved root there silently drops
 * repository-relative agent-definition candidates. One implementation, one
 * diagnostic.
 *
 * `context` names the caller so a stderr line identifies which resolution
 * failed, not just that one did.
 */
export function resolveRepositoryRoot(context = "module load"): string | undefined {
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

const repoRoot = resolveRepositoryRoot();

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
    if (!/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(headSha)) {
      return { ok: false, error: `git returned an invalid HEAD for ${root}: ${JSON.stringify(headSha)}` };
    }
    return { ok: true, root, headSha };
  } catch (error) {
    return { ok: false, error: `cannot resolve repository root and HEAD from ${cwd}: ${commandFailure(error)}` };
  }
}

/** Canonical repository root used by every git/path boundary in this process. */
export function repositoryRoot(): string | undefined {
  return repoRoot;
}

/** Run a fixed git command (no user input in args) */
function exec(cmd: string): string {
  try {
    return execSync(cmd, { encoding: "utf-8", cwd: repoRoot, stdio: ["pipe", "pipe", "pipe"] });
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
    return execFileSync("git", args, { encoding: "utf-8", cwd: repoRoot, stdio: ["pipe", "pipe", "pipe"] });
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

/** Get current HEAD SHA */
export function headSha(): string | null {
  const result = exec("git rev-parse HEAD").trim();
  return result || null;
}

/** Check if in a git repo */
export function isGitRepo(): boolean {
  try {
    execSync("git rev-parse --git-dir", { cwd: repoRoot, stdio: "ignore" });
    return true;
  } catch (error) {
    process.stderr.write(
      `loom: isGitRepo could not verify a git repository` +
        `${repoRoot === undefined ? " (repo root unresolved at module load)" : ` at ${repoRoot}`}: ` +
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

/** Get staged diff */
export function diffStaged(): string {
  return exec("git diff --cached");
}

/** Diff specific files (unstaged) */
export function diffFiles(files: string[]): string {
  if (files.length === 0) return "";
  return execArgs(["diff", "--", ...files]);
}

/** Diff specific files (staged) */
export function diffFilesStaged(files: string[]): string {
  if (files.length === 0) return "";
  return execArgs(["diff", "--cached", "--", ...files]);
}

/** Diff committed changes for specific files from one trusted task baseline. */
export function diffFilesSince(revision: string, files: string[]): string {
  if (files.length === 0) return "";
  return execArgs(["diff", revision, "HEAD", "--", ...files]);
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
  if (repoRoot === undefined) return { ok: false, error: "cannot inspect tracking outside a Git repository" };
  try {
    execFileSync("git", ["ls-files", "--error-unmatch", "--", file], { cwd: repoRoot, stdio: "ignore" });
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

/** Diff untracked file against /dev/null */
export function diffUntracked(file: string): string {
  try {
    return execFileSync("git", ["diff", "--no-index", "/dev/null", file], {
      encoding: "utf-8",
      cwd: repoRoot,
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (e: unknown) {
    // git diff --no-index exits 1 when files differ (always for new files) and
    // carries the diff on stdout — that is the expected answer, not a failure.
    if (e && typeof e === "object" && "status" in e && (e as { status?: unknown }).status === 1 &&
        "stdout" in e) {
      return String((e as { stdout: unknown }).stdout ?? "");
    }
    process.stderr.write(
      `loom: git diff --no-index ${JSON.stringify(file)} failed: ${e instanceof Error ? e.message : String(e)}\n`,
    );
    return "";
  }
}

// --- Pure functions for test evidence (no git calls) ---

export interface TestCount {
  java: number;
  ts: number;
  python: number;
  rust: number;
  total: number;
}

/** Count new test methods in a diff string (pure) */
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

/** List untracked files that look like test files (directories or suffixes) */
export function listUntrackedTestFiles(): string[] {
  const result = exec("git ls-files --others --exclude-standard").trim();
  if (!result) return [];
  return filterTestFiles(result.split("\n"));
}
