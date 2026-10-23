/**
 * Owner verification as status reports it (AD-10 status half; FR-028,
 * AS-029, AS-030). Pure: the shell hands in the latest persisted completion
 * result's `ownerVerification`, and this module projects it into one
 * `OwnerVerificationStatus` per Invariant. `helper orchestration status`
 * serializes that one projection as `--json` and renders it as human lines,
 * so the two cannot disagree.
 *
 * Blocking findings and their remedy text are not decided here: they come
 * from `verdict.ts` (`ownerVerificationFailures`,
 * `renderOwnerVerificationFailure`), the same source the gate's diagnostics
 * read, so status names exactly the remedy the gate blocked on.
 */

import { match } from "ts-pattern";
import type { NonEmpty } from "../orchestration-contract";
import { ownerVerificationFailures, renderOwnerVerificationFailure } from "./verdict";
import type {
  CoverageVerdict,
  InvariantVerdict,
  MutationVerdict,
  OwnerInfrastructureFailure,
  OwnerVerificationObservation,
  SurvivorDiagnostic,
} from "./types";

/** An Invariant's sibling coverage: `pass`, the paths the matrix test never reaches, or why it could not be decided. */
export type OwnerCoverageStatus =
  | Readonly<{ result: "pass" }>
  | Readonly<{ result: "missing"; paths: NonEmpty<string> }>
  | Readonly<{ result: "infrastructure"; failure: OwnerInfrastructureFailure }>;

/**
 * An Invariant's mutation half. `verified` carries every count of the run
 * and the survivors themselves; their number is `survivors.length`, derived
 * wherever it is shown and never stored beside them. `exempt` carries the
 * declared reason; a red baseline and an infrastructure failure carry their
 * cause.
 */
export type OwnerMutationStatus =
  | Readonly<{
      result: "verified";
      ownerChangedInWave: boolean;
      generated: number;
      killed: number;
      timedOut: number;
      invalid: number;
      survivors: readonly SurvivorDiagnostic[];
      unmutated: number;
    }>
  | Readonly<{ result: "exempt"; reason: string }>
  | Readonly<{ result: "red-baseline"; failures: NonEmpty<string> }>
  | Readonly<{ result: "infrastructure"; failure: OwnerInfrastructureFailure }>;

/** One owed Invariant's owner verification, as status reports it. */
export type OwnerVerificationStatus = Readonly<{
  invariant: string;
  title: string;
  owner: string;
  matrixTest: string;
  coverage: OwnerCoverageStatus;
  mutation: OwnerMutationStatus;
}>;

/**
 * Owner verification of the latest persisted completion result.
 * - `not-observed`: there is nothing to project, and `reason` says why: no
 *   persisted result, one that carries no owner verification, or a persisted
 *   result status could not read.
 * - `unavailable`: the check could not run at all.
 * - `verified`: one status per owed Invariant (`[]` when the Wave owes none)
 *   and the reported time bound of the mutation runs, which covers them all.
 */
export type OwnerVerificationStatusReport =
  | Readonly<{ kind: "not-observed"; reason: string }>
  | Readonly<{ kind: "unavailable"; failure: OwnerInfrastructureFailure }>
  | Readonly<{ kind: "verified"; boundMs: number; invariants: readonly OwnerVerificationStatus[] }>;

const coverageStatus = (coverage: CoverageVerdict): OwnerCoverageStatus =>
  match(coverage)
    .with({ kind: "covered" }, (): OwnerCoverageStatus => ({ result: "pass" }))
    .with({ kind: "missing" }, ({ paths }): OwnerCoverageStatus => ({ result: "missing", paths }))
    .with({ kind: "infrastructure" }, ({ failure }): OwnerCoverageStatus => ({ result: "infrastructure", failure }))
    .exhaustive();

const mutationStatus = (mutation: MutationVerdict): OwnerMutationStatus =>
  match(mutation)
    .with({ kind: "verified" }, (run): OwnerMutationStatus => ({
      result: "verified",
      ownerChangedInWave: run.ownerChangedInWave,
      generated: run.generated,
      killed: run.killed,
      timedOut: run.timedOut,
      invalid: run.invalid,
      survivors: run.survivors,
      unmutated: run.unmutated,
    }))
    .with({ kind: "exempt" }, ({ reason }): OwnerMutationStatus => ({ result: "exempt", reason }))
    .with({ kind: "red-baseline" }, ({ failures }): OwnerMutationStatus => ({ result: "red-baseline", failures }))
    .with({ kind: "infrastructure" }, ({ failure }): OwnerMutationStatus => ({ result: "infrastructure", failure }))
    .exhaustive();

const invariantStatus = (verdict: InvariantVerdict): OwnerVerificationStatus => ({
  invariant: verdict.invariant,
  title: verdict.title,
  owner: verdict.owner,
  matrixTest: verdict.matrixTest,
  coverage: coverageStatus(verdict.coverage),
  mutation: mutationStatus(verdict.mutation),
});

/** The report when there is no observation to project, naming why. */
export const ownerVerificationNotObserved = (reason: string): OwnerVerificationStatusReport => ({ kind: "not-observed", reason });

/** The one status projection of a persisted owner-verification observation. */
export const projectOwnerVerificationStatus = (
  observation: OwnerVerificationObservation | undefined,
): OwnerVerificationStatusReport =>
  observation === undefined
    ? ownerVerificationNotObserved("no persisted completion result carries owner verification")
    : match(observation)
      .with({ kind: "unavailable" }, ({ failure }): OwnerVerificationStatusReport => ({ kind: "unavailable", failure }))
      .with({ kind: "verified" }, ({ boundMs, verdicts }): OwnerVerificationStatusReport =>
        ({ kind: "verified", boundMs, invariants: verdicts.map(invariantStatus) }))
      .exhaustive();

/**
 * Every blocking finding of the observation as its remedy line, naming the
 * Invariant: strengthen the matrix test to import what it misses, or to kill
 * the survivor at `<owner>:<line>` (`<operator>`), or declare a mutation
 * exemption with a reason. Empty when nothing blocks.
 */
export const ownerVerificationRemedies = (observation: OwnerVerificationObservation | undefined): readonly string[] =>
  observation === undefined ? [] : ownerVerificationFailures(observation).map(renderOwnerVerificationFailure);

const renderCoverage = (coverage: OwnerCoverageStatus): string =>
  match(coverage)
    .with({ result: "pass" }, () => "coverage pass")
    .with({ result: "missing" }, ({ paths }) => `coverage missing ${paths.join(", ")}`)
    .with({ result: "infrastructure" }, ({ failure }) => `coverage infrastructure failure (${failure.kind}): ${failure.detail}`)
    .exhaustive();

const renderSurvivor = (owner: string, survivor: SurvivorDiagnostic): string =>
  `    - survivor at ${owner}:${survivor.line}:${survivor.column} (${survivor.operator}): \`${survivor.original}\` -> \`${survivor.replacement}\``;

const renderMutation = (status: OwnerVerificationStatus): readonly string[] =>
  match(status.mutation)
    .with({ result: "verified" }, (run) => [
      `mutation generated ${run.generated}, killed ${run.killed}, timed out ${run.timedOut}, invalid ${run.invalid}, ` +
        `survived ${run.survivors.length}, unmutated ${run.unmutated}${run.ownerChangedInWave ? "" : " (owner unchanged in Wave)"}`,
      ...run.survivors.map((survivor) => renderSurvivor(status.owner, survivor)),
    ])
    .with({ result: "exempt" }, ({ reason }) => [`mutation exempt: ${reason}`])
    .with({ result: "red-baseline" }, ({ failures }) => [`mutation baseline red: ${failures.join("; ")}`])
    .with({ result: "infrastructure" }, ({ failure }) => [`mutation infrastructure failure (${failure.kind}): ${failure.detail}`])
    .exhaustive();

const renderInvariant = (status: OwnerVerificationStatus): readonly string[] => {
  const [summary, ...survivors] = renderMutation(status);
  return [
    `  - ${status.invariant} (owner ${status.owner}, matrix test ${status.matrixTest}): ${renderCoverage(status.coverage)}; ${summary}`,
    ...survivors,
  ];
};

/** The human lines of the projection: a header, then one line per Invariant and one per survivor. */
export const renderOwnerVerificationStatus = (report: OwnerVerificationStatusReport): readonly string[] =>
  match(report)
    .with({ kind: "not-observed" }, ({ reason }) => [`- ownerVerification: not observed (${reason})`])
    .with({ kind: "unavailable" }, ({ failure }) => [`- ownerVerification: unavailable (${failure.kind}): ${failure.detail}`])
    .with({ kind: "verified" }, ({ boundMs, invariants }) => [
      `- ownerVerification: ${invariants.length} Invariant(s), bound ${boundMs} ms`,
      ...invariants.flatMap(renderInvariant),
    ])
    .exhaustive();
