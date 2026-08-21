import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  canonicalRecord,
  canonicalStructuralEquals,
  parseArtifactDigest,
  parseBlockedDiagnostic,
  parseEffectId,
  reconcileEffectReceipt,
  type AcceptedAgentResult,
  type ArtifactDigest,
  type ArtifactRef,
  type ArtifactSetPublished,
  type EffectIntent,
  type EffectReceipt,
  type InfrastructureRetryDiagnostic,
  type OrchestrationRunId,
  type PublishArtifactSet,
  type PublicationAuthorityResolver,
  type RequestId,
  type SlotId,
  sameAgentRequestAuthority,
} from "./orchestration-contract";
import {
  aggregateStandaloneReview,
  canonicalStandaloneResultArtifact,
  finalizeStandaloneReview,
  fingerprintCapturedReviewerResult,
  freezeStandalonePanelAuthority as freezePanelReadAuthority,
  parseCapturedReviewerResult,
  parseFrozenStandalonePanelAuthority,
  parseStandaloneAggregate,
  parseStandaloneReviewAuthority,
  parseStandalonePanelOutcomes,
  parseStandaloneRosterCompletionProof,
  serializeAdjudicatedStandaloneReview,
  serializeStandaloneAggregate,
  serializeStandaloneReviewAuthority,
  type AdjudicatedStandaloneReview,
  type CapturedReviewerResult,
  type FrozenStandalonePanelAuthority,
  type FrozenStandaloneReviewAuthority,
  type ParsedPanelOutcomes,
  type StandaloneReviewAggregate,
  type StandaloneRosterCompletionProof,
} from "./standalone-review";
import {
  parseRefutationPanelAuthority,
  parseRefutationPanelCheckpoint,
  replayPersistentRefutationPanel,
  resumePersistentRefutationPanel,
  type RefutationPanelAuthority,
  type RefutationPanelCheckpoint,
  type RefutationPanelState,
} from "./panel-program";

export type StandaloneRefutationAuthorityError = Readonly<{
  kind: "standalone-refutation-authority-rejected";
  message: string;
}>;

export type StandaloneRefutationCompletionReceipt = Readonly<{
  schemaVersion: 1;
  kind: "standalone-refutation-completed";
  /** The SAME branded identities `FrozenStandalonePanelAuthority` carries. The
   *  reducer below compares these four fields against that authority field by
   *  field; as plain `string` the comparison typechecked even if a run id and a
   *  digest were transposed at the construction site. */
  standaloneRunId: OrchestrationRunId;
  panelRunId: OrchestrationRunId;
  panelAuthority: FrozenStandalonePanelAuthority;
  findingBriefDigest: ArtifactDigest;
  manifestDigest: ArtifactDigest;
  threshold: number;
  outcomeDigest: string;
  completedPanelStateDigest: string;
  panel: ParsedPanelOutcomes;
  /** Parser-produced T2 state used by the in-process reducer. */
  completedPanelState: RefutationPanelState;
  /** Canonical T2 event checkpoint retained when completion crossed a durable boundary. */
  completedPanelCheckpoint: RefutationPanelCheckpoint | null;
}>;

const machineFailure = (message: string): Readonly<{ ok: false; error: StandaloneRefutationAuthorityError }> =>
  canonicalRecord({ ok: false, error: canonicalRecord({
    kind: "standalone-refutation-authority-rejected" as const,
    message,
  }) });

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function deepFreezeJson<T>(value: T): T {
  if (Array.isArray(value)) {
    value.forEach((entry) => deepFreezeJson(entry));
    return Object.freeze(value) as T;
  }
  if (typeof value === "object" && value !== null) {
    Object.values(value).forEach((entry) => deepFreezeJson(entry));
    return Object.freeze(value);
  }
  return value;
}

function panelOutcomeValue(panel: ParsedPanelOutcomes): unknown {
  return {
    lenses: panel.lenses,
    threshold: panel.threshold,
    outcomes: panel.outcomes.map((outcome) => ({
      findingId: outcome.findingId,
      claim: outcome.claim,
      survives: outcome.survives,
      refutations: outcome.refutations,
      upheldBy: outcome.upheldBy,
      uncertainFrom: outcome.uncertainFrom,
    })),
  };
}

function refutationManifestValue(authority: RefutationPanelAuthority): unknown {
  return {
    schemaVersion: authority.schemaVersion,
    panel: authority.panel,
    runId: authority.runId,
    findings: authority.findings,
    lenses: authority.lenses,
    verifierSlots: authority.verifierRoster.orderedSlots,
  };
}

/** Freeze standalone→T2 panel authority before any completion can be accepted. */
export function freezeStandaloneRefutationPanelAuthority(input: Readonly<{
  standaloneAuthority: FrozenStandaloneReviewAuthority;
  aggregate: StandaloneReviewAggregate;
  panelAuthority: RefutationPanelAuthority;
  threshold: number;
}>): Readonly<{ ok: true; value: FrozenStandalonePanelAuthority }> |
  Readonly<{ ok: false; error: StandaloneRefutationAuthorityError }> {
  const canonical = parseRefutationPanelAuthority({
    runId: input.panelAuthority.runId,
    findings: input.panelAuthority.findings,
    lenses: input.panelAuthority.lenses,
    verifierSlots: input.panelAuthority.verifierRoster.orderedSlots,
  });
  if (!canonical.ok) return machineFailure(canonical.error.message);
  if (input.aggregate.runId !== input.standaloneAuthority.runId) {
    return machineFailure("standalone aggregate and frozen standalone authority belong to different runs");
  }
  const manifestDigest = parseArtifactDigest(digest(refutationManifestValue(canonical.value)));
  if (!manifestDigest.ok) return machineFailure(manifestDigest.error.message);
  const frozen = freezePanelReadAuthority({
    standaloneRunId: input.standaloneAuthority.runId,
    panelRunId: canonical.value.runId,
    aggregate: input.aggregate,
    panelFindings: canonical.value.findings,
    lenses: canonical.value.lenses,
    manifestDigest: manifestDigest.value,
    threshold: input.threshold,
  });
  if (!frozen.ok) return machineFailure(frozen.error.message);
  return canonicalRecord({ ok: true, value: frozen.value });
}

/**
 * Produce opaque completion authority only from a T2 parser/reducer-produced
 * done state whose exact authority and deterministic decision remain frozen.
 */
function replaySerializedRefutationCompletion(
  raw: unknown,
  resolver: PublicationAuthorityResolver,
): Readonly<{ ok: true; value: Extract<RefutationPanelState, { stage: "done" }> }> |
  Readonly<{ ok: false; message: string }> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, message: "persisted Refutation Panel completion must be an object" };
  }
  const record = raw as Record<string, unknown>;
  const authority = parseSerializedRefutationAuthority(record.authority);
  if (!authority.ok) return { ok: false, message: authority.error.message };
  if (record.panel !== "refutation" || record.stage !== "done" || !Array.isArray(record.slots) ||
      typeof record.decision !== "object" || record.decision === null || Array.isArray(record.decision)) {
    return { ok: false, message: "persisted Refutation Panel completion state is malformed or non-terminal" };
  }
  const verdictEvents: unknown[] = [];
  for (const slot of record.slots) {
    if (typeof slot !== "object" || slot === null || Array.isArray(slot)) {
      return { ok: false, message: "persisted Refutation Panel completion contains a malformed slot" };
    }
    const progress = slot as Record<string, unknown>;
    if (progress.status !== "accepted" || typeof progress.result !== "object" || progress.result === null ||
        Array.isArray(progress.result)) {
      return { ok: false, message: "persisted Refutation Panel completion requires every verifier slot to be accepted" };
    }
    const result = progress.result as Record<string, unknown>;
    verdictEvents.push({
      schemaVersion: 1,
      type: "refutation-verdict-accepted",
      request: result.request,
      value: result.value,
    });
  }
  const replayed = replayPersistentRefutationPanel(authority.value, [
    ...verdictEvents,
    { schemaVersion: 1, type: "refutation-tally-completed", decision: record.decision },
  ], resolver);
  if (!replayed.ok) return { ok: false, message: replayed.error.message };
  if (replayed.value.state.stage !== "done") {
    return { ok: false, message: "persisted Refutation Panel event replay did not reach done" };
  }
  if (!canonicalStructuralEquals(
    serializableCompletedPanelState(replayed.value.state),
    serializableCompletedPanelState({ ...record, authority: authority.value } as unknown as RefutationPanelState),
  )) {
    return { ok: false, message: "persisted Refutation Panel state disagrees with verified T2 replay" };
  }
  return { ok: true, value: replayed.value.state };
}

export function parseStandaloneRefutationCompletion(input: Readonly<{
  panelAuthority: FrozenStandalonePanelAuthority;
  aggregate: StandaloneReviewAggregate;
  /** Untrusted live/legacy T2 state, or a canonical T2 checkpoint for compatibility. */
  completedPanelState?: unknown;
  /** T2's canonical event-backed completion checkpoint. */
  completedPanelCheckpoint?: unknown;
  /** Required when either persisted T2 representation must be replayed after restart. */
  publicationResolver?: PublicationAuthorityResolver;
}>): Readonly<{ ok: true; value: StandaloneRefutationCompletionReceipt }> |
  Readonly<{ ok: false; error: StandaloneRefutationAuthorityError }> {
  const persistedPanelAuthority = parseFrozenStandalonePanelAuthority(input.panelAuthority, input.aggregate);
  if (!persistedPanelAuthority.ok) {
    return machineFailure(`refutation completion panel authority is invalid: ${persistedPanelAuthority.error.message}`);
  }

  const stateLooksLikeCheckpoint = typeof input.completedPanelState === "object" &&
    input.completedPanelState !== null &&
    !Array.isArray(input.completedPanelState) &&
    (input.completedPanelState as Record<string, unknown>).schemaVersion === 2 &&
    (input.completedPanelState as Record<string, unknown>).kind === "refutation-panel-checkpoint";
  if (stateLooksLikeCheckpoint && input.completedPanelCheckpoint !== undefined &&
      input.completedPanelCheckpoint !== null &&
      !canonicalStructuralEquals(input.completedPanelState, input.completedPanelCheckpoint)) {
    return machineFailure("duplicate canonical Refutation Panel checkpoint inputs disagree");
  }
  const rawCheckpoint = input.completedPanelCheckpoint ??
    (stateLooksLikeCheckpoint ? input.completedPanelState : undefined);
  const rawState = stateLooksLikeCheckpoint ? undefined : input.completedPanelState;

  let checkpoint: RefutationPanelCheckpoint | null = null;
  let checkpointCompleted: Extract<RefutationPanelState, { stage: "done" }> | null = null;
  if (rawCheckpoint !== undefined && rawCheckpoint !== null) {
    if (input.publicationResolver === undefined) {
      return machineFailure("canonical Refutation Panel checkpoint replay requires publication authority");
    }
    const parsedCheckpoint = parseRefutationPanelCheckpoint(
      rawCheckpoint,
      input.publicationResolver,
    );
    if (!parsedCheckpoint.ok) return machineFailure(parsedCheckpoint.error.message);
    if (parsedCheckpoint.value.state.stage !== "done") {
      return machineFailure("canonical Refutation Panel checkpoint has not reached completed state");
    }
    checkpoint = deepFreezeJson(
      JSON.parse(JSON.stringify(rawCheckpoint)) as RefutationPanelCheckpoint,
    );
    checkpointCompleted = parsedCheckpoint.value.state;
  }

  const resumed = rawState === undefined
    ? null
    : resumePersistentRefutationPanel(rawState as RefutationPanelState);
  const replayed = rawState !== undefined && resumed?.ok === false && input.publicationResolver !== undefined
    ? replaySerializedRefutationCompletion(rawState, input.publicationResolver)
    : null;
  let stateCompleted: Extract<RefutationPanelState, { stage: "done" }> | null = null;
  if (resumed?.ok === true && resumed.value.state.stage === "done") {
    stateCompleted = resumed.value.state;
  } else if (replayed?.ok === true) {
    stateCompleted = replayed.value;
  }
  if (checkpointCompleted !== null && stateCompleted !== null && !canonicalStructuralEquals(
    serializableCompletedPanelState(checkpointCompleted),
    serializableCompletedPanelState(stateCompleted),
  )) {
    return machineFailure("canonical Refutation Panel checkpoint and supplied completed state disagree");
  }
  const completed = checkpointCompleted ?? stateCompleted;
  if (completed === null) {
    if (replayed !== null && !replayed.ok) return machineFailure(replayed.message);
    if (resumed?.ok === true) return machineFailure("refutation panel has not reached completed state");
    if (resumed?.ok === false) return machineFailure(resumed.error.message);
    return machineFailure("refutation completion requires a completed T2 state or canonical checkpoint");
  }
  const completedManifestDigest = digest(refutationManifestValue(completed.authority));
  const independentlyFrozen = freezePanelReadAuthority({
    standaloneRunId: input.aggregate.runId,
    panelRunId: completed.authority.runId,
    aggregate: input.aggregate,
    panelFindings: completed.authority.findings,
    lenses: completed.authority.lenses,
    manifestDigest: completedManifestDigest,
    threshold: input.panelAuthority.threshold,
  });
  if (!independentlyFrozen.ok || JSON.stringify(independentlyFrozen.value) !== JSON.stringify(persistedPanelAuthority.value) ||
      completed.authority.runId !== input.panelAuthority.panelRunId ||
      completedManifestDigest !== input.panelAuthority.manifestDigest ||
      completed.decision.threshold !== input.panelAuthority.threshold ||
      JSON.stringify(completed.decision.lenses) !== JSON.stringify(input.panelAuthority.lenses)) {
    return machineFailure("completed Refutation Panel does not match the exact frozen run/manifest/lens/threshold authority");
  }
  const rawOutcomes = {
    lenses: completed.decision.lenses,
    threshold: completed.decision.threshold,
    surviving: completed.decision.outcomes.filter(({ survives }) => survives).length,
    refuted: completed.decision.outcomes.filter(({ survives }) => !survives).length,
    outcomes: completed.decision.outcomes.map((outcome) => ({
      finding_id: outcome.finding.id,
      task_id: outcome.finding.taskId,
      claim: outcome.finding.claim,
      survives: outcome.survives,
      refuted_by: outcome.refutations.map(({ lens }) => lens),
      reasoning: outcome.refutations.map(({ reason }) => reason),
      upheld_by: outcome.upheldBy,
      uncertain_from: outcome.uncertainFrom,
    })),
  };
  const criticals = input.aggregate.findings.filter(({ severity }) => severity === "critical");
  const panel = parseStandalonePanelOutcomes(
    rawOutcomes,
    criticals,
    input.panelAuthority.findings.map(({ id, claim }) => ({ id, claim })),
    input.panelAuthority.lenses,
  );
  if (!panel.ok) return machineFailure(panel.errors.join("; "));
  const outcomeDigest = digest(panelOutcomeValue(panel.value));
  const completedPanelStateDigest = digest({
    stage: completed.stage,
    manifestDigest: completedManifestDigest,
    slots: completed.slots,
    decision: completed.decision,
  });
  const receipt = canonicalRecord({
    schemaVersion: 1 as const,
    kind: "standalone-refutation-completed" as const,
    standaloneRunId: input.panelAuthority.standaloneRunId,
    panelRunId: input.panelAuthority.panelRunId,
    panelAuthority: input.panelAuthority,
    findingBriefDigest: input.panelAuthority.findingBriefDigest,
    manifestDigest: input.panelAuthority.manifestDigest,
    threshold: input.panelAuthority.threshold,
    outcomeDigest,
    completedPanelStateDigest,
    panel: panel.value,
    completedPanelState: completed,
    completedPanelCheckpoint: checkpoint,
  });
  return canonicalRecord({ ok: true, value: receipt });
}

export type AcceptedStandaloneSlot = Readonly<{
  slotId: SlotId;
  requestId: RequestId;
  attempt: 1 | 2;
  /** Canonical payload plus artifact byte identity accepted for this slot. */
  payloadFingerprint: string;
}>;

export type PendingStandaloneSlot = Readonly<{
  slotId: SlotId;
  expectedAttempt: 1 | 2;
  /**
   * Why attempt 1 was refused, carried durably so the attempt-2 spawn prompt can
   * name the ACTUAL defect. The rejection diagnostic used to live only in the
   * pass-local `rejected` set of `resumeStandaloneFacade`, so a resume that
   * merely re-issued an already-recorded retry lost it and fell back to a
   * generic message — telling the reviewer to fix its scope when the real defect
   * was a missing Machine Summary block. Always null while `expectedAttempt` is
   * 1; non-empty on a rejected slot unless a legacy checkpoint predates it.
   */
  rejectionDiagnostic: string | null;
}>;

interface StandaloneStateBase {
  readonly authority: FrozenStandaloneReviewAuthority;
  readonly accepted: readonly AcceptedStandaloneSlot[];
  readonly pending: readonly PendingStandaloneSlot[];
}

export type StandalonePreparingState = Readonly<StandaloneStateBase & { kind: "preparing" }>;
export type StandaloneAwaitingResultsState = Readonly<StandaloneStateBase & { kind: "awaiting-results" }>;
export type StandaloneAggregatingState = Readonly<StandaloneStateBase & {
  kind: "aggregating";
  completion: StandaloneRosterCompletionProof;
}>;
export type StandaloneAwaitingRefutationState = Readonly<StandaloneStateBase & {
  kind: "awaiting-refutation";
  completion: StandaloneRosterCompletionProof;
  aggregate: StandaloneReviewAggregate;
  panelAuthority: FrozenStandalonePanelAuthority;
  refutationAuthority: RefutationPanelAuthority;
}>;
export type StandaloneReadyToFinalizeState = Readonly<StandaloneStateBase & {
  kind: "ready-to-finalize";
  completion: StandaloneRosterCompletionProof;
  aggregate: StandaloneReviewAggregate;
  panel: ParsedPanelOutcomes | null;
  /** Null only for the canonical zero-critical route; otherwise durable T2 proof. */
  refutationCompletion: StandaloneRefutationCompletionReceipt | null;
  rosterDigest: string;
  reviewerEvidenceDigest: string;
  aggregateDigest: string;
  provenOutcomeDigest: string;
  finalizationDigest: string;
  result: AdjudicatedStandaloneReview;
  publicationIntent: PublishArtifactSet;
}>;

declare class AuthoritativeStandaloneReviewResultMembership {
  private readonly authoritativeStandaloneReviewResultMembership: true;
}

/** Opaque schema-v1 result authority consumed by downstream remediation (T5). */
export type AuthoritativeStandaloneReviewResult =
  AuthoritativeStandaloneReviewResultMembership & AdjudicatedStandaloneReview;

const readyFinalizationCache = new WeakSet<object>();
const authoritativeStandaloneResultCache = new WeakSet<object>();

export type StandaloneDoneState = Readonly<StandaloneStateBase & {
  kind: "done";
  result: AuthoritativeStandaloneReviewResult;
  outcome: ArtifactRef;
  publicationReceipt: ArtifactSetPublished;
}>;
export type StandaloneTerminalBlockedState = Readonly<StandaloneStateBase & {
  kind: "terminal-blocked";
  failed: Readonly<{ slotId: SlotId; requestId: RequestId; attempt: 2; message: string }>;
}>;

export type StandaloneRecoverablePredecessor =
  | StandalonePreparingState
  | StandaloneAwaitingResultsState
  | StandaloneAggregatingState
  | StandaloneAwaitingRefutationState
  | StandaloneReadyToFinalizeState;

export type StandaloneRecoverableBlockedState = Readonly<StandaloneStateBase & {
  kind: "recoverable-blocked";
  predecessor: StandaloneRecoverablePredecessor;
  diagnostic: InfrastructureRetryDiagnostic;
  expectedIntent: EffectIntent;
  expectedIntentDigest: string;
}>;

export type StandaloneReviewMachineState =
  | StandaloneRecoverablePredecessor
  | StandaloneRecoverableBlockedState
  | StandaloneDoneState
  | StandaloneTerminalBlockedState;

export type AuthoritativeStandaloneResultError = Readonly<{
  kind: "standalone-result-authority-rejected";
  message: string;
}>;

const authoritativeResultFailure = (message: string): Readonly<{
  ok: false;
  error: AuthoritativeStandaloneResultError;
}> => canonicalRecord({
  ok: false,
  error: canonicalRecord({ kind: "standalone-result-authority-rejected" as const, message }),
});

function prepareResultPublicationIntent(
  result: AdjudicatedStandaloneReview,
): Readonly<{ ok: true; value: PublishArtifactSet }> |
  Readonly<{ ok: false; error: AuthoritativeStandaloneResultError }> {
  const artifact = canonicalStandaloneResultArtifact(result);
  if (!artifact.ok) return authoritativeResultFailure(artifact.error.message);
  const effectId = parseEffectId(`effect:standalone-result:${digest({
    runId: result.runId,
    artifact: artifact.value,
  })}`);
  if (!effectId.ok) return authoritativeResultFailure(effectId.error.message);
  return canonicalRecord({
    ok: true,
    value: canonicalRecord({
      kind: "publish-artifact-set" as const,
      effectId: effectId.value,
      runId: artifact.value.runId,
      artifacts: Object.freeze([artifact.value]) as readonly [ArtifactRef],
    }),
  });
}

function readyToFinalize(
  state: StandaloneAggregatingState | StandaloneAwaitingRefutationState,
  event: Extract<StandaloneReviewMachineEvent, { kind: "aggregate-clean" | "refutation-completed" }>,
  aggregate: StandaloneReviewAggregate,
  panel: ParsedPanelOutcomes | null,
): StandaloneMachineResult {
  const finalized = finalizeStandaloneReview(aggregate, panel);
  if (!finalized.ok) {
    return reject(state, event, "aggregate-route-mismatch", finalized.errors.join("; "));
  }
  if (finalized.value.reviewerEvidence.length === 0 ||
      finalized.value.reviewerEvidence.some(({ authorityKind }) => authorityKind !== "request-bound")) {
    return reject(state, event, "aggregate-route-mismatch",
      "schema-v1 finalization requires exact non-empty request-bound reviewer evidence");
  }
  const publication = prepareResultPublicationIntent(finalized.value);
  if (!publication.ok) {
    return reject(state, event, "publication-receipt-mismatch", publication.error.message);
  }
  const ready = canonicalRecord({
    ...state,
    kind: "ready-to-finalize" as const,
    aggregate,
    panel: finalized.value.panel,
    refutationCompletion: event.kind === "refutation-completed" ? event.completion : null,
    rosterDigest: state.completion.rosterDigest,
    reviewerEvidenceDigest: digest(finalized.value.reviewerEvidence),
    aggregateDigest: digest(serializeStandaloneAggregate(aggregate)),
    provenOutcomeDigest: digest(panel === null ? { kind: "clean" } : panelOutcomeValue(finalized.value.panel!)),
    finalizationDigest: digest(serializeAdjudicatedStandaloneReview(finalized.value)),
    result: finalized.value,
    publicationIntent: publication.value,
  });
  readyFinalizationCache.add(ready);
  return success(ready);
}

/**
 * The only schema-v1 result parser. It requires the opaque ready state produced
 * from roster/panel proof plus the exact engine-issued publication receipt.
 */
export function parseAuthoritativeStandaloneReviewResult(
  ready: StandaloneReadyToFinalizeState,
  rawResult: unknown,
  rawReceipt: unknown,
): Readonly<{ ok: true; value: AuthoritativeStandaloneReviewResult; receipt: ArtifactSetPublished }> |
  Readonly<{ ok: false; error: AuthoritativeStandaloneResultError }> {
  if (typeof ready !== "object" || ready === null || !readyFinalizationCache.has(ready)) {
    return authoritativeResultFailure("schema-v1 result parsing requires an opaque LC-2 ready-to-finalize authority");
  }
  const reaggregated = aggregateStandaloneReview({
    authority: ready.authority,
    completion: ready.completion,
  });
  if (!reaggregated.ok ||
      digest(serializeStandaloneAggregate(reaggregated.value.aggregate)) !== ready.aggregateDigest ||
      ready.completion.rosterDigest !== ready.rosterDigest) {
    return authoritativeResultFailure("frozen roster proof or aggregate digest changed before result publication");
  }
  const finalized = finalizeStandaloneReview(ready.aggregate, ready.panel);
  if (!finalized.ok || finalized.value.reviewerEvidence.length === 0 ||
      digest(finalized.value.reviewerEvidence) !== ready.reviewerEvidenceDigest ||
      digest(ready.panel === null ? { kind: "clean" } : panelOutcomeValue(finalized.value.panel!)) !== ready.provenOutcomeDigest ||
      digest(serializeAdjudicatedStandaloneReview(finalized.value)) !== ready.finalizationDigest) {
    return authoritativeResultFailure("proven panel outcome, reviewer evidence, aggregate, or finalization changed before publication");
  }
  let expectedRaw: unknown;
  try {
    expectedRaw = JSON.parse(serializeAdjudicatedStandaloneReview(finalized.value));
  } catch {
    return authoritativeResultFailure("engine-authored schema-v1 finalization is not canonical JSON");
  }
  if (!isDeepStrictEqual(rawResult, expectedRaw)) {
    return authoritativeResultFailure("schema-v1 result bytes do not match the exact independently frozen finalization");
  }
  const reconciled = reconcileEffectReceipt(ready.publicationIntent, rawReceipt);
  if (!reconciled.ok || reconciled.value.kind !== "artifact-set-published") {
    return authoritativeResultFailure(reconciled.ok
      ? "result publication receipt has the wrong effect kind"
      : reconciled.error.message);
  }
  const authoritative = finalized.value as AuthoritativeStandaloneReviewResult;
  authoritativeStandaloneResultCache.add(authoritative);
  return canonicalRecord({ ok: true, value: authoritative, receipt: reconciled.value });
}

export function isAuthoritativeStandaloneReviewResult(
  result: AuthoritativeStandaloneReviewResult,
): boolean {
  return typeof result === "object" && result !== null && authoritativeStandaloneResultCache.has(result);
}

export type StandaloneReviewMachineEvent =
  | Readonly<{ kind: "review-batch-published"; runId: string }>
  | Readonly<{ kind: "result-accepted"; result: AcceptedAgentResult<CapturedReviewerResult> }>
  | Readonly<{
      kind: "result-rejected";
      request: Readonly<{ runId: string; slotId: SlotId; requestId: RequestId; attempt: 1 | 2 }>;
      message: string;
    }>
  | Readonly<{
      kind: "complete-roster-proved";
      completion: StandaloneRosterCompletionProof;
    }>
  | Readonly<{ kind: "aggregate-clean"; aggregate: StandaloneReviewAggregate }>
  | Readonly<{
      kind: "aggregate-has-criticals";
      aggregate: StandaloneReviewAggregate;
      panelAuthority: FrozenStandalonePanelAuthority;
      refutationAuthority: RefutationPanelAuthority;
    }>
  | Readonly<{
      kind: "refutation-completed";
      completion: StandaloneRefutationCompletionReceipt;
    }>
  | Readonly<{ kind: "result-published"; result: unknown; receipt: ArtifactSetPublished }>
  | Readonly<{
      kind: "recoverable-effect-failed";
      diagnostic: InfrastructureRetryDiagnostic;
      intent: EffectIntent;
    }>
  | Readonly<{ kind: "recovery-receipt-accepted"; receipt: EffectReceipt }>;

export type StandaloneMachineError = Readonly<{
  kind:
    | "undeclared-transition"
    | "foreign-run-event"
    | "unknown-slot"
    | "duplicate-result"
    | "stale-attempt"
    | "roster-mismatch"
    | "aggregate-route-mismatch"
    | "publication-receipt-mismatch"
    | "recovery-receipt-mismatch";
  state: StandaloneReviewMachineState["kind"];
  event: StandaloneReviewMachineEvent["kind"];
  message: string;
}>;

export type StandaloneMachineResult =
  | Readonly<{ ok: true; value: StandaloneReviewMachineState }>
  | Readonly<{ ok: false; error: StandaloneMachineError }>;

export const STANDALONE_REVIEW_DECLARED_TRANSITIONS = Object.freeze({
  preparing: Object.freeze(["review-batch-published", "recoverable-effect-failed"]),
  "awaiting-results": Object.freeze([
    "result-accepted", "result-rejected", "complete-roster-proved", "recoverable-effect-failed",
  ]),
  aggregating: Object.freeze(["aggregate-clean", "aggregate-has-criticals", "recoverable-effect-failed"]),
  "awaiting-refutation": Object.freeze(["refutation-completed", "recoverable-effect-failed"]),
  "ready-to-finalize": Object.freeze(["result-published", "recoverable-effect-failed"]),
  "recoverable-blocked": Object.freeze(["recoverable-effect-failed", "recovery-receipt-accepted"]),
  done: Object.freeze([]),
  "terminal-blocked": Object.freeze([]),
} as const satisfies Readonly<Record<
  StandaloneReviewMachineState["kind"],
  readonly StandaloneReviewMachineEvent["kind"][]
>>);

export function isDeclaredStandaloneReviewTransition(
  state: StandaloneReviewMachineState["kind"],
  event: StandaloneReviewMachineEvent["kind"],
): boolean {
  return (STANDALONE_REVIEW_DECLARED_TRANSITIONS[state] as readonly string[]).includes(event);
}

const success = (value: StandaloneReviewMachineState): StandaloneMachineResult =>
  canonicalRecord({ ok: true, value });

const reject = (
  state: StandaloneReviewMachineState,
  event: StandaloneReviewMachineEvent,
  kind: StandaloneMachineError["kind"],
  message: string,
): StandaloneMachineResult => canonicalRecord({
  ok: false,
  error: canonicalRecord({ kind, state: state.kind, event: event.kind, message }),
});

function stateBase(authority: FrozenStandaloneReviewAuthority): StandaloneStateBase {
  return canonicalRecord({
    authority,
    accepted: Object.freeze([]),
    pending: Object.freeze(authority.roster.orderedSlots.map((slot) => canonicalRecord({
      slotId: slot.slotId,
      expectedAttempt: 1 as const,
      rejectionDiagnostic: null,
    }))),
  });
}

export function startStandaloneReviewMachine(
  authority: FrozenStandaloneReviewAuthority,
): StandalonePreparingState {
  return canonicalRecord({ kind: "preparing", ...stateBase(authority) });
}

function eventRunId(event: StandaloneReviewMachineEvent): string | null {
  switch (event.kind) {
    case "review-batch-published": return event.runId;
    case "result-accepted": return event.result.authority.runId;
    case "result-rejected": return event.request.runId;
    case "complete-roster-proved": return event.completion.runId;
    case "aggregate-clean":
    case "aggregate-has-criticals": return event.aggregate.runId;
    case "refutation-completed": return typeof event.completion === "object" && event.completion !== null
      ? event.completion.standaloneRunId
      : null;
    case "result-published": return event.receipt.runId;
    case "recoverable-effect-failed": return event.diagnostic.runId;
    case "recovery-receipt-accepted": return event.receipt.runId;
  }
}


function acceptedPayloadMatchesAuthority(
  result: AcceptedAgentResult<CapturedReviewerResult>,
): boolean {
  const parsed = parseCapturedReviewerResult(result.value);
  return parsed.ok && parsed.value.artifact.runId === result.authority.runId &&
    parsed.value.artifact.slot.path === result.authority.outputSlot.path;
}

function rosterAttempt<First, Second>(
  slot: Readonly<{ attempts: readonly [First, Second] }> | undefined,
  attempt: 1 | 2,
): First | Second | undefined {
  return slot?.attempts[attempt - 1];
}

function withAccepted(
  state: StandaloneAwaitingResultsState,
  result: AcceptedAgentResult<CapturedReviewerResult>,
): StandaloneMachineResult {
  const authority = result.authority;
  const pendingIndex = state.pending.findIndex(({ slotId }) => slotId === authority.slotId);
  if (pendingIndex < 0) {
    const duplicate = state.accepted.some(({ slotId }) => slotId === authority.slotId);
    return reject(state, { kind: "result-accepted", result }, duplicate ? "duplicate-result" : "unknown-slot",
      duplicate ? `slot ${authority.slotId} already has an accepted result` : `slot ${authority.slotId} is not in the frozen roster`);
  }
  const pending = state.pending[pendingIndex]!;
  if (pending.expectedAttempt !== authority.attempt) {
    return reject(state, { kind: "result-accepted", result }, "stale-attempt",
      `slot ${authority.slotId} expects attempt ${pending.expectedAttempt}, received ${authority.attempt}`);
  }
  const slot = state.authority.roster.byId.get(authority.slotId);
  const expected = rosterAttempt(slot, authority.attempt);
  if (expected === undefined || !sameAgentRequestAuthority(authority, expected) || !acceptedPayloadMatchesAuthority(result)) {
    return reject(state, { kind: "result-accepted", result }, "roster-mismatch",
      "accepted result does not match frozen run/agent/request/context/model/output or artifact authority");
  }
  const remaining = state.pending.filter((_, index) => index !== pendingIndex);
  if (remaining.length === 0) {
    return reject(state, { kind: "result-accepted", result }, "undeclared-transition",
      "the final result must enter through complete-roster-proved, not result-accepted (incomplete)");
  }
  return success(canonicalRecord({
    ...state,
    accepted: Object.freeze([...state.accepted, canonicalRecord({
      slotId: authority.slotId,
      requestId: authority.requestId,
      attempt: authority.attempt,
      payloadFingerprint: fingerprintCapturedReviewerResult(result.value),
    })]),
    pending: Object.freeze(remaining),
  }));
}

function withRejected(
  state: StandaloneAwaitingResultsState,
  event: Extract<StandaloneReviewMachineEvent, { kind: "result-rejected" }>,
): StandaloneMachineResult {
  const pendingIndex = state.pending.findIndex(({ slotId }) => slotId === event.request.slotId);
  if (pendingIndex < 0) {
    const duplicate = state.accepted.some(({ slotId }) => slotId === event.request.slotId);
    return reject(state, event, duplicate ? "duplicate-result" : "unknown-slot",
      duplicate ? "an accepted slot cannot later be rejected" : "rejected result slot is not pending");
  }
  const pending = state.pending[pendingIndex]!;
  if (pending.expectedAttempt !== event.request.attempt) {
    return reject(state, event, "stale-attempt",
      `slot ${event.request.slotId} expects attempt ${pending.expectedAttempt}, received ${event.request.attempt}`);
  }
  const slot = state.authority.roster.byId.get(event.request.slotId);
  const expected = rosterAttempt(slot, event.request.attempt);
  if (expected === undefined || expected.requestId !== event.request.requestId) {
    return reject(state, event, "roster-mismatch", "rejected request does not match frozen slot authority");
  }
  const message = event.message.trim();
  if (event.request.attempt === 2) {
    return success(canonicalRecord({
      ...state,
      kind: "terminal-blocked",
      failed: canonicalRecord({
        slotId: event.request.slotId,
        requestId: event.request.requestId,
        attempt: 2 as const,
        message: message || "reviewer result failed its second and final semantic attempt",
      }),
    }));
  }
  return success(canonicalRecord({
    ...state,
    pending: Object.freeze(state.pending.map((entry, index) => index === pendingIndex
      ? canonicalRecord({
          slotId: entry.slotId,
          expectedAttempt: 2 as const,
          // Durable so EVERY later resume that re-issues this retry can name the
          // real defect, not just the pass that recorded the rejection.
          rejectionDiagnostic: message || null,
        })
      : entry)),
  }));
}

function withCompleteRoster(
  state: StandaloneAwaitingResultsState,
  event: Extract<StandaloneReviewMachineEvent, { kind: "complete-roster-proved" }>,
): StandaloneMachineResult {
  const canonical = aggregateStandaloneReview({
    authority: state.authority,
    completion: event.completion,
  });
  if (!canonical.ok) {
    return reject(state, event, "roster-mismatch", canonical.errors.join("; "));
  }
  const expectedSlots = state.authority.roster.orderedSlots;
  const proven = event.completion.accepted;
  if (proven.length !== expectedSlots.length) {
    return reject(state, event, "roster-mismatch", "completion proof length differs from frozen roster");
  }
  const acceptedBySlot = new Map(state.accepted.map((entry) => [entry.slotId, entry] as const));
  for (let index = 0; index < expectedSlots.length; index++) {
    const expectedSlot = expectedSlots[index]!;
    const result = proven[index]!;
    const expectedAttempt = state.pending.find(({ slotId }) => slotId === expectedSlot.slotId)?.expectedAttempt;
    const accepted = acceptedBySlot.get(expectedSlot.slotId);
    if (result.slotId !== expectedSlot.slotId) {
      return reject(state, event, "roster-mismatch", "completion proof does not preserve canonical slot order");
    }
    if (accepted !== undefined && (
      accepted.requestId !== result.requestId || accepted.attempt !== result.attempt ||
      accepted.payloadFingerprint !== result.payloadFingerprint
    )) {
      return reject(state, event, "roster-mismatch", "completion proof replaces previously accepted payload or artifact bytes");
    }
    if (accepted === undefined && expectedAttempt !== result.attempt) {
      return reject(state, event, "stale-attempt", "completion proof uses a stale or unissued semantic attempt");
    }
  }
  return success(canonicalRecord({
    kind: "aggregating",
    authority: state.authority,
    accepted: Object.freeze([...proven]),
    pending: Object.freeze([]),
    completion: event.completion,
  }));
}

function recoverable(
  state: StandaloneRecoverablePredecessor | StandaloneRecoverableBlockedState,
  event: Extract<StandaloneReviewMachineEvent, { kind: "recoverable-effect-failed" }>,
): StandaloneMachineResult {
  if (event.diagnostic.runId !== state.authority.runId || event.intent.runId !== state.authority.runId ||
      event.diagnostic.effectId !== event.intent.effectId) {
    return reject(state, event, "recovery-receipt-mismatch",
      "recoverable diagnostic and failed EffectIntent must identify this exact standalone run/effect");
  }
  if (state.kind === "recoverable-blocked" && JSON.stringify(state.expectedIntent) !== JSON.stringify(event.intent)) {
    return reject(state, event, "recovery-receipt-mismatch",
      "a repeated recoverable failure cannot replace the exact blocked EffectIntent");
  }
  const predecessor = state.kind === "recoverable-blocked" ? state.predecessor : state;
  return success(canonicalRecord({
    kind: "recoverable-blocked",
    authority: state.authority,
    accepted: state.accepted,
    pending: state.pending,
    predecessor,
    diagnostic: event.diagnostic,
    expectedIntent: state.kind === "recoverable-blocked" ? state.expectedIntent : event.intent,
    expectedIntentDigest: state.kind === "recoverable-blocked" ? state.expectedIntentDigest : digest(event.intent),
  }));
}

/** Exact LC-2 reducer. Undeclared state/event pairs are rejected, never absorbed. */
export function reduceStandaloneReviewMachine(
  state: StandaloneReviewMachineState,
  event: StandaloneReviewMachineEvent,
): StandaloneMachineResult {
  if (!isDeclaredStandaloneReviewTransition(state.kind, event.kind)) {
    return reject(state, event, "undeclared-transition", `event ${event.kind} is not declared from ${state.kind}`);
  }
  const runId = eventRunId(event);
  if (runId !== null && runId !== state.authority.runId) {
    return reject(state, event, "foreign-run-event", "event belongs to a stale or foreign standalone run");
  }

  if (event.kind === "recoverable-effect-failed") {
    if (state.kind === "done" || state.kind === "terminal-blocked") {
      return reject(state, event, "undeclared-transition", "terminal states are monotonic");
    }
    return recoverable(state, event);
  }

  switch (state.kind) {
    case "preparing":
      return event.kind === "review-batch-published"
        ? success(canonicalRecord({ ...state, kind: "awaiting-results" }))
        : reject(state, event, "undeclared-transition", "preparing accepts only review-batch-published or recoverable-effect-failed");

    case "awaiting-results":
      if (event.kind === "result-accepted") return withAccepted(state, event.result);
      if (event.kind === "result-rejected") return withRejected(state, event);
      if (event.kind === "complete-roster-proved") return withCompleteRoster(state, event);
      return reject(state, event, "undeclared-transition", "awaiting-results received an undeclared event");

    case "aggregating": {
      if (event.kind !== "aggregate-clean" && event.kind !== "aggregate-has-criticals") {
        return reject(state, event, "undeclared-transition", "aggregating accepts only one aggregate route");
      }
      const canonical = aggregateStandaloneReview({ authority: state.authority, completion: state.completion });
      if (!canonical.ok || serializeStandaloneAggregate(canonical.value.aggregate) !== serializeStandaloneAggregate(event.aggregate)) {
        return reject(state, event, "roster-mismatch", "aggregate does not match the complete captured reviewer roster");
      }
      const criticals = event.aggregate.findings.filter(({ severity }) => severity === "critical");
      if (event.kind === "aggregate-clean" && criticals.length !== 0) {
        return reject(state, event, "aggregate-route-mismatch", "aggregate-clean requires zero critical findings");
      }
      if (event.kind === "aggregate-has-criticals" && criticals.length === 0) {
        return reject(state, event, "aggregate-route-mismatch", "aggregate-has-criticals requires at least one critical finding");
      }
      if (event.kind === "aggregate-has-criticals") {
        const reproved = freezeStandaloneRefutationPanelAuthority({
          standaloneAuthority: state.authority,
          aggregate: event.aggregate,
          panelAuthority: event.refutationAuthority,
          threshold: event.panelAuthority.threshold,
        });
        if (!reproved.ok || JSON.stringify(reproved.value) !== JSON.stringify(event.panelAuthority)) {
          return reject(state, event, "aggregate-route-mismatch",
            "critical route requires persisted T2 authority matching the exact standalone finding brief");
        }
      }
      return event.kind === "aggregate-clean"
        ? readyToFinalize(state, event, event.aggregate, null)
        : success(canonicalRecord({
            ...state,
            kind: "awaiting-refutation",
            completion: state.completion,
            aggregate: event.aggregate,
            panelAuthority: event.panelAuthority,
            refutationAuthority: event.refutationAuthority,
          }));
    }

    case "awaiting-refutation":
      if (event.kind !== "refutation-completed") {
        return reject(state, event, "undeclared-transition", "awaiting-refutation accepts only refutation-completed");
      }
      if (typeof event.completion !== "object" || event.completion === null ||
          !("completedPanelState" in event.completion)) {
        return reject(state, event, "aggregate-route-mismatch",
          "refutation completion requires a durable completed T2 panel state");
      }
      const completionProof = parseStandaloneRefutationCompletion({
        panelAuthority: state.panelAuthority,
        aggregate: state.aggregate,
        completedPanelState: event.completion.completedPanelState,
      });
      if (!completionProof.ok ||
          JSON.stringify(completionProof.value.panelAuthority) !== JSON.stringify(state.panelAuthority) ||
          JSON.stringify(event.completion.panelAuthority) !== JSON.stringify(state.panelAuthority) ||
          event.completion.standaloneRunId !== state.authority.runId ||
          event.completion.panelRunId !== state.panelAuthority.panelRunId ||
          event.completion.findingBriefDigest !== state.panelAuthority.findingBriefDigest ||
          event.completion.manifestDigest !== state.panelAuthority.manifestDigest ||
          event.completion.threshold !== state.panelAuthority.threshold ||
          event.completion.outcomeDigest !== completionProof.value.outcomeDigest ||
          event.completion.completedPanelStateDigest !== completionProof.value.completedPanelStateDigest ||
          digest(panelOutcomeValue(event.completion.panel)) !== completionProof.value.outcomeDigest) {
        return reject(state, event, "aggregate-route-mismatch",
          "refutation completion requires the opaque parser-produced receipt for this exact frozen panel authority");
      }
      const canonicalResult = finalizeStandaloneReview(state.aggregate, event.completion.panel);
      if (!canonicalResult.ok) {
        return reject(state, event, "aggregate-route-mismatch", "completed Refutation Panel cannot finalize the frozen standalone aggregate");
      }
      return readyToFinalize(state, event, state.aggregate, event.completion.panel);

    case "ready-to-finalize":
      if (event.kind !== "result-published") {
        return reject(state, event, "undeclared-transition", "ready-to-finalize accepts only result-published");
      }
      const published = parseAuthoritativeStandaloneReviewResult(state, event.result, event.receipt);
      if (!published.ok) {
        return reject(state, event, "publication-receipt-mismatch", published.error.message);
      }
      return success(canonicalRecord({
        ...state,
        kind: "done",
        result: published.value,
        outcome: state.publicationIntent.artifacts[0],
        publicationReceipt: published.receipt,
      }));

    case "recoverable-blocked":
      if (event.kind !== "recovery-receipt-accepted") {
        return reject(state, event, "undeclared-transition", "recoverable-blocked accepts only recovery-receipt-accepted or another recoverable failure");
      }
      if (digest(state.expectedIntent) !== state.expectedIntentDigest) {
        return reject(state, event, "recovery-receipt-mismatch",
          "the blocked EffectIntent changed after it was recorded");
      }
      const recoveryReconciled = reconcileEffectReceipt(state.expectedIntent, event.receipt);
      if (!recoveryReconciled.ok) {
        return reject(state, event, "recovery-receipt-mismatch",
          `recovery receipt does not reconcile with the exact blocked ${state.expectedIntent.kind} intent: ${recoveryReconciled.error.message}`);
      }
      return success(state.predecessor);

    case "done":
    case "terminal-blocked":
      return reject(state, event, "undeclared-transition", "terminal states are monotonic and reject late input");
  }
}

function serializableRefutationAuthority(authority: RefutationPanelAuthority): unknown {
  return {
    runId: authority.runId,
    findings: authority.findings,
    lenses: authority.lenses,
    verifierSlots: authority.verifierRoster.orderedSlots,
  };
}

function serializableCompletedPanelState(state: RefutationPanelState): unknown {
  return { ...state, authority: serializableRefutationAuthority(state.authority) };
}

function serializableRefutationCompletion(receipt: StandaloneRefutationCompletionReceipt): unknown {
  return { ...receipt, completedPanelState: serializableCompletedPanelState(receipt.completedPanelState) };
}

/** Versioned durable LC-2 checkpoint; Maps are projected to their parser inputs. */
export function serializeStandaloneReviewMachineState(state: StandaloneReviewMachineState): string {
  const record: Record<string, unknown> = {
    ...state,
    schema_version: 1,
    authority: JSON.parse(serializeStandaloneReviewAuthority(state.authority)),
  };
  // `in` narrows the real union; the ad-hoc intersection cast this replaces
  // re-declared both field types by hand, so a change to either declaration
  // would have been silently ignored here — in a durable checkpoint writer,
  // where a silently wrong projection is a checkpoint that will not load back.
  if ("refutationAuthority" in state) {
    record.refutationAuthority = serializableRefutationAuthority(state.refutationAuthority);
  }
  if ("refutationCompletion" in state && state.refutationCompletion !== undefined) {
    record.refutationCompletion = state.refutationCompletion === null
      ? null
      : serializableRefutationCompletion(state.refutationCompletion);
  }
  if ("aggregate" in state) {
    record.aggregate = JSON.parse(serializeStandaloneAggregate(state.aggregate));
  }
  if (state.kind === "recoverable-blocked") {
    record.predecessor = JSON.parse(serializeStandaloneReviewMachineState(state.predecessor));
  }
  if (state.kind === "done" || state.kind === "ready-to-finalize") {
    record.result = JSON.parse(serializeAdjudicatedStandaloneReview(state.result));
  }
  return JSON.stringify(record);
}

function parseSerializedRefutationAuthority(raw: unknown) {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return parseRefutationPanelAuthority({ runId: undefined, findings: undefined, lenses: undefined, verifierSlots: undefined });
  }
  const record = raw as Record<string, unknown>;
  const verifierRoster = typeof record.verifierRoster === "object" && record.verifierRoster !== null
    ? record.verifierRoster as Record<string, unknown>
    : null;
  return parseRefutationPanelAuthority({
    runId: record.runId,
    findings: record.findings,
    lenses: record.lenses,
    verifierSlots: record.verifierSlots ?? verifierRoster?.orderedSlots,
  });
}

function restoreRefutationPanelState(raw: unknown): RefutationPanelState | null {
  if (typeof raw !== "object" || raw === null || !("authority" in raw)) return null;
  const record = raw as Record<string, unknown>;
  const parsed = parseSerializedRefutationAuthority(record.authority);
  return parsed.ok ? ({ ...record, authority: parsed.value } as unknown as RefutationPanelState) : null;
}

function restoreRefutationCompletion(
  raw: unknown,
  aggregate: StandaloneReviewAggregate,
  panelAuthority: FrozenStandalonePanelAuthority,
  publicationResolver: PublicationAuthorityResolver,
): StandaloneRefutationCompletionReceipt | null {
  if (typeof raw !== "object" || raw === null) return null;
  const record = raw as Record<string, unknown>;
  const completedPanelState = restoreRefutationPanelState(record.completedPanelState);
  if (completedPanelState === null && record.completedPanelCheckpoint === undefined) return null;
  const parsed = parseStandaloneRefutationCompletion({
    panelAuthority,
    aggregate,
    ...(completedPanelState === null ? {} : { completedPanelState }),
    ...(record.completedPanelCheckpoint === undefined || record.completedPanelCheckpoint === null
      ? {}
      : { completedPanelCheckpoint: record.completedPanelCheckpoint }),
    publicationResolver,
  });
  if (!parsed.ok) return null;
  const supplied = {
    ...record,
    completedPanelState: completedPanelState ?? parsed.value.completedPanelState,
    completedPanelCheckpoint: record.completedPanelCheckpoint ?? null,
  };
  return canonicalStructuralEquals(
    serializableRefutationCompletion(parsed.value),
    serializableRefutationCompletion(supplied as unknown as StandaloneRefutationCompletionReceipt),
  ) ? parsed.value : null;
}

export type StandaloneMachineStateParseError = Readonly<{
  kind: "standalone-machine-state-rejected";
  message: string;
}>;

function parsePersistedStandaloneProgress(
  authority: FrozenStandaloneReviewAuthority,
  rawAccepted: unknown,
  rawPending: unknown,
): Readonly<{ ok: true; accepted: readonly AcceptedStandaloneSlot[]; pending: readonly PendingStandaloneSlot[] }> |
  Readonly<{ ok: false; message: string }> {
  if (!Array.isArray(rawAccepted) || !Array.isArray(rawPending)) {
    return { ok: false, message: "checkpoint accepted and pending slot projections must be arrays" };
  }
  const accepted: AcceptedStandaloneSlot[] = [];
  const pending: PendingStandaloneSlot[] = [];
  const observed = new Set<string>();
  for (const entry of rawAccepted) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      return { ok: false, message: "checkpoint accepted slot projection is malformed" };
    }
    const record = entry as Record<string, unknown>;
    const slot = authority.roster.orderedSlots.find(({ slotId }) => slotId === record.slotId);
    // Indexed, not branched: `attempts` is the ordered pair and the checkpoint's
    // 1-or-2 IS its ordinal. The two-arm ternary this replaces read the same
    // array at two literal indices, so a third attempt ordinal would have to be
    // added in two places to be readable in either.
    const attempt = record.attempt === 1 || record.attempt === 2
      ? slot?.attempts[record.attempt - 1]
      : undefined;
    if (slot === undefined || attempt === undefined || record.requestId !== attempt.requestId ||
        typeof record.payloadFingerprint !== "string" || !/^[0-9a-f]{64}$/.test(record.payloadFingerprint) ||
        observed.has(slot.slotId)) {
      return { ok: false, message: "checkpoint accepted slot does not match frozen request/attempt authority" };
    }
    observed.add(slot.slotId);
    accepted.push(canonicalRecord({
      slotId: slot.slotId,
      requestId: attempt.requestId,
      attempt: attempt.attempt,
      payloadFingerprint: record.payloadFingerprint,
    }));
  }
  for (const entry of rawPending) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      return { ok: false, message: "checkpoint pending slot projection is malformed" };
    }
    const record = entry as Record<string, unknown>;
    const slot = authority.roster.orderedSlots.find(({ slotId }) => slotId === record.slotId);
    if (slot === undefined || (record.expectedAttempt !== 1 && record.expectedAttempt !== 2) || observed.has(slot.slotId)) {
      return { ok: false, message: "checkpoint pending slot does not match frozen roster authority" };
    }
    // A pre-existing checkpoint has no `rejectionDiagnostic` at all; it replays
    // as null (the retry prompt then falls back to the generic contract
    // reminder). Any other shape is a corrupt projection, not a legacy one.
    const rawDiagnostic = record.rejectionDiagnostic;
    if (rawDiagnostic !== undefined && rawDiagnostic !== null && typeof rawDiagnostic !== "string") {
      return { ok: false, message: "checkpoint pending slot rejection diagnostic must be a string or null" };
    }
    const rejectionDiagnostic = typeof rawDiagnostic === "string" ? rawDiagnostic.trim() : "";
    if (rejectionDiagnostic !== "" && record.expectedAttempt !== 2) {
      return { ok: false, message: "checkpoint pending slot carries a rejection diagnostic without an attempt-2 expectation" };
    }
    observed.add(slot.slotId);
    pending.push(canonicalRecord({
      slotId: slot.slotId,
      expectedAttempt: record.expectedAttempt,
      rejectionDiagnostic: rejectionDiagnostic === "" ? null : rejectionDiagnostic,
    }));
  }
  if (observed.size !== authority.roster.orderedSlots.length) {
    return { ok: false, message: "checkpoint slot projections do not exactly cover the frozen roster" };
  }
  return { ok: true, accepted: Object.freeze(accepted), pending: Object.freeze(pending) };
}

/**
 * Rebuild every process-local parser brand from persisted receipts/artifacts,
 * then replay the minimum LC-2 prefix. No checkpoint field authenticates itself.
 */
export function parseStandaloneReviewMachineState(
  raw: unknown,
  publicationResolver: PublicationAuthorityResolver,
): Readonly<{ ok: true; value: StandaloneReviewMachineState }> |
  Readonly<{ ok: false; error: StandaloneMachineStateParseError }> {
  const failure = (message: string) => canonicalRecord({
    ok: false as const,
    error: canonicalRecord({ kind: "standalone-machine-state-rejected" as const, message }),
  });
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return failure("checkpoint must be an object");
  const record = raw as Record<string, unknown>;
  if (record.schema_version !== 1 || typeof record.kind !== "string") return failure("checkpoint schema_version or kind is invalid");
  const authority = parseStandaloneReviewAuthority(record.authority);
  if (!authority.ok) return failure(authority.errors.join("; "));

  const started = startStandaloneReviewMachine(authority.value);
  if (record.kind === "preparing") return canonicalRecord({ ok: true as const, value: started });

  if (record.kind === "recoverable-blocked") {
    const predecessor = parseStandaloneReviewMachineState(record.predecessor, publicationResolver);
    if (!predecessor.ok) return failure(`recoverable predecessor is invalid: ${predecessor.error.message}`);
    if (predecessor.value.kind === "recoverable-blocked" || predecessor.value.kind === "done" ||
        predecessor.value.kind === "terminal-blocked") {
      return failure("recoverable predecessor must be a non-terminal LC-2 state");
    }
    if (serializeStandaloneReviewAuthority(predecessor.value.authority) !== serializeStandaloneReviewAuthority(authority.value)) {
      return failure("recoverable predecessor authority differs from the blocked checkpoint authority");
    }
    const progress = parsePersistedStandaloneProgress(authority.value, record.accepted, record.pending);
    if (!progress.ok || !canonicalStructuralEquals(progress.accepted, predecessor.value.accepted) ||
        !canonicalStructuralEquals(progress.pending, predecessor.value.pending)) {
      return failure(progress.ok
        ? "recoverable checkpoint progress differs from its predecessor"
        : progress.message);
    }
    const diagnostic = parseBlockedDiagnostic(record.diagnostic);
    if (!diagnostic.ok || diagnostic.value.kind !== "effect-blocked") {
      return failure(diagnostic.ok
        ? "recoverable checkpoint requires an infrastructure retry diagnostic"
        : diagnostic.error.message);
    }
    const parsedIntentProbe = reconcileEffectReceipt(record.expectedIntent, null);
    if (parsedIntentProbe.ok || parsedIntentProbe.error.effectId === null) {
      return failure(parsedIntentProbe.ok
        ? "recoverable checkpoint EffectIntent unexpectedly reconciled with an empty receipt"
        : parsedIntentProbe.error.message);
    }
    if (typeof record.expectedIntentDigest !== "string" || !/^[0-9a-f]{64}$/.test(record.expectedIntentDigest) ||
        digest(record.expectedIntent) !== record.expectedIntentDigest) {
      return failure("recoverable checkpoint EffectIntent digest is invalid or stale");
    }
    const blocked = reduceStandaloneReviewMachine(predecessor.value, {
      kind: "recoverable-effect-failed",
      diagnostic: diagnostic.value,
      intent: record.expectedIntent as EffectIntent,
    });
    if (!blocked.ok || blocked.value.kind !== "recoverable-blocked" ||
        blocked.value.expectedIntentDigest !== record.expectedIntentDigest) {
      return failure(blocked.ok ? "recoverable checkpoint did not replay to blocked" : blocked.error.message);
    }
    return canonicalRecord({ ok: true as const, value: blocked.value });
  }

  const awaiting = reduceStandaloneReviewMachine(started, {
    kind: "review-batch-published",
    runId: authority.value.runId,
  });
  if (!awaiting.ok) return failure(awaiting.error.message);
  if (record.kind === "awaiting-results") {
    const progress = parsePersistedStandaloneProgress(authority.value, record.accepted, record.pending);
    return progress.ok
      ? canonicalRecord({ ok: true as const, value: canonicalRecord({
          ...awaiting.value,
          accepted: progress.accepted,
          pending: progress.pending,
        }) })
      : failure(progress.message);
  }
  if (record.kind === "terminal-blocked") {
    const progress = parsePersistedStandaloneProgress(authority.value, record.accepted, record.pending);
    if (!progress.ok) return failure(progress.message);
    if (typeof record.failed !== "object" || record.failed === null || Array.isArray(record.failed)) {
      return failure("terminal-blocked checkpoint failed result is malformed");
    }
    const failed = record.failed as Record<string, unknown>;
    if (Object.keys(failed).sort().join(",") !== ["attempt", "message", "requestId", "slotId"].sort().join(",") ||
        failed.attempt !== 2 || typeof failed.message !== "string" || failed.message.trim() !== failed.message ||
        failed.message.length === 0) {
      return failure("terminal-blocked checkpoint failed result fields are invalid");
    }
    const projectedAwaiting = canonicalRecord({
      ...awaiting.value,
      accepted: progress.accepted,
      pending: progress.pending,
    });
    const terminal = reduceStandaloneReviewMachine(projectedAwaiting, {
      kind: "result-rejected",
      request: {
        runId: authority.value.runId,
        slotId: failed.slotId as SlotId,
        requestId: failed.requestId as RequestId,
        attempt: 2,
      },
      message: failed.message,
    });
    if (!terminal.ok || terminal.value.kind !== "terminal-blocked" ||
        !canonicalStructuralEquals(terminal.value.failed, failed)) {
      return failure(terminal.ok ? "terminal-blocked checkpoint did not replay exactly" : terminal.error.message);
    }
    return canonicalRecord({ ok: true as const, value: terminal.value });
  }

  const completion = parseStandaloneRosterCompletionProof(authority.value, publicationResolver, record.completion);
  if (!completion.ok) return failure(completion.error.violations.map((violation) => violation.kind).join("; "));
  // A retried slot's accepted proof entry is at attempt 2. Replay the exact
  // rejection that advanced it — derived from the persisted accepted
  // projection, never from prose — so the checkpoint replays to the same
  // aggregating state the live run checkpointed. Without this, replaying
  // complete-roster-proved against a pristine pending (every slot at attempt
  // 1) refuses the retried slot's attempt-2 entry as stale and the whole
  // checkpoint becomes unrecoverable.
  const progress = parsePersistedStandaloneProgress(authority.value, record.accepted, record.pending);
  if (!progress.ok) return failure(progress.message);
  let replayBase: StandaloneReviewMachineState = awaiting.value;
  for (const entry of progress.accepted) {
    if (entry.attempt !== 2) continue;
    const slot = authority.value.roster.byId.get(entry.slotId);
    const attemptOne = slot?.attempts[0];
    if (attemptOne === undefined || attemptOne.requestId === entry.requestId) {
      return failure("checkpoint accepted attempt-2 entry lacks a canonical attempt-1 predecessor");
    }
    const rejected = reduceStandaloneReviewMachine(replayBase, {
      kind: "result-rejected",
      request: { runId: authority.value.runId, slotId: entry.slotId, requestId: attemptOne.requestId, attempt: 1 },
      message: "recovered from the persisted attempt-2 acceptance projection",
    });
    if (!rejected.ok || rejected.value.kind !== "awaiting-results") {
      return failure(rejected.ok ? "checkpoint attempt-2 acceptance did not replay to awaiting results" : rejected.error.message);
    }
    replayBase = rejected.value;
  }
  const aggregating = reduceStandaloneReviewMachine(replayBase, {
    kind: "complete-roster-proved",
    completion: completion.value,
  });
  if (!aggregating.ok) return failure(aggregating.error.message);
  if (!canonicalStructuralEquals(aggregating.value.accepted, progress.accepted)) {
    return failure("checkpoint replayed accepted-slot progress differs from the persisted projection");
  }
  if (record.kind === "aggregating") return canonicalRecord({ ok: true as const, value: aggregating.value });

  const aggregate = parseStandaloneAggregate(record.aggregate);
  if (!aggregate.ok) return failure(aggregate.errors.join("; "));
  const criticals = aggregate.value.findings.filter(({ severity }) => severity === "critical");
  let readyOrAwaiting: StandaloneReviewMachineState;
  if (criticals.length === 0) {
    const ready = reduceStandaloneReviewMachine(aggregating.value, { kind: "aggregate-clean", aggregate: aggregate.value });
    if (!ready.ok) return failure(ready.error.message);
    readyOrAwaiting = ready.value;
  } else {
    const panelAuthority = parseFrozenStandalonePanelAuthority(record.panelAuthority, aggregate.value);
    if (!panelAuthority.ok) return failure(panelAuthority.error.message);
    const refutationAuthority = parseSerializedRefutationAuthority(record.refutationAuthority);
    if (!refutationAuthority.ok) return failure(refutationAuthority.error.message);
    const routed = reduceStandaloneReviewMachine(aggregating.value, {
      kind: "aggregate-has-criticals",
      aggregate: aggregate.value,
      panelAuthority: panelAuthority.value,
      refutationAuthority: refutationAuthority.value,
    });
    if (!routed.ok) return failure(routed.error.message);
    if (record.kind === "awaiting-refutation") return canonicalRecord({ ok: true as const, value: routed.value });
    const refutation = restoreRefutationCompletion(
      record.refutationCompletion,
      aggregate.value,
      panelAuthority.value,
      publicationResolver,
    );
    if (refutation === null) return failure("checkpoint lacks a valid durable Refutation Panel completion receipt");
    const ready = reduceStandaloneReviewMachine(routed.value, { kind: "refutation-completed", completion: refutation });
    if (!ready.ok) return failure(ready.error.message);
    readyOrAwaiting = ready.value;
  }
  if (readyOrAwaiting.kind !== "ready-to-finalize") return failure("checkpoint did not replay to ready-to-finalize");
  if (record.kind === "ready-to-finalize") return canonicalRecord({ ok: true as const, value: readyOrAwaiting });
  if (record.kind !== "done") return failure(`unsupported or inconsistent checkpoint kind: ${record.kind}`);
  const done = reduceStandaloneReviewMachine(readyOrAwaiting, {
    kind: "result-published",
    result: record.result,
    receipt: record.publicationReceipt as ArtifactSetPublished,
  });
  return done.ok ? canonicalRecord({ ok: true as const, value: done.value }) : failure(done.error.message);
}
