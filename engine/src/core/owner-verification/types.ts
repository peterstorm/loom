/**
 * CT-1 surface: the declarations every owner-verification module and test
 * shares. Declarations only: these bytes freeze at the contract Wave's gate,
 * so behavior lives in the modules that implement these signatures
 * (`coverage.ts`, `mutation-plan.ts`, `outcome.ts`, `verdict.ts`,
 * `obligations.ts`), never here.
 *
 * Vocabulary (CONTEXT.md):
 * - Owner Obligation: one owned Invariant of the plan, stamped into the
 *   TaskGraph at population. The Wave Gate owes it sibling coverage and
 *   mutation verification when the Wave changed its family (owner or sibling).
 * - Sibling coverage: the matrix test's direct imports, closed under
 *   re-exports and resolved to files, reach the owner and every sibling.
 * - Mutation verification: every mutant of the owner's lines changed in the
 *   Wave, made by one fixed operator, is killed by the matrix test.
 * - Mutation exemption: an owned Invariant's declared, reasoned opt-out of
 *   mutation verification only; coverage still runs.
 */

import type { InvariantId } from "../invariant-id";
import type { ArtifactDigest, DomainResult, NonEmpty } from "../orchestration-contract";
import type { SiblingEntryPoint } from "../sibling-entry-point";

export type { InvariantId } from "../invariant-id";

// ---------------------------------------------------------------------------
// Owner Obligations
// ---------------------------------------------------------------------------

/**
 * Whether an owned Invariant's owner is mutation-verified. `exempt` exists
 * only with a non-blank reason: the plan grammar refuses an exemption without
 * one (`exemption-without-reason`), one whose reason is a placeholder such as
 * `none` or `n/a` (`exemption-placeholder-reason`) and an exemption on an
 * unowned Invariant (`exemption-on-unowned`), so none is ever a silent opt-out.
 */
export type MutationPolicy =
  | Readonly<{ kind: "verify" }>
  | Readonly<{ kind: "exempt"; reason: string }>;

/**
 * One owned Invariant's fields, before the relations between them are
 * checked. Paths are repository-relative, exactly as the plan declares them.
 */
export type OwnerObligationFields = Readonly<{
  /** The Invariant id, e.g. "INV-3". */
  invariant: InvariantId;
  title: string;
  /** The `**Statement:**` line; null when the plan declares none. */
  statement: string | null;
  /** The one owner module. */
  owner: string;
  /** Every other entry point that applies the rule, in declared order; empty for `none`. */
  siblings: readonly SiblingEntryPoint[];
  /** The test that runs the rule through every entry point. */
  matrixTest: string;
  mutation: MutationPolicy;
}>;

declare const OWNER_OBLIGATION: unique symbol;

/**
 * One owned Invariant as population stamps it into the TaskGraph
 * (`owner_obligations`), derived purely from the plan. Branded: only
 * `OwnerObligationOfFn` builds one, so under the one plan path rule every
 * path plays one role: the owner is no sibling, the matrix test is neither
 * the owner nor a sibling, and no sibling is listed twice. The plan grammar's
 * derivation and the State File parser both build through it, so a stamp the
 * plan could never produce cannot be loaded either.
 */
export type OwnerObligation = OwnerObligationFields & { readonly [OWNER_OBLIGATION]: true };

/** Why an owned Invariant's fields do not make an Owner Obligation: a path playing two roles. */
export type OwnerObligationError =
  | Readonly<{ kind: "owner-is-sibling"; invariant: InvariantId; path: string }>
  | Readonly<{ kind: "matrix-test-is-owner"; invariant: InvariantId; path: string }>
  | Readonly<{ kind: "matrix-test-is-sibling"; invariant: InvariantId; path: string }>
  | Readonly<{ kind: "duplicate-sibling"; invariant: InvariantId; path: string }>;

/** The only constructor of an `OwnerObligation`: refuses any path that plays two roles. */
export type OwnerObligationOfFn = (fields: OwnerObligationFields) => DomainResult<OwnerObligation, OwnerObligationError>;

declare const MUTATION_OWED: unique symbol;

/**
 * The obligations that owe mutation verification, in order, as
 * `obligations.ts`'s `verifyOwed` selects them (policy `verify`). Branded:
 * only that selector builds one, so whatever takes it (the reported time
 * bound, the runner refusal) reads the one owes-mutation rule.
 */
export type MutationOwed = readonly OwnerObligation[] & { readonly [MUTATION_OWED]: true };

// ---------------------------------------------------------------------------
// Sibling coverage
// ---------------------------------------------------------------------------

/**
 * One tsconfig `paths` entry, already made repository-relative by the shell:
 * `pattern` holds at most one `*`, and each target substitutes the text it
 * matched for its own `*`. Targets are tried in order, as TypeScript does.
 */
export type PathAlias = Readonly<{ pattern: string; targets: readonly string[] }>;

/** The matrix test's tsconfig `paths`, in declared order; empty when it declares none. */
export type PathAliases = readonly PathAlias[];

/**
 * Whether a matrix test reaches its owned Invariant's owner and every
 * declared sibling. `missing` names every unreached path in declared order,
 * the owner first. `infrastructure` is the shell's failure to gather the
 * import frontier: a frontier file that exists but cannot be read
 * (`repository-file-unreadable`), an unresolvable tsconfig
 * (`alias-config-unresolvable`), or the frontier bound exceeded
 * (`coverage-bound-exceeded`). An unreadable file is never reported as a missing path.
 */
export type CoverageVerdict =
  | Readonly<{ kind: "covered" }>
  | Readonly<{ kind: "missing"; paths: NonEmpty<string> }>
  | Readonly<{ kind: "infrastructure"; failure: OwnerInfrastructureFailure }>;

/** The pure coverage decision's input: the matrix test, the obligation it
 *  must cover, the repository files gathered so far (repository-relative
 *  path → text), and the aliases specifiers resolve through. */
export type CoverageInput = Readonly<{
  matrixTest: string;
  obligation: OwnerObligation;
  files: ReadonlyMap<string, string>;
  aliases: PathAliases;
}>;

/** `coverage.ts`'s entry point: a pure function of the import graph and the declared paths. */
export type CoverageOverFilesFn = (input: CoverageInput) => CoverageVerdict;

// ---------------------------------------------------------------------------
// The mutation plan
// ---------------------------------------------------------------------------

/** The engine's fixed operator set, in its fixed application order. */
export type MutationOperator =
  | "condition-negation"
  | "comparison-flip"
  | "logical-swap"
  | "boolean-literal-flip"
  | "return-value-replacement"
  | "statement-removal";

/**
 * One mutant: one operator applied to one site of the owner. `[start, end)`
 * is the replaced span of the owner text (UTF-16 offsets), `original` its
 * text and `replacement` what replaces it; `line` and `column` are the
 * site's 1-based position. `id` is the sha256 of the owner path, span and
 * operator, so it is stable for the same owner bytes.
 */
export type Mutant = Readonly<{
  id: string;
  operator: MutationOperator;
  line: number;
  column: number;
  start: number;
  end: number;
  original: string;
  replacement: string;
}>;

declare const MUTANT_CAP: unique symbol;

/**
 * The per-Invariant mutant cap: a positive integer, branded so the only way
 * to hold one is through `ParseMutantCapFn`. The engine fixes it at 24.
 */
export type MutantCap = number & { readonly [MUTANT_CAP]: true };

/** Why a raw number is not a mutant cap: it is 0, negative, fractional or not finite. */
export type MutantCapError = Readonly<{ kind: "not-positive-integer"; raw: number }>;

/** The mutant cap's parser: refuses every raw number that is not a positive integer. */
export type ParseMutantCapFn = (raw: number) => DomainResult<MutantCap, MutantCapError>;

declare const MUTATION_PLAN: unique symbol;

/** The plan's fields before the plan's invariants are checked. */
export type MutationPlanFields = Readonly<{
  mutants: readonly Mutant[];
  candidates: number;
  cap: MutantCap;
}>;

/**
 * The deterministic mutant set of one owner. `candidates` counts every site
 * on a changed line and `mutants` holds the evenly spaced selection of at
 * most `cap` of them; the sites the cap left unmutated number
 * `candidates - mutants.length`, derived and never stored. Branded: only
 * `MutationPlanOfFn`, which checks the fields it is handed, and the plan's
 * own selection, which holds `min(candidates, cap)` mutants by construction,
 * build one, so `mutants.length <= cap` and `mutants.length <= candidates`
 * hold for every plan.
 */
export type MutationPlan = MutationPlanFields & { readonly [MUTATION_PLAN]: true };

/** Why a plan's fields do not make a plan. */
export type MutationPlanError =
  | Readonly<{ kind: "candidates-not-a-count"; candidates: number }>
  | Readonly<{ kind: "mutants-exceed-candidates"; mutants: number; candidates: number }>
  | Readonly<{ kind: "mutants-exceed-cap"; mutants: number; cap: MutantCap }>;

/**
 * The only constructor of a `MutationPlan`: refuses a `candidates` that is
 * not a non-negative integer, and more mutants than candidates or than the cap.
 */
export type MutationPlanOfFn = (fields: MutationPlanFields) => DomainResult<MutationPlan, MutationPlanError>;

/** The pure mutation plan's input: the owner's bytes and its 1-based lines changed in the Wave. */
export type MutationPlanInput = Readonly<{
  ownerPath: string;
  ownerText: string;
  changedLines: ReadonlySet<number>;
  cap: MutantCap;
}>;

/**
 * Why the owner's text yields no trustworthy mutation plan: the TypeScript
 * parser reported syntax errors (`line:column message`), so the sites it
 * would offer come from a recovered, possibly garbled tree.
 */
export type OwnerUnparseable = Readonly<{ kind: "owner-unparseable"; diagnostics: NonEmpty<string> }>;

/** `mutation-plan.ts`'s entry point: a pure function of owner bytes, changed lines and cap. */
export type MutationPlanFn = (input: MutationPlanInput) => DomainResult<MutationPlan, OwnerUnparseable>;

/** The owner text with one mutant applied: `[start, end)` replaced by `replacement`. */
export type ApplyMutantFn = (ownerText: string, mutant: Mutant) => string;

// ---------------------------------------------------------------------------
// Matrix-test runs and their outcomes
// ---------------------------------------------------------------------------

/** What the runner left at its report path after it exited. */
export type MatrixTestReport =
  | Readonly<{ kind: "missing" }>
  | Readonly<{ kind: "unreadable"; reason: string }>
  | Readonly<{ kind: "produced"; bytes: Uint8Array }>;

/**
 * One run of the matrix test through the frozen `affectedRunner`, as the
 * shell observed it. Only the structured report decides kill and survival;
 * the exit code and signal only ever turn an otherwise passing report into
 * an infrastructure failure.
 */
export type MatrixTestRun =
  | Readonly<{ kind: "spawn-failed"; message: string }>
  | Readonly<{ kind: "timed-out"; elapsedMs: number }>
  | Readonly<{ kind: "exited"; exitCode: number | null; signal: string | null; report: MatrixTestReport }>;

/**
 * Why owner verification could not decide. Every such failure blocks the
 * gate and never counts as a kill.
 * - `repository-file-unreadable`: a repository file the check must read
 *   exists but the filesystem refused it (EACCES, ELOOP, EIO, EMFILE,
 *   ENAMETOOLONG, ...). Only absence (ENOENT, ENOTDIR, EISDIR, a non-file, a
 *   path resolving outside the repository) reads as "not there".
 * - `unexpected-error`: a step built to return its failure as data threw
 *   anyway, an engine defect or an unanticipated exception; the detail
 *   names the step and the error.
 * - `owner-unparseable`: the owner module has syntax errors, so its
 *   mutation sites cannot be trusted.
 * - `no-valid-mutants`: mutants were generated, but every one only failed to
 *   collect, so the run carries no mutation evidence.
 * - `alias-config-unresolvable`: the tsconfig chain governing the matrix
 *   test (its `extends`, `baseUrl` or `paths`) cannot be resolved, so the
 *   aliases its imports resolve through are unknown and coverage cannot be
 *   decided. The plan is fine; the remedy is the tsconfig.
 */
export type OwnerInfrastructureFailureKind =
  | "plan-unreadable"
  | "plan-malformed"
  | "plan-drift"
  | "runner-missing"
  | "worktree-failed"
  | "spawn-failed"
  | "report-missing"
  | "report-unreadable"
  | "matrix-test-not-collected"
  | "exit-unexplained-by-report"
  | "baseline-timed-out"
  | "missing-wave-base"
  | "coverage-bound-exceeded"
  | "real-workspace-changed"
  | "repository-file-unreadable"
  | "unexpected-error"
  | "owner-unparseable"
  | "no-valid-mutants"
  | "alias-config-unresolvable";

export type OwnerInfrastructureFailure = Readonly<{ kind: OwnerInfrastructureFailureKind; detail: string }>;

/**
 * One mutant's run. Two outcomes kill: `killed` (a failing non-collection
 * testcase) and `timed-out` (the run exceeded its time limit). They stay
 * apart so the evidence shows which, and neither ever survives or blocks.
 * `invalid` (the report shows only collection or import errors, naming the
 * failed files) is neither killed nor survived.
 */
export type MutantOutcome =
  | Readonly<{ kind: "killed" }>
  | Readonly<{ kind: "timed-out" }>
  | Readonly<{ kind: "survived" }>
  | Readonly<{ kind: "invalid"; collectionErrors: NonEmpty<string> }>
  | Readonly<{ kind: "infrastructure"; failure: OwnerInfrastructureFailure }>;

/** The unmutated matrix test's run: it must be green before any mutant runs. `red` names the failing testcases. */
export type BaselineOutcome =
  | Readonly<{ kind: "green" }>
  | Readonly<{ kind: "red"; failures: NonEmpty<string> }>
  | Readonly<{ kind: "infrastructure"; failure: OwnerInfrastructureFailure }>;

/** `outcome.ts`'s mutant classifier: the run and the matrix test its testcases are attributed to. */
export type ClassifyMutantRunFn = (run: MatrixTestRun, matrixTest: string) => MutantOutcome;

/** `outcome.ts`'s baseline classifier. */
export type ClassifyBaselineFn = (run: MatrixTestRun, matrixTest: string) => BaselineOutcome;

// ---------------------------------------------------------------------------
// Verdicts and the gate observation
// ---------------------------------------------------------------------------

/** A mutant the matrix test did not kill, with everything its diagnostic names. */
export type SurvivorDiagnostic = Readonly<{
  mutantId: string;
  operator: MutationOperator;
  line: number;
  column: number;
  original: string;
  replacement: string;
}>;

/** A verified mutation run's tallies, before its invariants are checked. `generated` is derived from them, never supplied. */
export type VerifiedMutationFields = Readonly<{
  killed: number;
  timedOut: number;
  invalid: number;
  survivors: readonly SurvivorDiagnostic[];
  unmutated: number;
  ownerChangedInWave: boolean;
}>;

declare const VERIFIED_MUTATION: unique symbol;

/**
 * A completed mutation run of one owner. Branded: only `VerifiedMutationOfFn`
 * builds one, so its counts always agree.
 * - `killed` counts the mutants a failing testcase killed and `timedOut` the
 *   mutants killed by exceeding their time limit: both are kills, the same
 *   two kills `MutantOutcome` names, and a timed-out mutant is counted in
 *   `timedOut` only.
 * - `invalid` counts the mutants that only failed to collect; `survivors`
 *   names every mutant the matrix test did not kill.
 * - `generated = killed + timedOut + invalid + survivors.length`: the mutants
 *   run.
 * - `unmutated` counts the candidate sites the cap left out.
 * - `ownerChangedInWave` is false only when no Wave Task changed the owner;
 *   then zero mutants were generated or left unmutated, and the verdict says so.
 * - when mutants were generated, at least one was killed, timed out or
 *   survived: a run whose every mutant is invalid carries no evidence and is
 *   the `no-valid-mutants` infrastructure failure, never a verified run.
 */
export type VerifiedMutation = VerifiedMutationFields &
  Readonly<{ kind: "verified"; generated: number }> & { readonly [VERIFIED_MUTATION]: true };

/** Why tallies do not make a verified mutation run. */
export type VerifiedMutationError =
  | Readonly<{ kind: "count-not-a-count"; field: "killed" | "timedOut" | "invalid" | "unmutated"; value: number }>
  | Readonly<{ kind: "mutants-without-owner-change"; generated: number; unmutated: number }>
  | Readonly<{ kind: "no-valid-mutants"; generated: number }>;

/**
 * The only constructor of a `VerifiedMutation`, for the gate's tally and the
 * persisted result's parser alike: derives `generated`, and refuses a count
 * that is not a non-negative integer, any generated or unmutated mutant
 * when the owner was unchanged, and generated mutants that are all invalid.
 */
export type VerifiedMutationOfFn = (fields: VerifiedMutationFields) => DomainResult<VerifiedMutation, VerifiedMutationError>;

/** The mutation half of one Invariant's verdict. */
export type MutationVerdict =
  | Readonly<{ kind: "exempt"; reason: string }>
  | Readonly<{ kind: "red-baseline"; failures: NonEmpty<string> }>
  | VerifiedMutation
  | Readonly<{ kind: "infrastructure"; failure: OwnerInfrastructureFailure }>;

/** One owed Invariant's verdict: its coverage and its mutation halves. */
export type InvariantVerdict = Readonly<{
  invariant: InvariantId;
  title: string;
  owner: string;
  matrixTest: string;
  coverage: CoverageVerdict;
  mutation: MutationVerdict;
}>;

/**
 * What the `loom:owner-verification` check observed for a Wave.
 * - `verified`: the plan was re-read and agrees with the stamp
 *   (`obligationsDigest`), with one verdict per owed Invariant; `[]` when the
 *   Wave owes none. `boundMs` is the reported time bound of the mutation runs.
 * - `unavailable`: the check could not run at all (plan unreadable, malformed
 *   or drifted; no runner; the real workspace changed).
 */
export type OwnerVerificationObservation =
  | Readonly<{
      kind: "verified";
      obligationsDigest: ArtifactDigest;
      boundMs: number;
      verdicts: readonly InvariantVerdict[];
    }>
  | Readonly<{ kind: "unavailable"; failure: OwnerInfrastructureFailure }>;

/**
 * One blocking finding of an observation, each naming its Invariant
 * (`invariant` is null only for a failure of the whole check).
 */
export type OwnerVerificationFailure =
  | Readonly<{ kind: "missing-siblings"; invariant: InvariantId; matrixTest: string; paths: NonEmpty<string> }>
  | Readonly<{ kind: "red-baseline"; invariant: InvariantId; matrixTest: string; failures: NonEmpty<string> }>
  | Readonly<{ kind: "survivor"; invariant: InvariantId; owner: string; matrixTest: string; survivor: SurvivorDiagnostic }>
  | Readonly<{ kind: "infrastructure"; invariant: InvariantId | null; failure: OwnerInfrastructureFailure }>;
