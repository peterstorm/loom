/**
 * Git utilities — pure functions for test counting, thin wrappers for I/O
 * Uses node:child_process (bun-compatible) — execFileSync for user input, execSync for fixed commands
 */

import { execSync, execFileSync } from "node:child_process";

/** Resolve git repo root: CLAUDE_PROJECT_DIR > git rev-parse > cwd */
function resolveRepoRoot(): string | undefined {
  if (process.env.CLAUDE_PROJECT_DIR) return process.env.CLAUDE_PROJECT_DIR;
  try {
    return execSync("git rev-parse --show-toplevel", { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim() || undefined;
  } catch {
    return undefined;
  }
}

const repoRoot = resolveRepoRoot();

/** Run a fixed git command (no user input in args) */
function exec(cmd: string): string {
  try {
    return execSync(cmd, { encoding: "utf-8", cwd: repoRoot, stdio: ["pipe", "pipe", "pipe"] });
  } catch (e: unknown) {
    const stderr = e && typeof e === "object" && "stderr" in e ? String((e as { stderr: unknown }).stderr) : "";
    if (stderr) process.stderr.write(`git warning: ${stderr.trim()}\n`);
    return "";
  }
}

/** Run git with array args (safe against shell injection) */
function execArgs(args: string[]): string {
  try {
    return execFileSync("git", args, { encoding: "utf-8", cwd: repoRoot, stdio: ["pipe", "pipe", "pipe"] });
  } catch {
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
  } catch {
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

/** Check if file is tracked by git */
export function isTracked(file: string): boolean {
  try {
    execFileSync("git", ["ls-files", "--error-unmatch", file], { cwd: repoRoot, stdio: "ignore" });
    return true;
  } catch {
    return false;
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
    // git diff --no-index exits 1 when files differ (always for new files)
    if (e && typeof e === "object" && "stdout" in e) {
      return String((e as { stdout: unknown }).stdout ?? "");
    }
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
