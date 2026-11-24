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
 * Step 2 is `verifyObligations`, the one per-obligation run the Task owner
 * check shares (ADR-0092). The two callers differ only in the paths each run
 * must reach (`ScopedRun.due`: `duePaths` by the Wave here, the duty's own
 * paths at a Task's stop) and in how one matrix-test run is launched
 * (`ObligationRunScope.execute`: `runOnce` here, behind the Task check's
 * deadline there).
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
import { failure, mapNonEmpty, nonEmptyOf, success, type DomainResult, type NonEmpty } from "../core/orchestration-contract/identity";
import type { ArtifactDigest } from "../core/orchestration-contract";
import { siblingCoverage } from "../core/owner-verification/coverage";
import { mutationPlan, mutationPlanRefusalText, applyMutant, MUTANT_CAP_PER_INVARIANT } from "../core/owner-verification/mutation-plan";
import { duePaths, implementationTasks } from "../core/owner-verification/obligations";
import { obligationLanguageOf } from "../core/owner-verification/language";
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
import {
  infrastructure,
  matrixTestCommand,
  ownerAtBase,
  readRepositoryText,
  resolveWaveBase,
  runOnce,
  type MatrixTestCommand,
} from "./mutation-run-steps";
import { withMutationWorkspace, type MutationWorkspace, type OwnerVariant } from "./owner-mutation-workspace";

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

/** The aliases a reader that resolves nothing reads (`coverage.ts`'s Java arm never touches them). */
const NO_ALIASES: PathAliases = Object.freeze([]);

/** The matrix test's tsconfig aliases. A refused config is that read's infrastructure failure, never a config that is not there. */
function coverageAliases(root: CanonicalRepositoryRoot, matrixTest: string): DomainResult<PathAliases, OwnerInfrastructureFailure> {
  const aliases = pathAliasesOf(matrixTest, (path) => readRepositoryText(root, path), parseJsoncText);
  if (aliases.ok) return aliases;
  return failure(aliases.error.kind === "unreadable"
    ? aliases.error.failure
    : infrastructure("alias-config-unresolvable", `the import graph of ${matrixTest} cannot be resolved: ${aliases.error.reason}`));
}

/** The matrix test's reach over the family paths its run says are due. */
function coverage(scope: ObligationRunScope, { run: { obligation }, due }: ScopedRun): CoverageVerdict {
  // A Java family's reach is decided by names, so no tsconfig is consulted: a
  // broken `paths` chain is a TypeScript resolution concern and cannot be the
  // reason a Java obligation fails coverage (`coverage.ts` never reads aliases).
  const javaFamily = obligationLanguageOf({ owner: obligation.owner, matrixTest: obligation.matrixTest, due });
  const aliases: DomainResult<PathAliases, OwnerInfrastructureFailure> =
    javaFamily.ok && javaFamily.value === "java" ? success(NO_ALIASES) : coverageAliases(scope.root, obligation.matrixTest);
  if (!aliases.ok) return coverageInfrastructure(aliases.error);
  return siblingCoverage({
    matrixTest: obligation.matrixTest,
    due,
    aliases: aliases.value,
    read: (path) => readRepositoryText(scope.root, path),
  });
}

// ---------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------

/** One matrix-test run with the owner's bytes as `owner` says: the port `runPlan` sequences. */
export type RunMatrixTest = (owner: OwnerVariant) => Promise<MatrixTestRun>;

/**
 * One execution of the matrix test's command in an obligation's isolated
 * copy: `runOnce` at the gate; at a Task's stop, `runOnce` behind the
 * Task owner check's deadline.
 */
export type ExecuteMatrixTest = (workspace: MutationWorkspace, command: MatrixTestCommand, owner: OwnerVariant) => Promise<MatrixTestRun>;

/**
 * What every obligation's run reads besides the obligation itself. The gate
 * and a Task owner check (ADR-0092) differ only in the paths each run must
 * reach (`ScopedRun.due`) and in `execute`, how one matrix-test run is
 * launched. The Wave base, the mutation plan, the isolated copy, the run
 * sequencing and the verdict are the same for both.
 */
export type ObligationRunScope = Readonly<{
  /** The real workspace. It is only ever read. */
  root: CanonicalRepositoryRoot;
  /** The Tasks whose listings choose each owner's Wave base. */
  graph: Pick<TaskGraph, "tasks" | "acceptance_contracts">;
  wave: number;
  execute: ExecuteMatrixTest;
}>

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
function planMutation(input: ObligationRunScope, obligation: OwnerObligation): DomainResult<Planned, OwnerInfrastructureFailure> {
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
    return failure(infrastructure(plan.error.kind, `the owner ${obligation.owner} ${mutationPlanRefusalText(plan.error)}`));
  }
  return success({ ownerText, plan: plan.value });
}

type MutateRun = Extract<ObligationRun, { readonly kind: "mutate" }>;

async function mutationEvidence(input: ObligationRunScope, { obligation, runner }: MutateRun): Promise<MutationEvidence> {
  const command = matrixTestCommand(runner, [obligation.matrixTest]);
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
        (owner) => input.execute(workspace, command.value, owner),
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

/**
 * One obligation's run with the paths its matrix test must reach: `duePaths`
 * by the Wave at the gate, the duty's own `due` at a Task's stop.
 */
export type ScopedRun = Readonly<{ run: ObligationRun; due: NonEmpty<string> }>;

/** Each run's verdict, in run order, and the mutation plan of each obligation whose owner changed in the Wave. */
export type ObligationRuns = Readonly<{ verdicts: NonEmpty<InvariantVerdict>; plans: ReadonlyMap<InvariantId, MutationPlan> }>;

/**
 * The per-obligation run the gate and a Task owner check share: coverage
 * then, for a `mutate` run, mutation, per obligation in run order. Each
 * failure is that obligation's infrastructure verdict; a throw escapes only
 * from a step built to return failures as data, and its caller guards it.
 */
export async function verifyObligations(scope: ObligationRunScope, [first, ...rest]: NonEmpty<ScopedRun>): Promise<ObligationRuns> {
  const plans = new Map<InvariantId, MutationPlan>();
  const verify = async (scoped: ScopedRun): Promise<InvariantVerdict> => {
    const { run } = scoped;
    const covered = coverage(scope, scoped);
    const evidence: MutationEvidence = run.kind === "exempt" ? { kind: "exempt" } : await mutationEvidence(scope, run);
    if (evidence.kind === "owner-changed") plans.set(run.obligation.invariant, evidence.plan);
    return invariantVerdict(run.obligation, covered, evidence);
  };
  const head = await verify(first);
  const tail: InvariantVerdict[] = [];
  for (const scoped of rest) tail.push(await verify(scoped));
  return { verdicts: nonEmptyOf(head, ...tail), plans };
}

/** The gate's scope: every run launched as it comes. */
const gateScope = (input: OwnerVerificationInput): ObligationRunScope => ({ root: input.root, graph: input.graph, wave: input.wave, execute: runOnce });

/** Each gate run with the paths due by its Wave. */
const gateRuns = (input: OwnerVerificationInput, runs: NonEmpty<ObligationRun>): NonEmpty<ScopedRun> =>
  mapNonEmpty(runs, (run) => ({ run, due: duePaths(input.graph.tasks, input.wave, run.obligation) }));

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
  const ran = await guarded("verifying the owed obligations", () => verifyObligations(gateScope(input), gateRuns(input, runs)));
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
