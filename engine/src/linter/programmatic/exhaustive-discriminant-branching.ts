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
 *
 * Pre-existing chains are grandfathered per project in
 * `discriminantBranchingBaseline`, keyed `path::discriminant` relative to the
 * project root — the same key form and staleness pass as `switch-totality`.
 */

import type { Violation } from "../types";
import { makeViolation } from "../types";
import { isTestFile } from "./config";
import { baselineCounter, projectRelative, baselineKey, type Baseline, type BaselineKey } from "./baseline";

export const RULE_NAME = "exhaustive-discriminant-branching";

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

export type DiscriminantBranchingOptions = Readonly<{
  maxBranches: number;
  tags: readonly string[];
  baseline: Baseline;
  /** The root of the project whose config supplied `baseline` — the frame its
   *  keys are written in. Null when no project config is in play. */
  projectRoot: string | null;
}>;

export const DEFAULT_DISCRIMINANT_BRANCHING_OPTIONS: DiscriminantBranchingOptions = Object.freeze({
  maxBranches: DEFAULT_MAX_DISCRIMINANT_BRANCHES,
  tags: DEFAULT_DISCRIMINANT_TAGS,
  baseline: Object.freeze([]),
  projectRoot: null,
});

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
    const char = line[index];
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
 * Find every run of branches on one discriminant — the measurement under
 * `candidateChains`, which is where the rule's judgement of a run lives.
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
    const line = lines[index];
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

/** A chain this rule flags absent a baseline, with the key a baseline entry
 *  for it is written under and the text of its first branch line. */
type CandidateChain = BranchRun & Readonly<{ key: BaselineKey; snippet: string }>;

/**
 * The chains the rule flags absent its baseline: enough branches, chain-shaped,
 * outside a test file, and no totality proof near them. The ONE judgement both
 * readers share — `handler` spends baseline entries against these, and
 * `detectedChainKeys` hands them to the staleness pass. The detector used to
 * skip the proof check, so a baselined chain later proven by a nearby
 * `.exhaustive()` kept consuming its entry and the paid debt never surfaced.
 */
function candidateChains(
  content: string,
  filePath: string,
  { maxBranches, tags, projectRoot }: DiscriminantBranchingOptions,
): readonly CandidateChain[] {
  const relative = projectRelative(filePath, projectRoot);
  if (isTestFile(relative)) return [];
  const lines = content.split("\n");

  const provenNear = (first: number, last: number): boolean => {
    const from = Math.max(0, first - 1 - MAX_PROOF_DISTANCE);
    const to = Math.min(lines.length, last + MAX_PROOF_DISTANCE);
    return lines.slice(from, to).some((line) => TOTALITY_PROOF.test(line));
  };

  return Object.freeze(branchRuns(lines, tags)
    .filter((run) => run.branches >= maxBranches && run.chainEvidence && !provenNear(run.firstLine, run.lastLine))
    .map((run) => ({ ...run, key: baselineKey(relative, run.discriminant), snippet: lines[run.firstLine - 1]?.trim() ?? "" })));
}

export function handler(
  content: string,
  filePath: string,
  options: DiscriminantBranchingOptions = DEFAULT_DISCRIMINANT_BRANCHING_OPTIONS,
): readonly Violation[] {
  const entries = baselineCounter(options.baseline);
  return Object.freeze(candidateChains(content, filePath, options)
    .filter((chain) => !entries.consume(chain.key))
    .map((chain) => makeViolation(
      RULE_NAME,
      filePath,
      chain.firstLine,
      chain.snippet,
      `${chain.branches} branches on \`${chain.discriminant}\` — use match(...).exhaustive() or a \`never\` default so a new variant is a compile error`,
    )));
}

/** The baseline keys of every chain the rule would flag absent its baseline —
 *  the input of the staleness pass and of `lint-project --write-baseline`. */
export function detectedChainKeys(
  content: string,
  filePath: string,
  options: DiscriminantBranchingOptions = DEFAULT_DISCRIMINANT_BRANCHING_OPTIONS,
): readonly BaselineKey[] {
  return candidateChains(content, filePath, options).map((chain) => chain.key);
}
