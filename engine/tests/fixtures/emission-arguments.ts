import type { PayloadProducerKindName } from "../../src/core/model-profiles";
import { REVIEWER_PAYLOAD_EXAMPLE_V2, reviewerPayloadV2Schema } from "../../src/core/reviewer-contract";
import { standaloneReviewerPayloadV3Schema } from "../../src/core/standalone-lineage-contract";

/**
 * The emission-tool argument fixtures shared by the emission admission and
 * ingestion suites: one construction per (kind, version) so a frozen-schema or
 * sentinel change is one edit here, never two copies drifting apart.
 */

/** A valid reviewer v2 payload as emission arguments, parametrized by claim text. */
const reviewerPayloadV2 = (claim: string) =>
  reviewerPayloadV2Schema.parse({
    schemaVersion: 2,
    kind: "standalone-review",
    findings: [{ ...REVIEWER_PAYLOAD_EXAMPLE_V2.findings[0]!, claim }],
  });
export const validReviewerArgumentsV2 = (claim: string): unknown => reviewerPayloadV2(claim);

/** A schema-valid successor v3 payload as emission arguments. The lineage
 *  digests are fixture-local; the successor's OWN joins re-check them against
 *  the prepared successor (the successor suites), so an admission or kernel
 *  selection only ever sees the parser's verdict. */
export const validReviewerArgumentsV3 = (overrides: Record<string, unknown> = {}): unknown =>
  standaloneReviewerPayloadV3Schema.parse({
    schemaVersion: 3,
    kind: "standalone-successor-review",
    lineageDigest: "a".repeat(64),
    snapshotDigest: "b".repeat(64),
    priorAssessments: [],
    findings: [],
    ...overrides,
  });

/** A valid judge-verdict v1 argument object addressed to `criterion`. */
export const validJudgeArguments = (criterion: string): unknown => ({
  criterion,
  rankings: [
    { candidate: "candidate-type-driven-fp.md", score: 8, fatal_flaw: null, strongest_idea: "the frozen registry" },
  ],
});

/** A valid refutation-verdict v1 argument object addressed to `criterion`. */
export const validRefutationArguments = (criterion: string): unknown => ({
  criterion,
  verdicts: [{ finding_id: "T1:code-reviewer-1", verdict: "refuted", reasoning: "the failure cannot be triggered" }],
});

/**
 * AD-5's discriminating case per producer kind: whitespace-only advisory prose
 * the frozen JSON Schema's shape rules admit (the emitted bytes express
 * minLength only, never the zod trim refinement) but the engine's admission
 * parse refuses. The reviewer fixture is the v2 shape.
 */
export const whitespaceOnlyArguments = (kind: PayloadProducerKindName): unknown => {
  switch (kind) {
    case "reviewer-payload": {
      const finding = reviewerPayloadV2("real claim").findings[0]!;
      return { schemaVersion: 2, kind: "standalone-review", findings: [{ ...finding, claim: "   " }] };
    }
    case "judge-verdict":
      return {
        criterion: "extensibility",
        rankings: [{ candidate: "candidate-type-driven-fp.md", score: 8, fatal_flaw: null, strongest_idea: "   " }],
      };
    case "refutation-verdict":
      return {
        criterion: "reproduction",
        verdicts: [{ finding_id: "T1:code-reviewer-1", verdict: "refuted", reasoning: "   " }],
      };
  }
};
