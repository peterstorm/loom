/**
 * Wave completion suite readiness — the pure projection of whether protected
 * authority holds an exact, current accepted completion suite for a Wave.
 *
 * The gate renders it as a check and status reports it as a fact; both read
 * this one derivation, so they cannot disagree about suite state. Core
 * performs no I/O: the current workspace and persisted result arrive as shell
 * observations.
 *
 * INV-3 sibling: the roster a receipt must match is re-authorized with the
 * owner check authority `ownerCheckAuthority` derives from the same graph, so
 * readiness and the gate cannot disagree about which owned Invariants the
 * Wave owes.
 */

import type {
  ActiveWaveGateRegistration,
  CompletedWaveGateRegistration,
  TaskGraph,
  WaveCompletionResultObservation,
  WaveCompletionSuiteReadiness,
  WaveWorkspaceObservation,
} from "../types";
import {
  evaluateWaveCompletionSuite,
  parseAcceptedWaveCompletionReceipt,
  type AcceptedWaveCompletionReceipt,
  type CompletionAuthorityFailure,
  type CompletionInfrastructureFailure,
} from "./completion-suite";
import { compareStrings } from "./ordering";
import {
  authorizeWaveCompletionSuite,
  legacyDefaultVerificationManifest,
  deriveProjectVerificationCoverage,
} from "./verification-manifest";
import { canonicalRecord, canonicalStructuralEquals, type DomainResult, type NonEmpty } from "./orchestration-contract";
import { emptyAcceptanceExpectation, graphAcceptanceExpectation } from "./acceptance-contract";
import { ownerCheckAuthority } from "./owner-verification/obligations";


function exactCompletionSuiteError(
  registration: ActiveWaveGateRegistration,
  receipt: AcceptedWaveCompletionReceipt,
  graph: TaskGraph,
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
  const manifest = graph.verification_manifest ?? legacyDefaultVerificationManifest();
  if (parsed.value.manifestDigest !== manifest.manifestDigest) {
    return "accepted suite manifest digest does not match protected verification_manifest";
  }
  const authorized = authorizeWaveCompletionSuite(
    manifest,
    registration,
    parsed.value.workspaceDigest,
    ownerCheckAuthority(graph, registration.wave),
  );
  if (!authorized.ok) return authorized.error.errors.join("; ");
  if (parsed.value.manifestDigest !== authorized.value.manifestDigest ||
      parsed.value.suiteDigest !== authorized.value.suiteDigest ||
      parsed.value.checks.length !== authorized.value.checks.length) {
    return "accepted suite does not match the exact protected completion roster";
  }
  for (let index = 0; index < authorized.value.checks.length; index += 1) {
    const expected = authorized.value.checks[index]!;
    const actual = parsed.value.checks[index]!;
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

type CompletionSuiteReadinessSource = Readonly<{
  receipt: AcceptedWaveCompletionReceipt | undefined;
  registration: ActiveWaveGateRegistration | CompletedWaveGateRegistration | undefined;
  legacyHistory: boolean;
  terminal: boolean;
}>;

function completionSuiteReadinessSource(
  graph: TaskGraph,
  wave: number | null,
): CompletionSuiteReadinessSource {
  if (graph.active_wave_gate !== undefined && (wave === null || graph.active_wave_gate.wave === wave)) {
    return canonicalRecord({
      receipt: graph.active_wave_completion_suite,
      registration: graph.active_wave_gate,
      legacyHistory: false,
      terminal: false,
    });
  }
  const terminal = wave === null ? undefined : (graph.wave_gate_history ?? []).find((entry) => entry.wave === wave);
  return terminal?.schemaVersion === 2
    ? canonicalRecord({ receipt: terminal.completionSuite, registration: terminal, legacyHistory: false, terminal: true })
    : canonicalRecord({
        receipt: undefined,
        registration: terminal,
        legacyHistory: terminal?.schemaVersion === 1,
        terminal: terminal !== undefined,
      });
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
  graph: TaskGraph,
  source: CompletionSuiteReadinessSource,
  currentWorkspace: WaveWorkspaceObservation | undefined,
  currentResult: WaveCompletionResultObservation | undefined,
) {
  const manifest = graph.verification_manifest;
  const manifestDigest = manifest?.manifestDigest ?? null;
  if (source.receipt === undefined) {
    if ((manifestDigest === null && graph.active_wave_completion_suite === undefined) || source.legacyHistory) {
      return canonicalRecord({ kind: "legacy-unavailable", verificationManifestDigest: null });
    }
    if (source.registration?.kind !== "active-wave-gate" || manifest === undefined) {
      return requiredWaveCompletionSuite(
        "accepted-suite-missing",
        "an exact accepted Wave completion suite is required",
        manifestDigest,
      );
    }
    const workspace = parseWorkspaceObservation(currentWorkspace, manifestDigest);
    if (!workspace.ok) return workspace.error;
    if (currentResult === undefined || currentResult.kind === "absent") {
      return requiredWaveCompletionSuite(
        "accepted-suite-missing",
        "an exact accepted Wave completion suite is required",
        manifestDigest,
      );
    }
    if (currentResult.kind === "unavailable") {
      return requiredWaveCompletionSuite(
        "completion-result-unavailable",
        currentResult.reason,
        manifestDigest,
      );
    }
    return persistedResultOutcome(graph, source.registration, manifest, workspace.value.workspaceDigest, currentResult.result);
  }
  return receiptOutcome(graph, source, source.receipt, currentWorkspace);
}

/**
 * Judge the persisted result of an active Wave without a receipt against the
 * roster the graph's Wave owes: re-authorized with the owner check authority
 * `ownerCheckAuthority` derives from the same graph (INV-3).
 */
function persistedResultOutcome(
  graph: TaskGraph,
  registration: ActiveWaveGateRegistration,
  manifest: NonNullable<TaskGraph["verification_manifest"]>,
  workspaceDigest: Extract<WaveWorkspaceObservation, { kind: "observed" }>["workspaceDigest"],
  result: Extract<WaveCompletionResultObservation, { kind: "observed" }>["result"],
) {
  const manifestDigest = manifest.manifestDigest;
  const authorized = authorizeWaveCompletionSuite(manifest, registration, workspaceDigest, ownerCheckAuthority(graph, registration.wave));
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
  const [firstSemanticFailure, ...remainingSemanticFailures] = evaluation.semanticFailures;
  if (evaluation.authorityFailures.length > 0 || evaluation.infrastructureFailures.length > 0 ||
      firstSemanticFailure === undefined) {
    return requiredWaveCompletionSuite(
      "completion-result-invalid",
      completionEvaluationFailureDetail(evaluation.authorityFailures, evaluation.infrastructureFailures),
      manifestDigest,
    );
  }
  return canonicalRecord({
    kind: "rejected",
    verificationManifestDigest: manifestDigest,
    suiteDigest: authorized.value.suiteDigest,
    workspaceDigest: authorized.value.workspaceDigest,
    failureKinds: sortedUniqueNonEmpty(firstSemanticFailure.kind, remainingSemanticFailures.map((failure) => failure.kind)),
    checkIds: sortedUniqueNonEmpty(firstSemanticFailure.checkId, remainingSemanticFailures.map((failure) => failure.checkId)),
  });
}

/** The outcome of a Wave whose receipt protected authority already holds. */
function receiptOutcome(
  graph: TaskGraph,
  source: CompletionSuiteReadinessSource,
  receipt: AcceptedWaveCompletionReceipt,
  currentWorkspace: WaveWorkspaceObservation | undefined,
) {
  const manifestDigest = graph.verification_manifest?.manifestDigest ?? null;
  if (source.registration === undefined) {
    const detail = "accepted Wave completion suite has no active or terminal registration authority";
    return requiredWaveCompletionSuite("accepted-suite-invalid", detail, manifestDigest, receipt.resultDigest);
  }
  if (source.registration.kind === "active-wave-gate") {
    const exactError = exactCompletionSuiteError(source.registration, receipt, graph);
    if (exactError !== null) {
      return requiredWaveCompletionSuite("accepted-suite-invalid", exactError, manifestDigest, receipt.resultDigest);
    }
  }
  if (source.terminal) {
    return canonicalRecord({
      kind: "accepted",
      verificationManifestDigest: receipt.manifestDigest,
      suiteDigest: receipt.suiteDigest,
      resultDigest: receipt.resultDigest,
      workspaceDigest: receipt.workspaceDigest,
      checkCount: receipt.checks.length,
    });
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
  graph: TaskGraph,
  wave: number | null,
  currentWorkspace: WaveWorkspaceObservation | undefined,
  currentResult: WaveCompletionResultObservation | undefined = undefined,
): WaveCompletionSuiteReadiness {
  const source = completionSuiteReadinessSource(graph, wave);
  const outcome = deriveCompletionSuiteOutcome(graph, source, currentWorkspace, currentResult);
  if (outcome.kind === "legacy-unavailable") return outcome;
  const authority = source.terminal && source.receipt !== undefined
    ? source.receipt
    : graph.verification_manifest ?? legacyDefaultVerificationManifest();
  return canonicalRecord({ ...outcome, projectVerificationCoverage: deriveProjectVerificationCoverage(authority) });
}
