/**
 * Existing issued-successor entry surface for capture and protocol consumers.
 * Admission and aggregation share the Standalone Review aggregate's private
 * prepared-source/evidence membership; there is no second lifecycle here.
 *
 * The successor's emission binding is NOT derived here. Its one derivation is
 * the frozen-registry mint, reached from the durable v3 registration through
 * `core/reviewer-emission-route` — the same derivation the render path and the
 * capture runtime use — so no second copy of the tool name or schema digest
 * exists to drift. The successor's prior-origin/coverage admission joins are
 * SOURCE-BLIND by construction: they parse and join captured bytes the same
 * way whether the emission tool or the final message produced them, so an
 * emission-selected payload crosses the identical joins and a source can
 * never override issuance.
 */
export {
  standaloneSuccessorReviewerRegistration,
  buildStandaloneSuccessorReviewerContext,
  parseIssuedStandaloneSuccessorReviewer,
  admitStandaloneSuccessorReviewer,
  aggregateIssuedStandaloneSuccessorEvidence,
  type IssuedStandaloneSuccessorReviewer,
} from "./standalone-review";
