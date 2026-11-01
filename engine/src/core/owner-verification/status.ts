/**
 * Owner verification as status reports it (AD-10 status half; FR-028,
 * AS-029). Pure: one `OwnerVerificationStatusReport` is what
 * `helper orchestration status` says about owner verification, the report
 * both renderers serialize.
 *
 * The report is the persisted observation itself: its verdicts are the very
 * `InvariantVerdict`s the gate judged and the completion result stores, with
 * no status-only copy to keep in step. The only status-specific case is
 * `not-observed`. The deep part here is the free-text renderer.
 *
 * The next action's remedies (AS-030) are not decided here: they travel on
 * the completion-suite readiness fact that judged the rejection
 * (`ownerVerificationRemedies`, in the gate diagnostic's own wording), so a
 * rejection and its remedies are one value (#135). Each
 * Invariant's mutation summary is `verdict.ts`'s `renderMutationVerdict`,
 * the one wording of a `MutationVerdict`.
 */

import { match } from "ts-pattern";
import { renderMutationVerdict } from "./verdict";
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

/** The report when there is no observation, naming why. */
export const ownerVerificationNotObserved = (reason: string): OwnerVerificationStatusReport =>
  ({ kind: "not-observed", reason });

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
