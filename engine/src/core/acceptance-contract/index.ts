/**
 * Acceptance Contracts: the plan's `## Contracts`, made executable.
 *
 * A contract's **contract Task** writes a declarations-only types file, the
 * dedicated acceptance test files, and compiling stubs. Its Wave Gate must
 * observe every acceptance testcase FAIL (RED) — collected, so a file that
 * never loads is not a behavioral RED. That gate then stamps the **Acceptance
 * Freeze**: the frozen paths' bytes and the roster of testcases observed red.
 *
 * Each testcase names the Requirements it decides (`AS-003: …`), and each
 * Requirement has exactly one completion Wave, so a testcase is **due** once
 * the Wave completing all its anchors gates: from then on every Wave Gate needs
 * it present and passing (GREEN). Before that it is **pending**, and its
 * failure is excused — nothing else is. A gate whose report fails outside the
 * acceptance files, or fails a due testcase, is never excused.
 *
 * Tasks run between the contract Wave and the last Wave completing one of its
 * anchors see pending testcases fail in any full-suite run, so their
 * task-level regression obligation is waived by the engine
 * (`acceptance-red-window`) and the Wave Gate's engine-run suite, which knows
 * which failures are pending, is their regression authority.
 *
 * Pure: the shell supplies the JUnit projection, report digests and frozen
 * path digests; this module decides and returns data.
 */

// The curated public surface: what callers outside these modules use. The
// sub-modules export more than this file re-exports, for their siblings; only
// this file is the interface. The red-window waiver reason belongs to the
// verification-policy vocabulary and is imported from there.
export {
  CONTRACT_ID,
  COVERABLE_ANCHOR,
  type AcceptanceContract,
  type AcceptanceFreeze,
  type AcceptanceTestcase,
  type ContractAcceptanceFile,
  type ContractDeclaration,
  type ContractProblem,
  type ContractRevision,
  type ContractTaskView,
  type ContractTypes,
  type FrozenPathDigest,
  type PlanContract,
} from "./model";
export {
  acceptanceContractsFromPlan,
  acceptanceObservationProblem,
  contractClaimants,
  contractRole,
  contractWave,
  contractWriter,
  coveredAnchors,
  frozenPaths,
  redWindowTaskIds,
  type ContractRole,
  type ContractWriterProblem,
} from "./tasks";
export {
  acceptanceExpectation,
  acceptanceObservation,
  emptyAcceptanceExpectation,
  graphAcceptanceExpectation,
  judgeAcceptance,
  observeAcceptanceFacts,
  owesAcceptance,
  recordedAcceptanceVerdict,
  renderAcceptanceFailure,
  testcaseAcceptanceFile,
  unprojectableFacts,
  type AcceptanceExpectation,
  type AcceptanceFailure,
  type AcceptanceJudgment,
  type AcceptanceObservation,
  type AcceptanceReportFacts,
  type ContractGateExpectation,
  type ObservedAcceptanceTestcase,
  type RecordedAcceptanceVerdict,
} from "./gate";
export {
  frozenPathDigests,
  frozenPathDrift,
  frozenPathsToObserve,
  renderFrozenPathDrift,
  renderFrozenPathProblems,
  stampAcceptanceFreezes,
  type FrozenPathDrift,
  type FrozenPathObservation,
  type FrozenPathObservations,
  type FrozenPathProblem,
} from "./freeze";
export { parseAcceptanceContracts, parseAcceptanceExpectation, parseAcceptanceReportFacts } from "./wire";
export { contractBindingErrors, type ContractBindingTask } from "./binding";
