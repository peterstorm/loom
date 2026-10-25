/**
 * Owner verification as status reports it (AD-10 status half; FR-028,
 * AS-029, AS-030). Pure: one `OwnerVerificationStatus` value holds what
 * `helper orchestration status` says about owner verification, the report
 * both renderers serialize and the remedies the next action names, so the
 * two can never disagree about whether there was anything to report.
 *
 * The report is the persisted observation itself: its verdicts are the very
 * `InvariantVerdict`s the gate judged and the completion result stores, with
 * no status-only copy to keep in step. The only status-specific case is
 * `not-observed`. The deep part here is the free-text renderer.
 *
 * Blocking findings and their remedy text are not decided here: they come
 * from `verdict.ts` (`ownerVerificationFailures`,
 * `renderOwnerVerificationFailure`), the same source the gate's diagnostics
 * read, so status names exactly the remedy the gate blocked on. Each
 * Invariant's mutation summary is `verdict.ts`'s `renderMutationVerdict`,
 * the one wording of a `MutationVerdict`.
 */

import { match } from "ts-pattern";
import { ownerVerificationFailures, renderMutationVerdict, renderOwnerVerificationFailure } from "./verdict";
import type {
  CoverageVerdict,
  InvariantVerdict,
  OwnerVerificationObservation,
  SurvivorDiagnostic,
} from "./types";

/**
 * Owner verification of the latest persisted completion result.
 * - `not-observed`: there is nothing to report, and `reason` says why: no
 *   persisted result, one that carries no owner verification, or a persisted
 *   result status could not read.
 * - otherwise the persisted `OwnerVerificationObservation` as the gate wrote
 *   it: `unavailable` when the check could not run at all, or `verified` with
 *   one `InvariantVerdict` per owed Invariant (`[]` when the Wave owes none)
 *   and the reported time bound of the mutation runs.
 */
export type OwnerVerificationStatusReport =
  | Readonly<{ kind: "not-observed"; reason: string }>
  | OwnerVerificationObservation;

/**
 * What status says about owner verification: the report, and every blocking
 * finding of it as its remedy line (empty when nothing blocks or nothing was
 * observed). Whether the remedies reach the next action is the completion
 * suite readiness's call, not this value's.
 */
export type OwnerVerificationStatus = Readonly<{
  report: OwnerVerificationStatusReport;
  remedies: readonly string[];
}>;

/** The status when there is no observation to report, naming why. It owes no remedy. */
export const ownerVerificationNotObserved = (reason: string): OwnerVerificationStatus =>
  ({ report: { kind: "not-observed", reason }, remedies: [] });

/**
 * The status of a persisted observation. Each remedy names the Invariant:
 * strengthen the matrix test to import what it misses, or to kill the
 * survivor at `<owner>:<line>` (`<operator>`), or declare a mutation
 * exemption with a reason.
 */
export const observedOwnerVerificationStatus = (observation: OwnerVerificationObservation): OwnerVerificationStatus =>
  ({ report: observation, remedies: ownerVerificationFailures(observation).map(renderOwnerVerificationFailure) });

const renderCoverage = (coverage: CoverageVerdict): string =>
  match(coverage)
    .with({ kind: "covered" }, () => "coverage pass")
    .with({ kind: "missing" }, ({ paths }) => `coverage missing ${paths.join(", ")}`)
    .with({ kind: "infrastructure" }, ({ failure }) => `coverage infrastructure failure (${failure.kind}): ${failure.detail}`)
    .exhaustive();

const renderSurvivor = (owner: string, survivor: SurvivorDiagnostic): string =>
  `    - survivor at ${owner}:${survivor.line}:${survivor.column} (${survivor.operator}): \`${survivor.original}\` -> \`${survivor.replacement}\``;

const renderInvariant = (verdict: InvariantVerdict): readonly string[] => [
  `  - ${verdict.invariant} (owner ${verdict.owner}, matrix test ${verdict.matrixTest}): ` +
    `${renderCoverage(verdict.coverage)}; ${renderMutationVerdict(verdict.mutation)}`,
  ...(verdict.mutation.kind === "verified" ? verdict.mutation.survivors.map((survivor) => renderSurvivor(verdict.owner, survivor)) : []),
];

/** The human lines of the report: a header, then one line per Invariant and one per survivor. */
export const renderOwnerVerificationStatus = (report: OwnerVerificationStatusReport): readonly string[] =>
  match(report)
    .with({ kind: "not-observed" }, ({ reason }) => [`- ownerVerification: not observed (${reason})`])
    .with({ kind: "unavailable" }, ({ failure }) => [`- ownerVerification: unavailable (${failure.kind}): ${failure.detail}`])
    .with({ kind: "verified" }, ({ boundMs, verdicts }) => [
      `- ownerVerification: ${verdicts.length} Invariant(s), bound ${boundMs} ms`,
      ...verdicts.flatMap(renderInvariant),
    ])
    .exhaustive();
