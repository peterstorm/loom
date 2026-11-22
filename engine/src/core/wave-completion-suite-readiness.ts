/**
 * Wave completion suite readiness — the pure projection of whether protected
 * authority holds an exact, current accepted completion suite for a Wave.
 *
 * The gate renders it as a check and status reports it as a fact; both read
 * this one derivation, so they cannot disagree about suite state. Core
 * performs no I/O: the current workspace and persisted result arrive as shell
 * observations. It is derived only for a `ManifestedTaskGraph`: a graph with
 * no frozen Verification Manifest has no completion suite to be ready.
 *
 * INV-3: the roster a receipt or persisted result must match is authorized
 * by `authorizeGraphCompletionSuite`, the one function the gate also calls,
 * so readiness and the gate cannot disagree about which owned Invariants the
 * Wave owes.
 */

import type {
  ActiveWaveGateRegistration,
  TaskGraph,
  WaveCompletionResultObservation,
  WaveCompletionSuiteReadiness,
  WaveWorkspaceObservation,
} from "../types";
import {
  evaluateWaveCompletionSuite,
  parseAcceptedWaveCompletionReceipt,
  ownerVerificationFindingLines,
  rejectionFailures,
  type AcceptedWaveCompletionReceipt,
  type CompletionAuthorityFailure,
  type CompletionInfrastructureFailure,
} from "./completion-suite";
import { compareStrings } from "./ordering";
import { deriveProjectVerificationCoverage } from "./verification-manifest";
import { canonicalRecord, canonicalStructuralEquals, isNonEmpty, type DomainResult, type NonEmpty } from "./orchestration-contract";
import { emptyAcceptanceExpectation, graphAcceptanceExpectation } from "./acceptance-contract";
import { authorizeGraphCompletionSuite } from "./owner-verification/suite-authority";
import type { ManifestedTaskGraph } from "./manifested-task-graph";


function exactCompletionSuiteError(
  registration: ActiveWaveGateRegistration,
  receipt: AcceptedWaveCompletionReceipt,
  graph: ManifestedTaskGraph,
): string | null {
  const parsed = parseAcceptedWaveCompletionReceipt(receipt);
  if (!parsed.ok) return parsed.error.errors.join("; ");
  if (
    parsed.value.runId !== registration.runId || parsed.value.wave !== registration.wave ||
    parsed.value.revision !== registration.revision ||
    parsed.value.authorityDigest !== registration.authorityDigest
  ) {
    return "accepted suite does not match the active Wave Gate run/Wave/revision/authority";
  }
  if (parsed.value.manifestDigest !== graph.verification_manifest.manifestDigest) {
    return "accepted suite manifest digest does not match protected verification_manifest";
  }
  const authorized = authorizeGraphCompletionSuite(graph, parsed.value.workspaceDigest);
  if (!authorized.ok) return authorized.error.errors.join("; ");
  if (parsed.value.manifestDigest !== authorized.value.manifestDigest ||
      parsed.value.suiteDigest !== authorized.value.suiteDigest ||
      parsed.value.checks.length !== authorized.value.checks.length) {
    return "accepted suite does not match the exact protected completion roster";
  }
  for (let index = 0; index < authorized.value.checks.length; index += 1) {
    const expected = authorized.value.checks[index];
    const actual = parsed.value.checks[index];
    if (actual.checkId !== expected.checkId || actual.scope !== expected.scope) {
      return "accepted suite does not match the exact protected completion roster";
    }
    if (actual.outcome.kind !== "observed") return `accepted suite check ${actual.checkId} is not observed`;
    const reportMatches = expected.reportPolicy.kind === "not-required"
      ? actual.outcome.report.kind === "not-required"
      : actual.outcome.report.kind === "produced" && actual.outcome.report.path === expected.reportPolicy.path;
    if (!reportMatches) return `accepted suite check ${actual.checkId} contradicts its report policy`;
  }
  const judged = parsed.value.acceptance?.expectation ?? emptyAcceptanceExpectation(registration.wave);
  if (!canonicalStructuralEquals(judged, graphAcceptanceExpectation(graph, registration.wave))) {
    return "accepted suite was judged under a different acceptance expectation than the protected contracts derive";
  }
  return null;
}

/**
 * Where a Wave's suite authority lives: nowhere, on the active registration
 * (which may not hold a receipt yet), or on the completed registration in
 * `wave_gate_history`, which always holds one.
 */
type CompletionSuiteReadinessSource =
  | Readonly<{ kind: "none" }>
  | Readonly<{ kind: "active"; registration: ActiveWaveGateRegistration; receipt: AcceptedWaveCompletionReceipt | undefined }>
  | Readonly<{ kind: "terminal"; receipt: AcceptedWaveCompletionReceipt }>;

function completionSuiteReadinessSource(
  graph: TaskGraph,
  wave: number | null,
): CompletionSuiteReadinessSource {
  if (graph.active_wave_gate !== undefined && (wave === null || graph.active_wave_gate.wave === wave)) {
    return canonicalRecord({
      kind: "active",
      registration: graph.active_wave_gate,
      receipt: graph.active_wave_completion_suite,
    });
  }
  const completed = wave === null ? undefined : (graph.wave_gate_history ?? []).find((entry) => entry.wave === wave);
  return completed === undefined
    ? canonicalRecord({ kind: "none" })
    : canonicalRecord({ kind: "terminal", receipt: completed.completionSuite });
}

function sortedUniqueNonEmpty<T extends string>(head: T, tail: readonly T[]): NonEmpty<T> {
  const [first, ...rest] = [...new Set([head, ...tail])].sort(compareStrings);
  if (first === undefined) throw new Error("non-empty completion failure set became empty");
  return Object.freeze([first, ...rest]);
}

function completionEvaluationFailureDetail(
  authorityFailures: readonly CompletionAuthorityFailure[],
  infrastructureFailures: readonly CompletionInfrastructureFailure[],
): string {
  const kinds = [
    ...authorityFailures.map((failure) => failure.kind),
    ...infrastructureFailures.map((failure) => failure.kind),
  ].sort(compareStrings);
  return `persisted completion result is invalid for current authority: ${kinds.join(", ")}`;
}

type RequiredWaveCompletionSuite = Omit<Extract<WaveCompletionSuiteReadiness, { kind: "required" }>, "projectVerificationCoverage">;

function requiredWaveCompletionSuite(
  reason: RequiredWaveCompletionSuite["reason"],
  detail: string,
  verificationManifestDigest: RequiredWaveCompletionSuite["verificationManifestDigest"],
  acceptedResultDigest: RequiredWaveCompletionSuite["acceptedResultDigest"] = null,
): RequiredWaveCompletionSuite {
  return canonicalRecord({
    kind: "required",
    reason,
    detail,
    verificationManifestDigest,
    acceptedResultDigest,
  });
}

function parseWorkspaceObservation(
  currentWorkspace: WaveWorkspaceObservation | undefined,
  manifestDigest: RequiredWaveCompletionSuite["verificationManifestDigest"],
  acceptedResultDigest: RequiredWaveCompletionSuite["acceptedResultDigest"] = null,
): DomainResult<Extract<WaveWorkspaceObservation, { kind: "observed" }>, RequiredWaveCompletionSuite> {
  if (currentWorkspace === undefined) {
    return canonicalRecord({
      ok: false,
      error: requiredWaveCompletionSuite(
        "workspace-observation-missing",
        "current Wave workspace observation is missing",
        manifestDigest,
        acceptedResultDigest,
      ),
    });
  }
  return currentWorkspace.kind === "unavailable"
    ? canonicalRecord({
        ok: false,
        error: requiredWaveCompletionSuite(
          "workspace-observation-unavailable",
          currentWorkspace.reason,
          manifestDigest,
          acceptedResultDigest,
        ),
      })
    : canonicalRecord({ ok: true, value: currentWorkspace });
}

function deriveCompletionSuiteOutcome(
  graph: ManifestedTaskGraph,
  source: CompletionSuiteReadinessSource,
  currentWorkspace: WaveWorkspaceObservation | undefined,
  currentResult: WaveCompletionResultObservation | undefined,
) {
  const manifestDigest = graph.verification_manifest.manifestDigest;
  const suiteMissing = requiredWaveCompletionSuite(
    "accepted-suite-missing",
    "an exact accepted Wave completion suite is required",
    manifestDigest,
  );
  if (source.kind === "none") return suiteMissing;
  if (source.kind === "terminal") return terminalReceiptOutcome(source.receipt);
  if (source.receipt !== undefined) {
    return activeReceiptOutcome(graph, source.registration, source.receipt, currentWorkspace);
  }
  const workspace = parseWorkspaceObservation(currentWorkspace, manifestDigest);
  if (!workspace.ok) return workspace.error;
  if (currentResult === undefined || currentResult.kind === "absent") return suiteMissing;
  if (currentResult.kind === "unavailable") {
    return requiredWaveCompletionSuite(
      "completion-result-unavailable",
      currentResult.reason,
      manifestDigest,
    );
  }
  return persistedResultOutcome(graph, source.registration, workspace.value.workspaceDigest, currentResult.result);
}

/**
 * Judge the persisted result of an active Wave without a receipt against the
 * roster the graph's Wave owes (`authorizeGraphCompletionSuite`, INV-3). A
 * semantic rejection stays a rejection when the owner check beside it could
 * not decide, exactly as the gate replays it (the rejection's `cause`).
 */
function persistedResultOutcome(
  graph: ManifestedTaskGraph,
  registration: ActiveWaveGateRegistration,
  workspaceDigest: Extract<WaveWorkspaceObservation, { kind: "observed" }>["workspaceDigest"],
  result: Extract<WaveCompletionResultObservation, { kind: "observed" }>["result"],
) {
  const manifestDigest = graph.verification_manifest.manifestDigest;
  const authorized = authorizeGraphCompletionSuite(graph, workspaceDigest);
  if (!authorized.ok) {
    return requiredWaveCompletionSuite("completion-result-invalid", authorized.error.errors.join("; "), manifestDigest);
  }
  const evaluation = evaluateWaveCompletionSuite(authorized.value, result, graphAcceptanceExpectation(graph, registration.wave));
  if (evaluation.kind === "accepted") {
    return requiredWaveCompletionSuite(
      "accepted-suite-missing",
      "persisted completion result is accepted; protected receipt recovery required",
      manifestDigest,
    );
  }
  if (evaluation.cause !== "semantic") {
    const { authority, infrastructure } = rejectionFailures(evaluation);
    return requiredWaveCompletionSuite(
      "completion-result-invalid",
      completionEvaluationFailureDetail(authority, infrastructure),
      manifestDigest,
    );
  }
  const [firstSemanticFailure, ...remainingSemanticFailures] = evaluation.semanticFailures;
  const remedies = ownerVerificationFindingLines(evaluation);
  return canonicalRecord({
    kind: "rejected",
    verificationManifestDigest: manifestDigest,
    suiteDigest: authorized.value.suiteDigest,
    workspaceDigest: authorized.value.workspaceDigest,
    failureKinds: sortedUniqueNonEmpty(firstSemanticFailure.kind, remainingSemanticFailures.map((failure) => failure.kind)),
    checkIds: sortedUniqueNonEmpty(firstSemanticFailure.checkId, remainingSemanticFailures.map((failure) => failure.checkId)),
    // The remedies come from the rejection judged here, never re-derived from
    // the observation, so the next action cannot disagree with this fact.
    ownerVerificationRemedies: isNonEmpty(remedies) ? Object.freeze(remedies) : null,
  });
}

/** A completed Wave's outcome: the receipt its completed registration froze, under the manifest it was judged by. */
function terminalReceiptOutcome(receipt: AcceptedWaveCompletionReceipt) {
  return canonicalRecord({
    kind: "accepted",
    verificationManifestDigest: receipt.manifestDigest,
    suiteDigest: receipt.suiteDigest,
    resultDigest: receipt.resultDigest,
    workspaceDigest: receipt.workspaceDigest,
    checkCount: receipt.checks.length,
  });
}

/** The outcome of an active Wave whose receipt protected authority already holds. */
function activeReceiptOutcome(
  graph: ManifestedTaskGraph,
  registration: ActiveWaveGateRegistration,
  receipt: AcceptedWaveCompletionReceipt,
  currentWorkspace: WaveWorkspaceObservation | undefined,
) {
  const manifestDigest = graph.verification_manifest.manifestDigest;
  const exactError = exactCompletionSuiteError(registration, receipt, graph);
  if (exactError !== null) {
    return requiredWaveCompletionSuite("accepted-suite-invalid", exactError, manifestDigest, receipt.resultDigest);
  }
  const workspace = parseWorkspaceObservation(currentWorkspace, manifestDigest, receipt.resultDigest);
  if (!workspace.ok) return workspace.error;
  if (workspace.value.workspaceDigest !== receipt.workspaceDigest) {
    return canonicalRecord({
      kind: "stale",
      verificationManifestDigest: manifestDigest,
      suiteDigest: receipt.suiteDigest,
      resultDigest: receipt.resultDigest,
      acceptedWorkspaceDigest: receipt.workspaceDigest,
      currentWorkspaceDigest: workspace.value.workspaceDigest,
      checkCount: receipt.checks.length,
    });
  }
  return canonicalRecord({
    kind: "accepted",
    verificationManifestDigest: manifestDigest,
    suiteDigest: receipt.suiteDigest,
    resultDigest: receipt.resultDigest,
    workspaceDigest: receipt.workspaceDigest,
    checkCount: receipt.checks.length,
  });
}

/** Configuration coverage and suite outcome are independent projections of protected authority. */
export function deriveWaveCompletionSuiteReadiness(
  graph: ManifestedTaskGraph,
  wave: number | null,
  currentWorkspace: WaveWorkspaceObservation | undefined,
  currentResult: WaveCompletionResultObservation | undefined = undefined,
): WaveCompletionSuiteReadiness {
  const source = completionSuiteReadinessSource(graph, wave);
  const outcome = deriveCompletionSuiteOutcome(graph, source, currentWorkspace, currentResult);
  const authority = source.kind === "terminal" ? source.receipt : graph.verification_manifest;
  return canonicalRecord({ ...outcome, projectVerificationCoverage: deriveProjectVerificationCoverage(authority) });
}
