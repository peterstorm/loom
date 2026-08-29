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
 * Still NOT the same boundary as `repositoryContext` above: that one collects
 * root and exact HEAD through two fixed-argv Git observations and returns one
 * typed result. This one answers only "where do my commands run", and both now
 * resolve against the live environment rather than one captured at module load.
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

// Assertion evidence needs lexical state from the complete postimage. A normal
// three-line hunk cannot prove whether an added line is inside a multiline
// literal opened outside the hunk.
const FULL_POSTIMAGE_CONTEXT = "--unified=2147483647";

/** Diff specific files (unstaged), retaining complete postimage context. */
export function diffFiles(files: string[]): GitDiffResult {
  return files.length === 0
    ? { ok: true, diff: "" }
    : diffArgs(["diff", FULL_POSTIMAGE_CONTEXT, "--", ...files]);
}

/** Diff specific files (staged), retaining complete postimage context. */
export function diffFilesStaged(files: string[]): GitDiffResult {
  return files.length === 0
    ? { ok: true, diff: "" }
    : diffArgs(["diff", "--cached", FULL_POSTIMAGE_CONTEXT, "--", ...files]);
}

/** Diff committed changes from one baseline, retaining complete postimages. */
export function diffFilesSince(revision: string, files: string[]): GitDiffResult {
  return files.length === 0
    ? { ok: true, diff: "" }
    : diffArgs(["diff", FULL_POSTIMAGE_CONTEXT, revision, "HEAD", "--", ...files]);
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
      diff: execFileSync("git", ["diff", "--no-index", FULL_POSTIMAGE_CONTEXT, "/dev/null", file], {
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

type AddedExecutableLine = Readonly<{ path: string | null; code: string }>;

const isTestSourcePath = (path: string): boolean =>
  /(?:^|\/)(?:tests?|__tests__|spec)\//.test(path) ||
  /(?:Test|Tests|Spec)\.java$/.test(path) ||
  /(?:^|\/)(?:test_[^/]+|[^/]+_test)\.py$/.test(path) ||
  /\.(?:test|spec)\.[jt]sx?$/.test(path) ||
  /\.rs$/.test(path);

const languageOfTestSource = (path: string | null): "java" | "ts" | "python" | "rust" | "unknown" | null => {
  if (path === null) return null; // Headerless synthetic diff compatibility.
  if (!isTestSourcePath(path)) return "unknown";
  if (path.endsWith(".java")) return "java";
  if (/\.[jt]sx?$/.test(path)) return "ts";
  if (path.endsWith(".py")) return "python";
  if (path.endsWith(".rs")) return "rust";
  return "unknown";
};

const matchingParenthesis = (code: string, open: number): number | null => {
  let depth = 1;
  for (let index = open + 1; index < code.length; index += 1) {
    if (code[index] === "(") depth += 1;
    if (code[index] === ")") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return null;
};

const hasTypeScriptTestCall = (code: string): boolean => {
  const calls = /(?:^|\s)(?:it|test)(?:\.(?:each|concurrent))*\s*\(/g;
  for (const match of code.matchAll(calls)) {
    const start = match.index ?? 0;
    const prefix = code.slice(0, start).trimEnd();
    // A declaration named `test` has the same local token shape as a call once
    // strings/comments are projected away. Its preceding `function` keyword is
    // the grammar distinction that prevents helper declarations becoming test
    // evidence.
    if (/\bfunction\s*\*?\s*$/.test(prefix)) continue;
    const open = start + match[0].lastIndexOf("(");
    const close = matchingParenthesis(code, open);
    // Class/object method declarations are followed by a body block. Runner
    // invocations end as expressions; their callback block is nested inside
    // the invocation's parentheses.
    if (close !== null && code.slice(close + 1).trimStart().startsWith("{")) continue;
    return true;
  }
  return false;
};

/** Heuristically count added executable test declarations in a diff string (pure). */
export function countNewTests(diffContent: string): TestCount {
  const lines = executableAddedLines(diffContent);
  let java = 0;
  let ts = 0;
  let python = 0;
  let rust = 0;

  for (const { path, code } of lines) {
    const language = languageOfTestSource(path);
    if ((language === null || language === "java") && /@(Test|Property|ParameterizedTest)\b/.test(code)) java++;
    if ((language === null || language === "ts") && hasTypeScriptTestCall(code)) ts++;
    // Python test classes are only collection containers; executable evidence
    // is a test_* function or method. Counting the class declaration itself
    // accepts an empty helper-only class that pytest collects as zero tests.
    if ((language === null || language === "python") && /\bdef\s+test_/.test(code)) python++;
    if ((language === null || language === "rust") && /#\[test\]/.test(code)) rust++;
  }

  return { java, ts, python, rust, total: java + ts + python + rust };
}

type AssertionQuote = "'" | '"' | "`" | "'''" | '"""' | null;
type JsxAttributeQuote = "'" | '"' | null;

type AssertionLexicalState = Readonly<{
  blockCommentDepth: number;
  quote: AssertionQuote;
  rustRawStringHashes: number | null;
  jsxDepth: number;
  jsxInTag: boolean;
  jsxTagClosing: boolean;
  jsxAttributeQuote: JsxAttributeQuote;
  jsxExpressionDepth: number;
  jsxExpressionOwnerDepth: number;
}>;

const INITIAL_ASSERTION_STATE: AssertionLexicalState = Object.freeze({
  blockCommentDepth: 0,
  quote: null,
  rustRawStringHashes: null,
  jsxDepth: 0,
  jsxInTag: false,
  jsxTagClosing: false,
  jsxAttributeQuote: null,
  jsxExpressionDepth: 0,
  jsxExpressionOwnerDepth: 0,
});

const isTripleQuote = (quote: AssertionQuote): quote is "'''" | '"""' =>
  quote === "'''" || quote === '"""';

const isEscapedAt = (line: string, index: number): boolean => {
  let backslashes = 0;
  for (let cursor = index - 1; cursor >= 0 && line[cursor] === "\\"; cursor -= 1) backslashes += 1;
  return backslashes % 2 === 1;
};

const nonWhitespaceBefore = (line: string, index: number): string | null => {
  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    if (!/\s/.test(line[cursor]!)) return line[cursor]!;
  }
  return null;
};

const nonWhitespaceAfter = (line: string, index: number): string | null => {
  for (let cursor = index + 1; cursor < line.length; cursor += 1) {
    if (!/\s/.test(line[cursor]!)) return line[cursor]!;
  }
  return null;
};

/** Find the closing `>` of a TS generic list, ignoring nested generics and quoted type literals. */
const matchingGenericClose = (line: string, index: number): number | null => {
  let depth = 1;
  let quote: "'" | '"' | "`" | null = null;
  let escaped = false;
  for (let cursor = index + 1; cursor < line.length; cursor += 1) {
    const char = line[cursor]!;
    if (quote !== null) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === "'" || char === '"' || char === "`") {
      quote = char;
    } else if (char === "<") {
      depth += 1;
    } else if (char === ">" && line[cursor - 1] !== "=") {
      depth -= 1;
      if (depth === 0) return cursor;
    }
  }
  return null;
};

/** Detect a TSX generic-arrow prefix without treating it as a root JSX tag. */
const beginsTsxGenericParameters = (line: string, index: number): boolean => {
  const close = matchingGenericClose(line, index);
  const candidate = line.slice(index + 1, close ?? undefined);
  if (!/^[A-Za-z_$][\w$]*(?:\s+extends\b|\s*=|\s*,)/.test(candidate)) return false;
  return close === null || nonWhitespaceAfter(line, close) === "(";
};

/** A root TSX tag can only begin where an expression may begin, never at an operator's `>`. */
const beginsRootJsxTag = (line: string, index: number, projectedCode: string): boolean => {
  if (line[index] !== "<" || beginsTsxGenericParameters(line, index)) return false;
  const next = nonWhitespaceAfter(line, index);
  if (next === null || !/[A-Za-z_$>]/.test(next)) return false;
  const previous = nonWhitespaceBefore(line, index);
  return previous === null || /[=([{,:;!?]|>/.test(previous) ||
    /(?:^|\W)(?:return|yield)\s*$/.test(projectedCode.trimEnd());
};

const followsControlFlowCondition = (code: string): boolean => {
  const trimmed = code.trimEnd();
  if (!trimmed.endsWith(")")) return false;
  let depth = 0;
  for (let cursor = trimmed.length - 1; cursor >= 0; cursor -= 1) {
    const char = trimmed[cursor]!;
    if (char === ")") depth += 1;
    else if (char === "(") {
      depth -= 1;
      if (depth === 0) {
        return /(?:^|\W)(?:if|while|for)\s*$/.test(trimmed.slice(0, cursor));
      }
    }
  }
  return false;
};

const canBeginRegexLiteral = (code: string): boolean => {
  const trimmed = code.trimEnd();
  if (trimmed === "" || /[([{,:;=!?&|+*%^~<>}\-]$/.test(trimmed)) return true;
  if (followsControlFlowCondition(trimmed)) return true;
  return /(?:^|\s)(?:return|case|throw|else|do|yield|await|typeof|instanceof|in|of|delete|void|new)$/.test(trimmed);
};

const beginsRustRawString = (line: string, index: number): Readonly<{ length: number; hashes: number }> | null => {
  if (index > 0 && /[A-Za-z0-9_]/.test(line[index - 1]!)) return null;
  const match = /^(?:br|rb|r)(#*)"/.exec(line.slice(index));
  return match === null ? null : Object.freeze({ length: match[0].length, hashes: match[1]!.length });
};

/** Project executable code while retaining language lexical and TSX structure across lines. */
function assertionCodeLine(
  line: string,
  initial: AssertionLexicalState,
  path: string | null,
): Readonly<{ code: string; state: AssertionLexicalState }> {
  let blockCommentDepth = initial.blockCommentDepth;
  let quote = initial.quote;
  let rustRawStringHashes = initial.rustRawStringHashes;
  let regexLiteral = false;
  let regexCharacterClass = false;
  let jsxDepth = initial.jsxDepth;
  let jsxInTag = initial.jsxInTag;
  let jsxTagClosing = initial.jsxTagClosing;
  let jsxAttributeQuote = initial.jsxAttributeQuote;
  let jsxExpressionDepth = initial.jsxExpressionDepth;
  let jsxExpressionOwnerDepth = initial.jsxExpressionOwnerDepth;
  let escaped = false;
  let code = "";
  const isTsx = path !== null && /\.[jt]sx$/.test(path);
  const language = languageOfTestSource(path);

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]!;
    const next = line[index + 1];
    const inJsxStructure = isTsx && jsxDepth > 0 &&
      (jsxExpressionDepth === 0 || jsxDepth > jsxExpressionOwnerDepth);

    if (inJsxStructure) {
      if (jsxInTag) {
        if (jsxAttributeQuote !== null) {
          if (char === jsxAttributeQuote) jsxAttributeQuote = null;
          continue;
        }
        if (char === "'" || char === '"') {
          jsxAttributeQuote = char;
          continue;
        }
        if (char === "{") {
          jsxExpressionDepth = 1;
          jsxExpressionOwnerDepth = jsxDepth;
          code += char;
          continue;
        }
        if (char === ">") {
          const selfClosing = nonWhitespaceBefore(line, index) === "/";
          if (jsxTagClosing || selfClosing) jsxDepth = Math.max(0, jsxDepth - 1);
          jsxInTag = false;
          jsxTagClosing = false;
        }
        continue;
      }
      if (char === "{") {
        jsxExpressionDepth = 1;
        jsxExpressionOwnerDepth = jsxDepth;
        code += char;
        continue;
      }
      if (char === "<") {
        jsxTagClosing = nonWhitespaceAfter(line, index) === "/";
        if (!jsxTagClosing) jsxDepth += 1;
        jsxInTag = true;
      }
      continue;
    }

    if (regexLiteral) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === "[") {
        regexCharacterClass = true;
      } else if (char === "]") {
        regexCharacterClass = false;
      } else if (char === "/" && !regexCharacterClass) {
        regexLiteral = false;
      }
      continue;
    }
    if (rustRawStringHashes !== null) {
      const closing = `"${"#".repeat(rustRawStringHashes)}`;
      if (line.startsWith(closing, index)) {
        rustRawStringHashes = null;
        index += closing.length - 1;
      }
      continue;
    }
    if (blockCommentDepth > 0) {
      if (char === "/" && next === "*" && (language === "rust" || language === null)) {
        blockCommentDepth += 1;
        index += 1;
      } else if (char === "*" && next === "/") {
        blockCommentDepth -= 1;
        index += 1;
      }
      continue;
    }
    if (quote !== null) {
      if (isTripleQuote(quote)) {
        if (line.startsWith(quote, index) && !isEscapedAt(line, index)) {
          quote = null;
          index += 2;
        }
      } else if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === quote) {
        quote = null;
      }
      continue;
    }
    if (char === "/" && next === "*") {
      blockCommentDepth = 1;
      index += 1;
      continue;
    }
    if (char === "/" && next === "/") break;
    if ((language === "ts" || language === null) && char === "/" && canBeginRegexLiteral(code)) {
      regexLiteral = true;
      regexCharacterClass = false;
      continue;
    }
    if (language === "python" && char === "#") break;
    if (language === null && char === "#" && next !== "[") break;
    const triple = line.slice(index, index + 3);
    if (triple === "'''" || triple === '"""') {
      quote = triple;
      index += 2;
      continue;
    }
    if (language === "rust" || language === null) {
      const rawString = beginsRustRawString(line, index);
      if (rawString !== null) {
        rustRawStringHashes = rawString.hashes;
        index += rawString.length - 1;
        continue;
      }
    }
    if (char === "'" || char === '"' || char === "`") {
      quote = char;
      continue;
    }
    if (isTsx && beginsRootJsxTag(line, index, code)) {
      jsxDepth += 1;
      jsxInTag = true;
      jsxTagClosing = false;
      continue;
    }
    if (isTsx && jsxExpressionDepth > 0) {
      if (char === "{") jsxExpressionDepth += 1;
      if (char === "}") jsxExpressionDepth -= 1;
    }
    code += char;
  }
  // Rust ordinary and byte strings may cross physical lines. A trailing
  // backslash continues ordinary strings in JS/TS and Python; otherwise
  // non-Rust ordinary quotes terminate at the physical line.
  const continuedOrdinaryQuote = escaped &&
    (language === "ts" || language === "python" || language === null);
  if (quote === "'" && !continuedOrdinaryQuote) quote = null;
  if (quote === '"' && language !== "rust" && !continuedOrdinaryQuote) quote = null;
  const state = Object.freeze({
    blockCommentDepth,
    quote,
    rustRawStringHashes,
    jsxDepth,
    jsxInTag,
    jsxTagClosing,
    jsxAttributeQuote,
    jsxExpressionDepth,
    jsxExpressionOwnerDepth,
  });
  return Object.freeze({ code, state });
}

/** Project path-bound added executable code from complete-postimage patch bytes. */
function executableAddedLines(diffContent: string): readonly AddedExecutableLine[] {
  let state = INITIAL_ASSERTION_STATE;
  let path: string | null = null;
  let insidePatch = false;
  const lines: AddedExecutableLine[] = [];
  for (const diffLine of diffContent.split("\n")) {
    if (diffLine.startsWith("diff --git ")) {
      state = INITIAL_ASSERTION_STATE;
      path = null;
      insidePatch = true;
      continue;
    }
    if (diffLine.startsWith("+++ b/") && !diffLine.includes("\t")) {
      path = diffLine.slice("+++ b/".length);
      continue;
    }
    // Lexical state follows the complete postimage: removed lines do not exist
    // there, and each file boundary above starts an independent token stream.
    const isSourceLine = diffLine.startsWith("+") || diffLine.startsWith(" ");
    if (!isSourceLine) continue;
    const parsed = assertionCodeLine(diffLine.slice(1), state, path);
    state = parsed.state;
    if (diffLine.startsWith("+") && !diffLine.startsWith("+++") && (!insidePatch || path !== null)) {
      lines.push(Object.freeze({ path, code: parsed.code }));
    }
  }
  return Object.freeze(lines);
}

/** Count executable assertions in added diff lines (pure). */
export function countAssertions(diffContent: string): number {
  let count = 0;

  for (const { path, code } of executableAddedLines(diffContent)) {
    const language = languageOfTestSource(path);
    // Match at most one per line to avoid cross-language double-counting.
    if ((language === null || language === "java") && /(assertThat|assertEquals|assertNotNull|assertThrows|verify)\s*\(/.test(code)) { count++; continue; }
    if ((language === null || language === "ts") && /(expect\s*\(|\.should\.)/.test(code)) { count++; continue; }
    if ((language === null || language === "python") && /(assert\w*\(|assert [^=]|self\.assert|pytest\.raises)/.test(code)) { count++; continue; }
    if ((language === null || language === "rust") && /(assert(_eq)?!|assert_ne!)/.test(code)) { count++; continue; }
  }

  return count;
}

/** Pure filter: given a list of file paths, return those that look like test files */
export function filterTestFiles(files: string[]): string[] {
  return files.filter(isTestSourcePath);
}
