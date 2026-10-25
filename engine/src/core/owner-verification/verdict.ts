/**
 * The per-Invariant verdict and the gate's blocking findings (AD-7; FR-013,
 * FR-014, FR-016, AS-011, AS-014). Pure and total: the shell runs the
 * baseline and the mutants and hands the observed outcomes here; this module
 * only tallies, selects the blocking findings and renders them, and returns
 * every failure as a verdict, never a throw.
 *
 * - `invariantVerdict` assembles one owed obligation's coverage and mutation
 *   halves. An exemption is the obligation's own declared policy; a red
 *   baseline, or any infrastructure failure of the baseline or a mutant, is
 *   the mutation verdict, never a kill. Results that are not the plan's
 *   mutants in plan order are `plan-drift`; generated mutants that are all
 *   invalid are `no-valid-mutants`: both infrastructure, never a pass.
 * - `ownerVerificationFailures` lists, per Invariant: missing siblings, a red
 *   baseline, every survivor, and every infrastructure failure. An exempt
 *   Invariant never has a survivor, since it runs no mutant.
 * - `mutationBoundMs` is the reported time bound (NFR-004), over the
 *   obligations `verifyOwed` selected (`MutationOwed`), so the owes-mutation
 *   rule stays in `obligations.ts`.
 */

import { match } from "ts-pattern";
import { verifiedMutationOf } from "./outcome";
import type {
  BaselineOutcome,
  CoverageVerdict,
  InvariantId,
  InvariantVerdict,
  Mutant,
  MutationOwed,
  MutantOutcome,
  MutationPlan,
  MutationVerdict,
  OwnerInfrastructureFailure,
  OwnerObligation,
  OwnerVerificationFailure,
  OwnerVerificationObservation,
  SurvivorDiagnostic,
  VerifiedMutationError,
  VerifiedMutationFields,
} from "./types";

/** One planned mutant and how its run was classified. */
export type MutantResult = Readonly<{ mutant: Mutant; outcome: MutantOutcome }>;

/**
 * What the shell did for one obligation's mutation half.
 * - `exempt`: it honored the obligation's declared exemption and ran nothing.
 * - `owner-unchanged`: no Wave Task changed the owner, so the plan is empty;
 *   only the baseline ran.
 * - `owner-changed`: the baseline ran, then (when green) one result per
 *   planned mutant, in plan order.
 * - `infrastructure`: the mutation run could not start (no Wave base, no
 *   worktree).
 */
export type MutationEvidence =
  | Readonly<{ kind: "exempt" }>
  | Readonly<{ kind: "owner-unchanged"; baseline: BaselineOutcome }>
  | Readonly<{ kind: "owner-changed"; baseline: BaselineOutcome; plan: MutationPlan; results: readonly MutantResult[] }>
  | Readonly<{ kind: "infrastructure"; failure: OwnerInfrastructureFailure }>;

const infrastructureVerdict = (failure: OwnerInfrastructureFailure): MutationVerdict => ({ kind: "infrastructure", failure });

/** Why tallies make no verified run, as the infrastructure failure that blocks: no evidence, or counts the plan cannot explain. */
const refusedTally = (error: VerifiedMutationError): OwnerInfrastructureFailure =>
  match(error)
    .with({ kind: "no-valid-mutants" }, ({ generated }): OwnerInfrastructureFailure => ({
      kind: "no-valid-mutants",
      detail: `all ${generated} generated mutants only failed to collect, so the matrix test gave no mutation evidence; fix the collection errors the mutants cause`,
    }))
    .with({ kind: "count-not-a-count" }, { kind: "mutants-without-owner-change" }, ({ kind }): OwnerInfrastructureFailure => ({
      kind: "plan-drift",
      detail: `the tallied mutant counts do not make a verified run (${kind})`,
    }))
    .exhaustive();

/** A run's tallies, minted through the one constructor; a refusal is the infrastructure verdict that blocks. */
function verified(fields: VerifiedMutationFields): MutationVerdict {
  const built = verifiedMutationOf(fields);
  return built.ok ? built.value : infrastructureVerdict(refusedTally(built.error));
}

const survivorOf = (mutant: Mutant): SurvivorDiagnostic => ({
  mutantId: mutant.id,
  operator: mutant.operator,
  line: mutant.line,
  column: mutant.column,
  original: mutant.original,
  replacement: mutant.replacement,
});

/** The verdict of a green baseline's mutant results against the plan they ran. */
function tally(plan: MutationPlan, results: readonly MutantResult[]): MutationVerdict {
  const planned = plan.mutants.map((mutant) => mutant.id).join("\n");
  if (results.map((result) => result.mutant.id).join("\n") !== planned) {
    return infrastructureVerdict({
      kind: "plan-drift",
      detail: `the ${results.length} mutant results are not the plan's ${plan.mutants.length} mutants, in plan order`,
    });
  }
  const [broken] = results.flatMap(({ outcome }) => outcome.kind === "infrastructure" ? [outcome.failure] : []);
  if (broken !== undefined) return infrastructureVerdict(broken);
  const count = (kind: MutantOutcome["kind"]): number => results.filter((result) => result.outcome.kind === kind).length;
  return verified({
    killed: count("killed"),
    timedOut: count("timed-out"),
    invalid: count("invalid"),
    survivors: results.filter((result) => result.outcome.kind === "survived").map((result) => survivorOf(result.mutant)),
    unmutated: plan.candidates - plan.mutants.length,
    ownerChangedInWave: true,
  });
}

/** A baseline that is not green decides the mutation verdict before any mutant counts. */
const afterBaseline = (baseline: BaselineOutcome, green: () => MutationVerdict): MutationVerdict =>
  match(baseline)
    .with({ kind: "green" }, green)
    .with({ kind: "red" }, ({ failures }): MutationVerdict => ({ kind: "red-baseline", failures }))
    .with({ kind: "infrastructure" }, ({ failure }) => infrastructureVerdict(failure))
    .exhaustive();

function mutationVerdictOf(obligation: OwnerObligation, evidence: MutationEvidence): MutationVerdict {
  if (obligation.mutation.kind === "exempt") return { kind: "exempt", reason: obligation.mutation.reason };
  return match(evidence)
    .with({ kind: "exempt" }, () => infrastructureVerdict({
      kind: "plan-drift",
      detail: `${obligation.invariant} declares mutation verification, but its mutation run was skipped as exempt`,
    }))
    .with({ kind: "owner-unchanged" }, ({ baseline }) => afterBaseline(baseline, () =>
      verified({ killed: 0, timedOut: 0, invalid: 0, survivors: [], unmutated: 0, ownerChangedInWave: false })))
    .with({ kind: "owner-changed" }, ({ baseline, plan, results }) => afterBaseline(baseline, () => tally(plan, results)))
    .with({ kind: "infrastructure" }, ({ failure }) => infrastructureVerdict(failure))
    .exhaustive();
}

/** One owed obligation's verdict: its coverage and its mutation halves. */
export const invariantVerdict = (obligation: OwnerObligation, coverage: CoverageVerdict, evidence: MutationEvidence): InvariantVerdict => ({
  invariant: obligation.invariant,
  title: obligation.title,
  owner: obligation.owner,
  matrixTest: obligation.matrixTest,
  coverage,
  mutation: mutationVerdictOf(obligation, evidence),
});

function verdictFailures(verdict: InvariantVerdict): readonly OwnerVerificationFailure[] {
  const { invariant, owner, matrixTest } = verdict;
  const coverage = match(verdict.coverage)
    .with({ kind: "covered" }, (): readonly OwnerVerificationFailure[] => [])
    .with({ kind: "missing" }, ({ paths }): readonly OwnerVerificationFailure[] => [{ kind: "missing-siblings", invariant, matrixTest, paths }])
    .with({ kind: "infrastructure" }, ({ failure }): readonly OwnerVerificationFailure[] => [{ kind: "infrastructure", invariant, failure }])
    .exhaustive();
  const mutation = match(verdict.mutation)
    .with({ kind: "exempt" }, (): readonly OwnerVerificationFailure[] => [])
    .with({ kind: "red-baseline" }, ({ failures }): readonly OwnerVerificationFailure[] => [{ kind: "red-baseline", invariant, matrixTest, failures }])
    .with({ kind: "verified" }, ({ survivors }): readonly OwnerVerificationFailure[] =>
      survivors.map((survivor) => ({ kind: "survivor", invariant, owner, matrixTest, survivor })))
    .with({ kind: "infrastructure" }, ({ failure }): readonly OwnerVerificationFailure[] => [{ kind: "infrastructure", invariant, failure }])
    .exhaustive();
  return [...coverage, ...mutation];
}

/** Every blocking finding of an observation, in verdict order: coverage before mutation per Invariant. */
export const ownerVerificationFailures = (observation: OwnerVerificationObservation): readonly OwnerVerificationFailure[] =>
  match(observation)
    .with({ kind: "unavailable" }, ({ failure }): readonly OwnerVerificationFailure[] => [{ kind: "infrastructure", invariant: null, failure }])
    .with({ kind: "verified" }, ({ verdicts }) => verdicts.flatMap(verdictFailures))
    .exhaustive();

/**
 * The reported time bound of the mutation runs (NFR-004):
 * Σ over the obligations owing mutation (`verifyOwed`: owed, non-exempt) of
 * (1 baseline + selected mutants) × the per-mutant limit. An obligation
 * without a plan bounds its baseline only.
 */
export const mutationBoundMs = (verifying: MutationOwed, plans: ReadonlyMap<InvariantId, MutationPlan>, perMutantMs: number): number =>
  verifying
    .reduce((bound, obligation) => bound + (1 + (plans.get(obligation.invariant)?.mutants.length ?? 0)) * perMutantMs, 0);

/** One finding as the gate's diagnostic line: the Invariant, its evidence and the remedy. */
export const renderOwnerVerificationFailure = (failure: OwnerVerificationFailure): string =>
  match(failure)
    .with({ kind: "missing-siblings" }, ({ invariant, matrixTest, paths }) =>
      `${invariant}: matrix test ${matrixTest} does not import ${paths.join(", ")}; strengthen ${matrixTest} to import the owner and every sibling entry point`)
    .with({ kind: "red-baseline" }, ({ invariant, matrixTest, failures }) =>
      `${invariant}: matrix test ${matrixTest} is red against the unmutated workspace, so no mutant ran; failing: ${failures.join("; ")}`)
    .with({ kind: "survivor" }, ({ invariant, owner, matrixTest, survivor }) =>
      `${invariant}: mutant survived at ${owner}:${survivor.line}:${survivor.column} (${survivor.operator}): original \`${survivor.original}\`, mutated \`${survivor.replacement}\`; ` +
      `strengthen ${matrixTest} to kill it, or declare a mutation exemption with a reason on ${invariant}`)
    .with({ kind: "infrastructure" }, ({ invariant, failure: cause }) =>
      `${invariant === null ? "owner verification" : invariant}: infrastructure failure (${cause.kind}): ${cause.detail}`)
    .exhaustive();

/** One Invariant's mutation half as a summary line, for the gate evidence and status. */
export const renderMutationVerdict = (verdict: MutationVerdict): string =>
  match(verdict)
    .with({ kind: "exempt" }, ({ reason }) => `mutation exempt: ${reason}`)
    .with({ kind: "red-baseline" }, ({ failures }) => `baseline red: ${failures.join("; ")}`)
    .with({ kind: "infrastructure" }, ({ failure }) => `infrastructure (${failure.kind}): ${failure.detail}`)
    .with({ kind: "verified" }, (run) =>
      !run.ownerChangedInWave ? "owner unchanged in Wave: 0 mutants generated"
      : run.generated === 0 && run.unmutated === 0 ? "no mutable construct on the owner's changed lines: 0 mutants generated"
      : `${run.generated} mutants generated: ${run.killed} killed, ${run.timedOut} timed out, ${run.invalid} invalid, ${run.survivors.length} survived; ${run.unmutated} sites unmutated (cap)`)
    .exhaustive();
