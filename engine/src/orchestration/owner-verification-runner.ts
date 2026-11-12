/**
 * The owner-verification execution shell (AD-8; FR-008, FR-015, FR-016,
 * AS-007, AS-008, AS-016, AS-017). Every effect of owner verification lives
 * here, in `mutation-run-steps.ts` (the repository read, the Git base and the
 * runner execution it shares with the Task mutation check) or in
 * `owner-mutation-workspace.ts`; every decision lives in the pure core
 * (`core/owner-verification/`):
 *
 * 1. The real workspace's digest is observed before anything runs.
 * 2. Per owed obligation, in stamp order:
 *    - coverage: the matrix test's tsconfig `paths` are resolved by
 *      `pathAliasesOf` over this shell's reads and `jsonc-parser`, then
 *      `siblingCoverage` walks the import graph itself, pulling each file
 *      it needs from the real workspace through `readRepositoryText`;
 *    - mutation, unless the obligation is exempt: `waveBaseOf` chooses the
 *      owner's Wave base, this shell resolves it with Git and reads the
 *      owner there, `changedHeadLines` and `mutationPlan` fix the mutants,
 *      and one isolated worktree runs the baseline first and, only when it is
 *      green, every mutant, each through the frozen `affectedRunner` with the
 *      matrix test as its only file;
 *    - `invariantVerdict` assembles the verdict.
 * What runs is decided once, purely, before anything runs: the gate hands
 * an `OwedVerification` (`ownerObservationDecision`: the owed obligations
 * paired with the authorized stamp digest, never re-derived here), and
 * `verificationRuns` fixes each obligation's run (mutate or exempt).
 *
 * 3. The real workspace's digest is observed again: any difference is the
 *    blocking `real-workspace-changed` failure (SC-004).
 *
 * No command text ever comes from the plan: the command is the frozen
 * runner's, formed by `affectedRunnerCheck`, and its time limit is clamped by
 * `mutantTimeoutMs`.
 *
 * `runOwnerVerification` never throws to its caller, by construction: every
 * repository read is total (`readRepositoryText` returns a file the
 * filesystem refuses as `repository-file-unreadable`, never as absence), the
 * workspace observer and the obligation runs are guarded, and anything a
 * step still throws is the named `unexpected-error` failure.
 */

import { parse as parseJsonc, printParseErrorCode, type ParseError } from "jsonc-parser";
import { failure, success, type DomainResult } from "../core/orchestration-contract/identity";
import type { ArtifactDigest } from "../core/orchestration-contract";
import { siblingCoverage } from "../core/owner-verification/coverage";
import { mutationPlan, applyMutant, MUTANT_CAP_PER_INVARIANT } from "../core/owner-verification/mutation-plan";
import { duePaths, implementationTasks } from "../core/owner-verification/obligations";
import { pathAliasesOf, type ParseJsonc } from "../core/owner-verification/tsconfig-paths";
import { waveBaseOf } from "../core/owner-verification/wave-base";
import { verificationRuns, type ObligationRun, type OwedVerification } from "../core/owner-verification/owed-verification";
import { classifyBaseline, classifyMutantRun } from "../core/owner-verification/outcome";
import type {
  CoverageVerdict,
  InvariantId,
  InvariantVerdict,
  MatrixTestRun,
  MutationPlan,
  OwnerInfrastructureFailure,
  OwnerInfrastructureFailureKind,
  OwnerObligation,
  OwnerVerificationObservation,
  PathAliases,
} from "../core/owner-verification/types";
import { invariantVerdict, mutationBoundMs, type MutantResult, type MutationEvidence } from "../core/owner-verification/verdict";
import { parseReviewPath } from "../core/review-packet";
import { changedHeadLines } from "../core/unified-diff";
import type { FrozenVerificationManifest } from "../core/verification-manifest";
import type { TaskGraph } from "../types";
import { describeCause } from "../utils/describe-cause";
import type { CanonicalRepositoryRoot } from "../utils/workspace-digest";
import { infrastructure, matrixTestCommand, ownerAtBase, readRepositoryText, resolveWaveBase, runOnce } from "./mutation-run-steps";
import { withMutationWorkspace, type OwnerVariant } from "./owner-mutation-workspace";

export type OwnerVerificationInput = Readonly<{
  /** The real, reviewed workspace. */
  root: CanonicalRepositoryRoot;
  graph: TaskGraph;
  wave: number;
  /**
   * The obligations the Wave owes, in stamp order, paired with the stamp digest
   * the observation is bound to: built only by the gate's
   * `ownerObservationDecision`, so they agree with the check it authorized.
   */
  owed: OwedVerification;
  manifest: FrozenVerificationManifest;
  /** The real workspace's Git-visible digest (`observeCurrentWaveWorkspace`). */
  observeWorkspace: () => DomainResult<ArtifactDigest, string>;
}>;

const unavailableBecause = (failure: OwnerInfrastructureFailure): OwnerVerificationObservation => ({ kind: "unavailable", failure });

const unavailable = (kind: OwnerInfrastructureFailureKind, detail: string): OwnerVerificationObservation =>
  unavailableBecause(infrastructure(kind, detail));

// ---------------------------------------------------------------------------
// tsconfig `paths`
// ---------------------------------------------------------------------------

/** `jsonc-parser` as the core's JSONC port: the parsed value, or every parse error with its offset. */
const parseJsoncText: ParseJsonc = (text) => {
  const errors: ParseError[] = [];
  const parsed: unknown = parseJsonc(text, errors, { allowTrailingComma: true, disallowComments: false });
  return errors.length === 0
    ? success(parsed)
    : failure(errors.map((error) => `${printParseErrorCode(error.error)} at ${error.offset}`).join(", "));
};

// ---------------------------------------------------------------------------
// Coverage
// ---------------------------------------------------------------------------

const coverageInfrastructure = (failure: OwnerInfrastructureFailure): CoverageVerdict => ({ kind: "infrastructure", failure });

/** The matrix test's tsconfig aliases. A refused config is that read's infrastructure failure, never a config that is not there. */
function coverageAliases(root: CanonicalRepositoryRoot, matrixTest: string): DomainResult<PathAliases, OwnerInfrastructureFailure> {
  const aliases = pathAliasesOf(matrixTest, (path) => readRepositoryText(root, path), parseJsoncText);
  if (aliases.ok) return aliases;
  return failure(aliases.error.kind === "unreadable"
    ? aliases.error.failure
    : infrastructure("alias-config-unresolvable", `the import graph of ${matrixTest} cannot be resolved: ${aliases.error.reason}`));
}

/** The matrix test's reach over the family paths due by this Wave (`duePaths`): a sibling only a later Wave lists is not yet owed. */
function coverage(input: OwnerVerificationInput, obligation: OwnerObligation): CoverageVerdict {
  const aliases = coverageAliases(input.root, obligation.matrixTest);
  if (!aliases.ok) return coverageInfrastructure(aliases.error);
  return siblingCoverage({
    matrixTest: obligation.matrixTest,
    due: duePaths(input.graph.tasks, input.wave, obligation),
    aliases: aliases.value,
    read: (path) => readRepositoryText(input.root, path),
  });
}

// ---------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------

/** One matrix-test run with the owner's bytes as `owner` says: the port `runPlan` sequences. */
export type RunMatrixTest = (owner: OwnerVariant) => Promise<MatrixTestRun>;

const BASELINE: OwnerVariant = Object.freeze({ kind: "baseline" });

/**
 * The mutation sequencing policy: the baseline first; with no plan (the
 * owner is unchanged in the Wave) nothing more; otherwise, only when the
 * baseline is green, each mutant in plan order, and the first infrastructure
 * failure ends the run.
 */
export async function runPlan(
  run: RunMatrixTest,
  matrixTest: string,
  ownerText: string,
  plan: MutationPlan | null,
): Promise<MutationEvidence> {
  const baseline = classifyBaseline(await run(BASELINE), matrixTest);
  if (plan === null) return { kind: "owner-unchanged", baseline };
  if (baseline.kind !== "green") return { kind: "owner-changed", baseline, plan, results: [] };
  const results: MutantResult[] = [];
  for (const mutant of plan.mutants) {
    const outcome = classifyMutantRun(await run({ kind: "mutant", text: applyMutant(ownerText, mutant) }), matrixTest);
    if (outcome.kind === "infrastructure") return { kind: "infrastructure", failure: outcome.failure };
    results.push({ mutant, outcome });
  }
  return { kind: "owner-changed", baseline, plan, results };
}

type Planned = Readonly<{ ownerText: string; plan: MutationPlan | null }>;

/** The owner's Wave bytes and its mutation plan: null when no Wave Task changed the owner. */
function planMutation(input: OwnerVerificationInput, obligation: OwnerObligation): DomainResult<Planned, OwnerInfrastructureFailure> {
  const owner = readRepositoryText(input.root, obligation.owner);
  if (owner.kind === "unreadable") return failure(owner.failure);
  if (owner.kind === "absent") {
    return failure(infrastructure("plan-drift", `${obligation.invariant} names the owner ${obligation.owner}, which is not a file in the workspace`));
  }
  const ownerText = owner.text;
  // A contract Task's stub never owes, so its change is not one the mutants must cover.
  const chosen = waveBaseOf(implementationTasks(input.graph), input.wave, obligation.owner);
  if (!chosen.ok) return chosen;
  if (chosen.value.kind === "owner-unchanged") return success({ ownerText, plan: null });
  const base = resolveWaveBase(input.root, obligation.owner, chosen.value);
  if (!base.ok) return base;
  const before = ownerAtBase(input.root, base.value, obligation.owner);
  if (!before.ok) return before;
  const plan = mutationPlan({
    ownerPath: obligation.owner,
    ownerText,
    changedLines: changedHeadLines(before.value, ownerText),
    cap: MUTANT_CAP_PER_INVARIANT,
  });
  if (!plan.ok) {
    return failure(infrastructure("owner-unparseable", `the owner ${obligation.owner} does not parse, so its mutation sites cannot be trusted: ${plan.error.diagnostics.join("; ")}`));
  }
  return success({ ownerText, plan: plan.value });
}

type MutateRun = Extract<ObligationRun, { readonly kind: "mutate" }>;

async function mutationEvidence(input: OwnerVerificationInput, { obligation, runner }: MutateRun): Promise<MutationEvidence> {
  const command = matrixTestCommand(runner, obligation.matrixTest);
  if (!command.ok) {
    return { kind: "infrastructure", failure: infrastructure("runner-missing", `the affectedRunner cannot run ${obligation.matrixTest}: ${command.error}`) };
  }
  const ownerPath = parseReviewPath(obligation.owner, "owner path");
  if (!ownerPath.ok) return { kind: "infrastructure", failure: infrastructure("worktree-failed", ownerPath.errors.join("; ")) };
  const planned = planMutation(input, obligation);
  if (!planned.ok) return { kind: "infrastructure", failure: planned.error };
  try {
    const ran = await withMutationWorkspace(
      { repositoryRoot: input.root, ownerPath: ownerPath.value, reportPath: runner.report.path, runnerCwd: runner.cwd },
      (workspace) => runPlan(
        (owner) => runOnce(workspace, command.value, owner),
        obligation.matrixTest,
        planned.value.ownerText,
        planned.value.plan,
      ),
    );
    return ran.ok ? ran.value : { kind: "infrastructure", failure: ran.error };
  } catch (cause) {
    return { kind: "infrastructure", failure: infrastructure("worktree-failed", `the isolated copy failed during a run: ${describeCause(cause)}`) };
  }
}

// ---------------------------------------------------------------------------
// The check
// ---------------------------------------------------------------------------

/** A step's value, or the `unexpected-error` failure naming the step when it threw although it is built to return failures as data. */
async function guarded<T>(step: string, run: () => T | Promise<T>): Promise<DomainResult<T, OwnerInfrastructureFailure>> {
  try {
    return success(await run());
  } catch (cause) {
    return failure(infrastructure("unexpected-error", `${step} threw: ${describeCause(cause)}`));
  }
}

/** The real workspace's digest; an observer that fails or throws leaves the workspace unobserved, which is never a pass. */
async function workspaceDigest(input: OwnerVerificationInput, when: "before" | "after"): Promise<DomainResult<ArtifactDigest, OwnerInfrastructureFailure>> {
  const unobserved = (reason: string) =>
    failure(infrastructure("real-workspace-changed", `the real workspace could not be observed ${when} verification: ${reason}`));
  const observed = await guarded("observing the real workspace", input.observeWorkspace);
  if (!observed.ok) return unobserved(observed.error.detail);
  return observed.value.ok ? success(observed.value.value) : unobserved(observed.value.error);
}

type ObligationRuns = Readonly<{ verdicts: readonly InvariantVerdict[]; plans: ReadonlyMap<InvariantId, MutationPlan> }>;

/** Coverage then, for a `mutate` run, mutation per owed obligation, in stamp order. */
async function verifyObligations(input: OwnerVerificationInput, runs: readonly ObligationRun[]): Promise<ObligationRuns> {
  const verdicts: InvariantVerdict[] = [];
  const plans = new Map<InvariantId, MutationPlan>();
  for (const run of runs) {
    const covered = coverage(input, run.obligation);
    const evidence: MutationEvidence = run.kind === "exempt" ? { kind: "exempt" } : await mutationEvidence(input, run);
    if (evidence.kind === "owner-changed") plans.set(run.obligation.invariant, evidence.plan);
    verdicts.push(invariantVerdict(run.obligation, covered, evidence));
  }
  return { verdicts, plans };
}

/**
 * The check between its two digest observations. A throw from the
 * obligation runs is caught here, before the after-run observation, so the
 * SC-004 comparison runs on every path that ran anything; a changed
 * workspace outranks the thrown failure.
 */
async function verifyWave(input: OwnerVerificationInput): Promise<OwnerVerificationObservation> {
  const planned = verificationRuns(input.owed, input.manifest.affectedRunner);
  if (!planned.ok) return unavailableBecause(planned.error);
  const { runs, verifying, perRunMs } = planned.value;

  const before = await workspaceDigest(input, "before");
  if (!before.ok) return unavailableBecause(before.error);
  const ran = await guarded("verifying the owed obligations", () => verifyObligations(input, runs));
  const after = await workspaceDigest(input, "after");
  if (!after.ok) return unavailableBecause(after.error);
  if (after.value !== before.value) {
    return unavailable("real-workspace-changed", `the real workspace digest changed from ${before.value} to ${after.value} while owner verification ran`);
  }
  if (!ran.ok) return unavailableBecause(ran.error);
  return {
    kind: "verified",
    obligationsDigest: input.owed.obligationsDigest,
    boundMs: mutationBoundMs(verifying, ran.value.plans, perRunMs),
    verdicts: ran.value.verdicts,
  };
}

/**
 * Run owner verification for the Wave's owed obligations. Never throws, by
 * construction: every failure is `unavailable` or a per-Invariant
 * infrastructure verdict, and this outermost guard turns any throw that
 * escapes `verifyWave` into `unexpected-error`. Such a throw can only come
 * from pure code before the first digest observation or after the second was
 * compared, so no run went unchecked against SC-004.
 */
export async function runOwnerVerification(input: OwnerVerificationInput): Promise<OwnerVerificationObservation> {
  const observed = await guarded("owner verification", () => verifyWave(input));
  return observed.ok ? observed.value : unavailableBecause(observed.error);
}
