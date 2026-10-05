/**
 * Existing LC-2 entry surface for production drivers, replay and P3 consumers.
 * The executable reducer and its publication proof share the Standalone Review
 * custody core with source admission. No raw-result mint is exported. Refutation
 * completion receipts live in standalone-refutation-completion and the durable
 * checkpoint codec in standalone-review-checkpoint; callers import those directly.
 */
export {
  parseAuthoritativeStandaloneReviewResult,
  isAuthoritativeStandaloneReviewResult,
  readStandaloneReviewPublication,
  STANDALONE_REVIEW_DECLARED_TRANSITIONS,
  isDeclaredStandaloneReviewTransition,
  startStandaloneReviewMachine,
  reduceStandaloneReviewMachine,
  type StandaloneReadyToFinalizeState,
  type AuthoritativeStandaloneReviewResult,
  type StandaloneDoneState,
  type StandaloneReviewMachineState,
  type StandaloneReviewMachineEvent,
} from "./standalone-review";
