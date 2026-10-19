/**
 * Lint runtime skew: whether the full-tier lint that just judged a branch ran
 * rule code the branch itself does not carry (issue #57 D6).
 *
 * The Wave Gate changes into the branch's worktree before linting, but the
 * rules it executes are the loaded runtime's: its declarative `lint-rules/`
 * and its programmatic `engine/src/linter/`. When the gated branch is itself a
 * Loom checkout whose rule files differ from the loaded runtime's, a refusal
 * may come from the older rules rather than from the branch's code. Naming
 * that skew at the refusal turns an hour of misdiagnosis into one sentence.
 *
 * Pure module: the shell observes both rule trees as digests and hands them in.
 */

/** Every lint-rule file of one tree, as root-relative POSIX path → content sha256. */
export type LintRuleDigests = ReadonlyMap<string, string>;

export type LintRuntimeSkew =
  /** The gated repository carries no Loom lint rules, so there is nothing to compare. */
  | Readonly<{ kind: "not-a-loom-checkout" }>
  /** The branch's rule files are byte-identical to the loaded runtime's. */
  | Readonly<{ kind: "no-skew" }>
  /** These rule files differ (changed, or present in only one tree), in path order. */
  | Readonly<{ kind: "skewed"; runtimeRoot: string; differing: readonly [string, ...string[]] }>;

/**
 * Compare the loaded runtime's rule digests with the branch's. `branch` is
 * `null` when the gated repository is not a Loom checkout. A path differs when
 * its digests differ or only one tree has it.
 */
export function lintRuntimeSkew(
  runtimeRoot: string,
  runtime: LintRuleDigests,
  branch: LintRuleDigests | null,
): LintRuntimeSkew {
  if (branch === null) return Object.freeze({ kind: "not-a-loom-checkout" as const });
  const paths = [...new Set([...runtime.keys(), ...branch.keys()])].sort();
  const differing = paths.filter((path) => runtime.get(path) !== branch.get(path));
  const [first, ...rest] = differing;
  return first === undefined
    ? Object.freeze({ kind: "no-skew" as const })
    : Object.freeze({ kind: "skewed" as const, runtimeRoot, differing: Object.freeze([first, ...rest]) as readonly [string, ...string[]] });
}

/** How many differing paths a note names before summarising the rest. */
const NAMED_PATHS = 8;

/**
 * The operator-facing sentence for a refusal reached under skew, or `null`
 * when the rules the lint ran are the branch's own (or the branch has none).
 */
export function renderLintRuntimeSkew(skew: LintRuntimeSkew): string | null {
  if (skew.kind !== "skewed") return null;
  const named = skew.differing.slice(0, NAMED_PATHS).join(", ");
  const more = skew.differing.length > NAMED_PATHS ? ` and ${skew.differing.length - NAMED_PATHS} more` : "";
  return `The full-tier lint ran the loaded runtime's lint rules (${skew.runtimeRoot}), which differ from this branch's for ` +
    `${named}${more}. A refusal the branch's own rules would admit is runtime skew, not a code defect: land the rule change on ` +
    `the runtime Loom is loaded from and reload it before gating again (docs/operations.md: ` +
    `"Wave Gate full-tier lint refuses imports the branch allows").`;
}
