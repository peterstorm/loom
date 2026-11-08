/**
 * Programmatic rule: exhaustive-discriminant-branching
 *
 * A chain of `if (x.kind === "a") … else if (x.kind === "b") …` IS a switch on
 * a discriminated union, written in a form the compiler cannot check. Add a
 * variant to the union and every such chain silently stops covering it: no
 * error, no warning, just an unhandled case that falls through to whatever the
 * last branch does.
 *
 * `match(x).with(…).exhaustive()` from ts-pattern makes the omission a COMPILE
 * ERROR. So does a `switch` whose `default` arm binds the scrutinee to `never`
 * — the idiom `core/orchestration-contract/effects.ts` documents at length.
 * Either proof satisfies this rule; the rule is about totality, not about
 * which library you reach for.
 *
 * WHAT THIS DOES NOT FLAG, deliberately:
 *
 * One or two branches on a tag are guard clauses, and guard clauses are the
 * preferred shape (`rules/architecture.md`, and the distill catalog's "flatten
 * control flow"). Forcing `match` on a two-arm early return trades clarity for
 * ceremony and would make this rule noise that people disable. The threshold is
 * where an if-chain stops reading as a guard and starts reading as a switch.
 *
 * Detection is line-based (no AST, consistent with the rest of this linter), so
 * it recognises the SHAPE of a chain: consecutive branch lines comparing the
 * same `receiver.tag` against string literals.
 */

import type { Violation } from "../types";
import { makeViolation } from "../types";
import { isTestFile } from "./config";
import { EXHAUSTIVE_BRANCHING_BASELINE } from "./exhaustive-discriminant-branching-baseline";
import { baselineCounter, baselineKey, type Baseline } from "./baseline";

/** Branches on one tag at or above this count read as a switch, not a guard. */
export const DEFAULT_MAX_DISCRIMINANT_BRANCHES = 3;

/**
 * Lines a chain may span between consecutive branches.
 *
 * Without this, two unrelated guards on the same tag hundreds of lines apart
 * merge into one phantom "chain" — the rule's first draft reported exactly that
 * for two `task.status` guards at opposite ends of a file. A real if/else-if
 * chain is contiguous; its branches are separated only by their own bodies.
 */
const MAX_CHAIN_GAP = 10;

/** Tags that name a discriminated union in this codebase's vocabulary. */
export const DEFAULT_DISCRIMINANT_TAGS: readonly string[] = [
  "kind",
  "status",
  "verdict",
  "stage",
  "severity",
  "type",
];

/** `if (` / `} else if (` — the line shapes that open a branch. */
const BRANCH_LINE = /^\s*(?:\}\s*)?(?:else\s+)?if\s*\(/;

/** `} else if (` — the line shape that CONTINUES an if/else-if chain. */
const CHAIN_CONTINUATION = /^\s*\}\s*else\s+if\s*\(/;

/**
 * A branch BODY that exits on the branch line — the shape a fall-through chain
 * of returns takes. A bare `if (x.kind === "a") doSomething();` is not one.
 *
 * Read from the BODY, never from the whole line. Testing the whole line also
 * read the CONDITION, so a discriminant literal that merely contains an exit
 * keyword — `if (mode.kind === "break-glass") apply();` — counted as chain
 * evidence on a guard that exits nowhere.
 */
const SAME_LINE_EXIT = /\b(?:return|throw|continue|break)\b/;

/**
 * The part of a branch line AFTER its condition — the branch's own body, when
 * it fits on one line, and `""` when the condition does not close on this line
 * (a multi-line condition has no same-line body to exit from).
 *
 * Scans with paren depth and skips quoted text, so neither a `)` inside a
 * string literal nor a nested call ends the condition early.
 */
function branchBody(line: string): string {
  const open = line.indexOf("(");
  if (open === -1) return "";
  let depth = 0;
  let quote: string | null = null;
  for (let index = open; index < line.length; index++) {
    const char = line[index]!;
    if (quote !== null) {
      if (char === "\\") index++;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'" || char === "`") quote = char;
    else if (char === "(") depth++;
    else if (char === ")" && --depth === 0) return line.slice(index + 1);
  }
  return "";
}

/**
 * Does this line close a block that ENCLOSES the run in progress?
 *
 * A chain — `} else if`, or a fall-through row of same-line returns — is
 * contiguous at ONE indentation, separated only by its own bodies. Reaching a
 * `}` that closes a SHALLOWER block means the enclosing function or object
 * literal ended, so whatever follows cannot continue that chain.
 *
 * Without this, `MAX_CHAIN_GAP` was the only thing separating runs, and it does
 * not separate them at all when the guards are close together: three sibling
 * functions each opening with `if (client.status === "wait") return null;` fell
 * inside the gap and each exited on its own line, which was everything the
 * chain test asked for. They were reported as one three-branch switch — the
 * exact false positive this file's header describes, surviving for the most
 * common guard shape there is.
 *
 * `} else if` is deliberately NOT a closer: it sits at the SAME indentation as
 * the branch it continues, and the comparison is strict. Indentation is counted
 * in characters, consistent with the rest of this line-based linter — a file
 * that mixes tabs and spaces at one nesting level is out of scope.
 */
function closesEnclosingBlock(line: string, runIndent: number): boolean {
  const indent = line.search(/\S/);
  return indent !== -1 && indent < runIndent && line[indent] === "}";
}

/**
 * SCOPED to the chain, not to the file. The file-wide reading was this rule's
 * first form and it was far too lenient: ONE `match(...).exhaustive()` anywhere
 * silenced every chain in the file, which is how a year of unproven branches sat
 * under a green lint. A proof now covers the chain it sits beside — from a few
 * lines before the first branch to a few lines after the last one. The
 * switch-statement half of the same problem is `switch-totality`.
 */
const TOTALITY_PROOF = /\.exhaustive\s*\(\s*\)|:\s*never\b/;

/** How far beyond a chain's first and last branch its proof may sit: a `match`
 *  assigned just above it, or a `never` binding just below its tail. */
const MAX_PROOF_DISTANCE = 6;

function discriminantOf(line: string, tags: readonly string[]): string | null {
  for (const tag of tags) {
    const match = new RegExp(`(?:^|[\\s(!])([A-Za-z_$][\\w$.]*)\\.${tag}\\s*===\\s*["'][^"']+["']`).exec(line);
    if (match !== null) return `${match[1]}.${tag}`;
  }
  return null;
}

/** A run of branches on one discriminant: what the rule measures, before any
 *  judgement about whether the run counts as a switch. */
type BranchRun = Readonly<{
  discriminant: string;
  branches: number;
  firstLine: number;
  lastLine: number;
  /** Does this run look like a CHAIN rather than a row of standalone guards? */
  chainEvidence: boolean;
}>;

/**
 * Find every run of branches on one discriminant. ONE traversal, two readers:
 * `handler` turns offending runs into violations, `detectedChainKeys` turns
 * every run into a baseline key for the staleness pass. Detecting runs twice
 * is how a rule and its own baseline end up disagreeing about what the rule
 * even sees.
 */
function branchRuns(lines: readonly string[], tags: readonly string[]): readonly BranchRun[] {
  const runs: BranchRun[] = [];
  let current: string | null = null;
  let count = 0;
  let firstLine = 0;
  let lastLine = 0;
  // Indentation of the line that OPENED the run — the depth a closing brace
  // must undercut to prove the enclosing block ended.
  let runIndent = 0;
  let chainEvidence = false;

  const settle = (): void => {
    if (current !== null) runs.push({ discriminant: current, branches: count, firstLine, lastLine, chainEvidence });
    current = null;
    count = 0;
    chainEvidence = false;
  };

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    // Scope end BEFORE branch matching: the run is over whether or not this
    // line also opens a branch, and a `} else if` never undercuts runIndent.
    if (current !== null && closesEnclosingBlock(line, runIndent)) settle();
    if (!BRANCH_LINE.test(line)) continue;
    const discriminant = discriminantOf(line, tags);
    if (discriminant === null) continue;
    const isChainLine = CHAIN_CONTINUATION.test(line) || SAME_LINE_EXIT.test(branchBody(line));
    if (discriminant === current && index + 1 - lastLine <= MAX_CHAIN_GAP) {
      count++;
      lastLine = index + 1;
      if (isChainLine) chainEvidence = true;
      continue;
    }
    // settle() FIRST: evidence from the line that starts a new run must not
    // be credited to the run it just ended.
    settle();
    current = discriminant;
    count = 1;
    firstLine = index + 1;
    lastLine = index + 1;
    runIndent = line.search(/\S/);
    chainEvidence = isChainLine;
  }
  settle();
  return Object.freeze(runs);
}

/** Repo-relative form for baseline keys, anchored on `engine/src/` — the same
 *  anchor `switch-totality` uses, so an absolute checkout path normalizes
 *  whether or not the directory is also a declared import boundary. */
const repoRelative = (filePath: string): string => {
  const normalized = filePath.replace(/\\/g, "/");
  const at = normalized.lastIndexOf("/engine/src/");
  return at === -1 ? normalized : normalized.slice(at + 1);
};

export function handler(
  content: string,
  filePath: string,
  maxBranches: number = DEFAULT_MAX_DISCRIMINANT_BRANCHES,
  tags: readonly string[] = DEFAULT_DISCRIMINANT_TAGS,
  baseline: Baseline = EXHAUSTIVE_BRANCHING_BASELINE,
): readonly Violation[] {
  if (isTestFile(filePath)) return [];
  const lines = content.split("\n");
  const relative = repoRelative(filePath);
  const entries = baselineCounter(baseline);

  const provenNear = (first: number, last: number): boolean => {
    const from = Math.max(0, first - 1 - MAX_PROOF_DISTANCE);
    const to = Math.min(lines.length, last + MAX_PROOF_DISTANCE);
    for (let index = from; index < to; index++) {
      if (TOTALITY_PROOF.test(lines[index]!)) return true;
    }
    return false;
  };

  const offending = branchRuns(lines, tags)
    .filter((run) => run.branches >= maxBranches && run.chainEvidence && !provenNear(run.firstLine, run.lastLine))
    .filter((run) => !entries.consume(baselineKey(relative, run.discriminant)));

  return Object.freeze(offending.map((run) => makeViolation(
    "exhaustive-discriminant-branching",
    filePath,
    run.firstLine,
    lines[run.firstLine - 1]?.trim() ?? "",
    `${run.branches} branches on \`${run.discriminant}\` — use match(...).exhaustive() or a \`never\` default so a new variant is a compile error`,
  )));
}

/** Every chain the rule would judge — the input of the staleness pass. */
export function detectedChainKeys(
  content: string,
  filePath: string,
  maxBranches: number = DEFAULT_MAX_DISCRIMINANT_BRANCHES,
  tags: readonly string[] = DEFAULT_DISCRIMINANT_TAGS,
): readonly string[] {
  const relative = repoRelative(filePath);
  return branchRuns(content.split("\n"), tags)
    .filter((run) => run.branches >= maxBranches && run.chainEvidence)
    .map((run) => baselineKey(relative, run.discriminant));
}
