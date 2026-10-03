/**
 * Existing issued-successor entry surface for capture and protocol consumers.
 * Admission and aggregation share the Standalone Review aggregate's private
 * prepared-source/evidence membership; there is no second lifecycle here.
 */
export {
  standaloneSuccessorReviewerRegistration,
  buildStandaloneSuccessorReviewerContext,
  parseIssuedStandaloneSuccessorReviewer,
  admitStandaloneSuccessorReviewer,
  aggregateIssuedStandaloneSuccessorEvidence,
  type IssuedStandaloneSuccessorReviewer,
} from "./standalone-review";
