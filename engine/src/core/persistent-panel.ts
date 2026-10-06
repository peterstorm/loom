/**
 * The durable, authority-bound panel programs (schema v2): the architecture
 * and refutation reducers over strictly parsed durable events, their replay,
 * checkpoints, and the journal/checkpoint persistence plans.
 *
 * Every state, event, recorded step and history is minted here and proved by
 * module-private membership, so a value that did not come from start,
 * reduction, replay or checkpoint parsing cannot be resumed, reduced or
 * persisted. The issued roster authority comes from `panel-authority`; the
 * verdict-source selection both verdict submissions run before their
 * authoritative parse comes from `panel-verdict-source`.
 *
 * Pure module: no I/O, no clock, no randomness.
 */
import {
  aggregateVerdicts,
  parseJudgeVerdict,
  type ArchitectureCriterion,
  type CandidateFilename,
  type CandidateRanking,
  type JudgeVerdict,
  type PanelLens,
} from "./panel-contract";
import {
  defaultRefutationThreshold,
  parseRefutationVerdict,
  tallyRefutations,
  type FindingOutcome,
  type RefutationVerdict,
  type ReviewLens,
} from "./review-panel";
import { fail, sanitizeProse, type ParseResult, type VerdictEnvelope } from "./panel-kernel";
import { sha256Hex } from "./digest";
import { safeArray, safeRecord } from "./exact-data";
import {
  authorityMatches,
  boundCandidateEntry,
  boundJudgeCriterion,
  boundRefutationLens,
  boundedPanelMessage,
  panelError,
  parseArchitecturePanelAuthority,
  parseRefutationPanelAuthority,
  persistentFailure,
  persistentSuccess,
  type ArchitecturePanelAuthority,
  type ArchitecturePanelAuthorityInput,
  type PersistentPanelError,
  type PersistentPanelResult,
  type RefutationPanelAuthority,
  type RefutationPanelAuthorityInput,
} from "./panel-authority";
import {
  foldVerdictSubmission,
  projectPanelVerdictSourceArm,
  type PanelVerdictEmissionSelectionOf,
  type PanelVerdictSource,
} from "./panel-verdict-source";
import {
  acceptedAgentResult,
  boundedThrownCause,
  parseArtifactDigest,
  parseCompleteRoster,
  parseEffectId,
  parseIssuedSpawnRequest,
  parseOrchestrationRunId,
  parseRequestId,
  semanticRetryDiagnostic,
  terminalBlockedDiagnostic,
  type AcceptedAgentResult,
  type AgentRequestAuthority,
  type AgentRosterSlot,
  type ArtifactDigest,
  type BlockedDiagnostic,
  type CompleteRoster,
  type DomainResult,
  type EffectId,
  type ExactRoster,
  type NonEmpty,
  type OrchestrationRunId,
  type PublicationAuthorityResolver,
  type RequestId,
  type SemanticAttempt,
  type SlotId,
  type SpawnRequest as IssuedSpawnRequest,
  type TerminalBlockedDiagnostic,
} from "./orchestration-contract";

export type ArchitectureCandidateResult = Readonly<{ lens: PanelLens; candidate: CandidateFilename; artifact: string }>;

export type PanelRequestIdentity = Readonly<{
  schemaVersion: 1;
  kind: "panel-request-identity";
  requestId: RequestId;
  issuance: Readonly<{
    schemaVersion: 1;
    kind: "issued-spawn-request-proof";
    runId: OrchestrationRunId;
    effectId: EffectId;
    publicationDigest: ArtifactDigest;
    batchIndex: number;
  }>;
}>;

export type DurableAcceptedPanelResult<T> = Readonly<{
  schemaVersion: 1;
  kind: "panel-result-accepted";
  request: PanelRequestIdentity;
  value: T;
}>;

type OpenSlot<Result> =
  | Readonly<{ slotId: SlotId; status: "pending"; nextAttempt: SemanticAttempt }>
  | Readonly<{ slotId: SlotId; status: "accepted"; result: DurableAcceptedPanelResult<Result> }>;

type AcceptedSlot<Result> = Extract<OpenSlot<Result>, Readonly<{ status: "accepted" }>>;
type CompleteSlotProgress<Result> = NonEmpty<AcceptedSlot<Result>>;

declare const ARCHITECTURE_PANEL_STATE: unique symbol;
declare const REFUTATION_PANEL_STATE: unique symbol;

type ArchitecturePanelStateBrand = Readonly<{ [ARCHITECTURE_PANEL_STATE]: "ArchitecturePanelState" }>;
type RefutationPanelStateBrand = Readonly<{ [REFUTATION_PANEL_STATE]: "RefutationPanelState" }>;

interface PersistentArchitectureBase {
  readonly panel: "architecture";
  readonly authority: ArchitecturePanelAuthority;
}

type ArchitecturePanelStateData =
  | Readonly<PersistentArchitectureBase & { stage: "awaiting-candidates"; slots: NonEmpty<OpenSlot<ArchitectureCandidateResult>> }>
  | Readonly<PersistentArchitectureBase & {
      stage: "awaiting-judges";
      candidateSlots: CompleteSlotProgress<ArchitectureCandidateResult>;
      slots: NonEmpty<OpenSlot<JudgeVerdict>>;
    }>
  | Readonly<PersistentArchitectureBase & {
      stage: "ready-to-aggregate";
      candidateSlots: CompleteSlotProgress<ArchitectureCandidateResult>;
      judgeSlots: CompleteSlotProgress<JudgeVerdict>;
    }>
  | Readonly<PersistentArchitectureBase & {
      stage: "done";
      candidateSlots: CompleteSlotProgress<ArchitectureCandidateResult>;
      judgeSlots: CompleteSlotProgress<JudgeVerdict>;
      ranking: readonly CandidateRanking[];
    }>
  | Readonly<PersistentArchitectureBase & {
      stage: "terminal-blocked";
      failedStage: "candidates";
      slots: NonEmpty<OpenSlot<ArchitectureCandidateResult>>;
      diagnostic: TerminalBlockedDiagnostic;
    }>
  | Readonly<PersistentArchitectureBase & {
      stage: "terminal-blocked";
      failedStage: "judges";
      candidateSlots: CompleteSlotProgress<ArchitectureCandidateResult>;
      slots: NonEmpty<OpenSlot<JudgeVerdict>>;
      diagnostic: TerminalBlockedDiagnostic;
    }>;

/** Opaque parser/reducer-produced view. Slot progress is its sole result authority. */
export type ArchitecturePanelState = ArchitecturePanelStateData & ArchitecturePanelStateBrand;

interface PersistentRefutationBase {
  readonly panel: "refutation";
  readonly authority: RefutationPanelAuthority;
  readonly slots: NonEmpty<OpenSlot<VerdictEnvelope<RefutationVerdict>>>;
}

export type RefutationDecision = Readonly<{
  threshold: number;
  lenses: readonly ReviewLens[];
  verdicts: readonly VerdictEnvelope<RefutationVerdict>[];
  outcomes: readonly FindingOutcome[];
  retained: readonly FindingOutcome[];
  refuted: readonly FindingOutcome[];
}>;

type RefutationPanelStateData =
  | Readonly<PersistentRefutationBase & { stage: "awaiting-verdicts" }>
  | Readonly<PersistentRefutationBase & { stage: "ready-to-tally" }>
  | Readonly<PersistentRefutationBase & { stage: "done"; decision: RefutationDecision }>
  | Readonly<PersistentRefutationBase & { stage: "terminal-blocked"; diagnostic: TerminalBlockedDiagnostic }>;

/** Opaque parser/reducer-produced view. Slot progress is its sole result authority. */
export type RefutationPanelState = RefutationPanelStateData & RefutationPanelStateBrand;

export type ArchitecturePanelAction =
  | Readonly<{ kind: "spawn-architecture-candidates"; runId: OrchestrationRunId; requests: NonEmpty<AgentRequestAuthority> }>
  | Readonly<{ kind: "spawn-architecture-judges"; runId: OrchestrationRunId; requests: NonEmpty<AgentRequestAuthority> }>
  | Readonly<{ kind: "architecture-aggregate-ready"; runId: OrchestrationRunId }>
  | Readonly<{ kind: "architecture-blocked"; runId: OrchestrationRunId; diagnostic: BlockedDiagnostic }>
  | Readonly<{ kind: "architecture-done"; runId: OrchestrationRunId; ranking: readonly CandidateRanking[] }>;

export type RefutationPanelAction =
  | Readonly<{ kind: "spawn-refutation-verifiers"; runId: OrchestrationRunId; requests: NonEmpty<AgentRequestAuthority> }>
  | Readonly<{ kind: "refutation-tally-ready"; runId: OrchestrationRunId }>
  | Readonly<{ kind: "refutation-blocked"; runId: OrchestrationRunId; diagnostic: BlockedDiagnostic }>
  | Readonly<{ kind: "refutation-done"; runId: OrchestrationRunId; decision: RefutationDecision }>;

/**
 * The issuance join between an emission selection input and the submitted
 * request: the binding must certify THIS slot's request. A binding for another
 * request is a caller defect, not an attempt observation — a typed failure
 * before any selection, never a rejection event consuming the attempt.
 */
function panelVerdictEmissionIssuanceProblem<K extends "judge-verdict" | "refutation-verdict">(
  emission: PanelVerdictEmissionSelectionOf<K> | undefined,
  expectedRequestId: RequestId,
  panel: "architecture" | "refutation",
): PersistentPanelError | null {
  if (emission === undefined || emission.binding.requestId === expectedRequestId) return null;
  return panelError(panel, "invalid-authority",
    `issued emission binding certifies request ${emission.binding.requestId}, not the submitted request ${expectedRequestId}`);
}

export type PersistentArchitecturePanelEvent =
  | Readonly<{ schemaVersion: 1; type: "architecture-candidate-accepted"; request: PanelRequestIdentity; value: ArchitectureCandidateResult }>
  | Readonly<{ schemaVersion: 1; type: "architecture-candidate-rejected"; request: PanelRequestIdentity; attempt: SemanticAttempt; category: "malformed-result" | "result-binding-mismatch"; message: string }>
  | Readonly<{ schemaVersion: 1; type: "architecture-judge-accepted"; request: PanelRequestIdentity; value: JudgeVerdict; source: PanelVerdictSource }>
  | Readonly<{ schemaVersion: 1; type: "architecture-judge-rejected"; request: PanelRequestIdentity; attempt: SemanticAttempt; category: "malformed-result" | "result-binding-mismatch"; message: string }>
  | Readonly<{ schemaVersion: 1; type: "architecture-ranking-completed"; ranking: readonly CandidateRanking[] }>;

export type PersistentRefutationPanelEvent =
  | Readonly<{ schemaVersion: 1; type: "refutation-verdict-accepted"; request: PanelRequestIdentity; value: VerdictEnvelope<RefutationVerdict>; source: PanelVerdictSource }>
  | Readonly<{ schemaVersion: 1; type: "refutation-verdict-rejected"; request: PanelRequestIdentity; attempt: SemanticAttempt; category: "malformed-result" | "result-binding-mismatch"; message: string }>
  | Readonly<{ schemaVersion: 1; type: "refutation-tally-completed"; decision: RefutationDecision }>;

export type PersistentArchitectureStep = Readonly<{ state: ArchitecturePanelState; action: ArchitecturePanelAction | null; recordedEvent?: PersistentArchitecturePanelEvent }>;
export type PersistentRefutationStep = Readonly<{ state: RefutationPanelState; action: RefutationPanelAction | null; recordedEvent?: PersistentRefutationPanelEvent }>;

declare const PERSISTENT_ARCHITECTURE_HISTORY: unique symbol;
declare const PERSISTENT_REFUTATION_HISTORY: unique symbol;

export type PersistentArchitecturePanelHistory = Readonly<{
  panel: "architecture";
  authority: ArchitecturePanelAuthority;
  events: readonly PersistentArchitecturePanelEvent[];
  readonly [PERSISTENT_ARCHITECTURE_HISTORY]: "PersistentArchitecturePanelHistory";
}>;
export type PersistentRefutationPanelHistory = Readonly<{
  panel: "refutation";
  authority: RefutationPanelAuthority;
  events: readonly PersistentRefutationPanelEvent[];
  readonly [PERSISTENT_REFUTATION_HISTORY]: "PersistentRefutationPanelHistory";
}>;

const architectureStateProofs = new WeakSet<object>();
const refutationStateProofs = new WeakSet<object>();
const architectureEventProofs = new WeakSet<object>();
const refutationEventProofs = new WeakSet<object>();
const architectureRecordedStepProofs = new WeakSet<object>();
const refutationRecordedStepProofs = new WeakSet<object>();
const architectureHistoryProofs = new WeakSet<object>();
const refutationHistoryProofs = new WeakSet<object>();
const architectureJudgeRosterProofs = new WeakMap<object, ArchitecturePanelAuthority>();
const refutationRosterProofs = new WeakMap<object, RefutationPanelAuthority>();

function architectureState<T extends ArchitecturePanelStateData>(state: T): T & ArchitecturePanelStateBrand {
  architectureStateProofs.add(state);
  return state as T & ArchitecturePanelStateBrand;
}
function refutationState<T extends RefutationPanelStateData>(state: T): T & RefutationPanelStateBrand {
  refutationStateProofs.add(state);
  return state as T & RefutationPanelStateBrand;
}
function architectureEvent<T extends PersistentArchitecturePanelEvent>(event: T): T {
  architectureEventProofs.add(event);
  return event;
}
function refutationEvent<T extends PersistentRefutationPanelEvent>(event: T): T {
  refutationEventProofs.add(event);
  return event;
}
function architectureRecordedStep(step: PersistentArchitectureStep & Readonly<{ recordedEvent: PersistentArchitecturePanelEvent }>): PersistentArchitectureStep {
  architectureRecordedStepProofs.add(step);
  return step;
}
function refutationRecordedStep(step: PersistentRefutationStep & Readonly<{ recordedEvent: PersistentRefutationPanelEvent }>): PersistentRefutationStep {
  refutationRecordedStepProofs.add(step);
  return step;
}

function initialSlots<Result>(roster: ExactRoster): NonEmpty<OpenSlot<Result>> {
  return Object.freeze(roster.orderedSlots.map(({ slotId }) => Object.freeze({ slotId, status: "pending" as const, nextAttempt: 1 as const }))) as unknown as NonEmpty<OpenSlot<Result>>;
}

function pendingAuthorities<Result>(roster: ExactRoster, slots: NonEmpty<OpenSlot<Result>>): NonEmpty<AgentRequestAuthority> | null {
  const requests = slots.flatMap((progress) => progress.status === "accepted" ? [] : [requireRosterAttempt(roster, progress.slotId, progress.nextAttempt)]);
  return requests.length === 0 ? null : Object.freeze(requests) as unknown as NonEmpty<AgentRequestAuthority>;
}

function architectureAction(state: ArchitecturePanelState): ArchitecturePanelAction | null {
  switch (state.stage) {
    case "awaiting-candidates": {
      const requests = pendingAuthorities(state.authority.candidateRoster, state.slots);
      return requests === null ? null : Object.freeze({ kind: "spawn-architecture-candidates", runId: state.authority.runId, requests });
    }
    case "awaiting-judges": {
      const requests = pendingAuthorities(state.authority.judgeRoster, state.slots);
      return requests === null ? null : Object.freeze({ kind: "spawn-architecture-judges", runId: state.authority.runId, requests });
    }
    case "ready-to-aggregate": return Object.freeze({ kind: "architecture-aggregate-ready", runId: state.authority.runId });
    case "terminal-blocked": return Object.freeze({ kind: "architecture-blocked", runId: state.authority.runId, diagnostic: state.diagnostic });
    case "done": return Object.freeze({ kind: "architecture-done", runId: state.authority.runId, ranking: state.ranking });
  }
}

function refutationAction(state: RefutationPanelState): RefutationPanelAction | null {
  switch (state.stage) {
    case "awaiting-verdicts": {
      const requests = pendingAuthorities(state.authority.verifierRoster, state.slots);
      return requests === null ? null : Object.freeze({ kind: "spawn-refutation-verifiers", runId: state.authority.runId, requests });
    }
    case "ready-to-tally": return Object.freeze({ kind: "refutation-tally-ready", runId: state.authority.runId });
    case "terminal-blocked": return Object.freeze({ kind: "refutation-blocked", runId: state.authority.runId, diagnostic: state.diagnostic });
    case "done": return Object.freeze({ kind: "refutation-done", runId: state.authority.runId, decision: state.decision });
  }
}

export function startPersistentArchitecturePanel(authority: ArchitecturePanelAuthority): PersistentArchitectureStep {
  const state = architectureState(Object.freeze({
    panel: "architecture" as const, authority, stage: "awaiting-candidates" as const,
    slots: initialSlots<ArchitectureCandidateResult>(authority.candidateRoster),
  }));
  return Object.freeze({ state, action: architectureAction(state) });
}

export function startPersistentRefutationPanel(authority: RefutationPanelAuthority): PersistentRefutationStep {
  const state = refutationState(Object.freeze({
    panel: "refutation" as const, authority, stage: "awaiting-verdicts" as const,
    slots: initialSlots<VerdictEnvelope<RefutationVerdict>>(authority.verifierRoster),
  }));
  return Object.freeze({ state, action: refutationAction(state) });
}

export function resumePersistentArchitecturePanel(state: ArchitecturePanelState): PersistentPanelResult<PersistentArchitectureStep> {
  return architectureStateProofs.has(state)
    ? persistentSuccess(Object.freeze({ state, action: architectureAction(state) }))
    : persistentFailure(panelError("architecture", "malformed-checkpoint", "architecture state must come from start, reduction, replay, or checkpoint parsing"));
}
export function resumePersistentRefutationPanel(state: RefutationPanelState): PersistentPanelResult<PersistentRefutationStep> {
  return refutationStateProofs.has(state)
    ? persistentSuccess(Object.freeze({ state, action: refutationAction(state) }))
    : persistentFailure(panelError("refutation", "malformed-checkpoint", "refutation state must come from start, reduction, replay, or checkpoint parsing"));
}

function findRosterRequest(roster: ExactRoster, requestId: string): AgentRequestAuthority | null {
  for (const slot of roster.orderedSlots) {
    const found = slot.attempts.find((request) => request.requestId === requestId);
    if (found !== undefined) return found;
  }
  return null;
}

/** Proven roster access, the kernel's `requireEntry` analogue. The parser
 *  builds `byId` from the same `orderedSlots` it validates, so every slot has
 *  an entry — the compiler cannot see the link. A miss here is a broken
 *  invariant (never a degraded input): throw with an invariant message, which
 *  the reducers' try/catch converts into a fail-closed malformed-event rather
 *  than a non-null assertion passing a lie downstream. */
function requireRosterEntry(roster: ExactRoster, slotId: SlotId): AgentRosterSlot {
  const slot = roster.byId.get(slotId);
  if (slot === undefined) throw new Error(`panel program invariant: roster has no slot '${slotId}' after parse`);
  return slot;
}

/** Proven attempt access: parseExactRoster enforces exactly two attempts per
 *  slot, so attempt 1|2 always resolves. Miss = broken invariant, thrown. */
function requireRosterAttempt(roster: ExactRoster, slotId: SlotId, attempt: number): AgentRequestAuthority {
  const request = requireRosterEntry(roster, slotId).attempts[attempt - 1];
  if (request === undefined) {
    throw new Error(`panel program invariant: slot '${slotId}' has no attempt ${attempt} after parse`);
  }
  return request;
}

/** Proven request lookup: the caller has already located this request (a
 *  settled outcome), so absence would be a broken invariant, not a degraded
 *  input — throw instead of asserting. */
function requireRosterRequest(roster: ExactRoster, requestId: string): AgentRequestAuthority {
  const found = findRosterRequest(roster, requestId);
  if (found === null) throw new Error(`panel program invariant: request '${requestId}' is not in the roster`);
  return found;
}

function locateProgress<Result>(
  roster: ExactRoster,
  slots: NonEmpty<OpenSlot<Result>>,
  requestId: string,
): PersistentPanelResult<Readonly<{ index: number; slot: OpenSlot<Result>; expected: AgentRequestAuthority }>> {
  const panel = roster.program === "architecture-panel" ? "architecture" : "refutation";
  const authority = findRosterRequest(roster, requestId);
  if (authority === null) return persistentFailure(panelError(panel, "unknown-request", `request ${requestId} is not in the active canonical roster`, { requestId }));
  const index = slots.findIndex(({ slotId }) => slotId === authority.slotId);
  if (index < 0) return persistentFailure(panelError(panel, "unknown-request", `request ${requestId} does not belong to the active panel stage`, { requestId, slotId: authority.slotId }));
  const progress = slots[index]!;
  if (progress.status === "accepted") return persistentFailure(panelError(panel, "duplicate-result", `slot ${progress.slotId} already has an accepted result`, { requestId, slotId: progress.slotId }));
  const expected = requireRosterAttempt(roster, progress.slotId, progress.nextAttempt);
  if (expected.requestId !== requestId) return persistentFailure(panelError(panel, "stale-request", `slot ${progress.slotId} expects attempt ${progress.nextAttempt}, not request ${requestId}`, { requestId, slotId: progress.slotId }));
  return persistentSuccess(Object.freeze({ index, slot: progress, expected }));
}

export function panelRequestIdentity(request: IssuedSpawnRequest): PanelRequestIdentity {
  return Object.freeze({
    schemaVersion: 1 as const,
    kind: "panel-request-identity" as const,
    requestId: request.authority.requestId,
    issuance: Object.freeze({ ...request.issuance }),
  });
}

function parsePanelRequestIdentity(raw: unknown): PersistentPanelResult<PanelRequestIdentity> {
  const identity = safeRecord(raw, ["schemaVersion", "kind", "requestId", "issuance"]);
  if (identity === null || identity.schemaVersion !== 1 || identity.kind !== "panel-request-identity") {
    return persistentFailure(panelError("architecture", "malformed-event", "panel request identity tag or schemaVersion is invalid"));
  }
  const requestId = parseRequestId(identity.requestId);
  const issuance = safeRecord(identity.issuance, ["schemaVersion", "kind", "runId", "effectId", "publicationDigest", "batchIndex"]);
  if (!requestId.ok || issuance === null || issuance.schemaVersion !== 1 || issuance.kind !== "issued-spawn-request-proof") {
    return persistentFailure(panelError("architecture", "malformed-event", requestId.ok ? "panel request issuance identity is invalid" : requestId.error.message));
  }
  const runId = parseOrchestrationRunId(issuance.runId);
  const effectId = parseEffectId(issuance.effectId);
  const publicationDigest = parseArtifactDigest(issuance.publicationDigest);
  const batchIndex = typeof issuance.batchIndex === "number" && Number.isSafeInteger(issuance.batchIndex) && issuance.batchIndex >= 0
    ? issuance.batchIndex
    : null;
  if (!runId.ok || !effectId.ok || !publicationDigest.ok || batchIndex === null) {
    return persistentFailure(panelError("architecture", "malformed-event", [
      runId.ok ? null : runId.error.message,
      effectId.ok ? null : effectId.error.message,
      publicationDigest.ok ? null : publicationDigest.error.message,
      batchIndex === null ? "panel request batchIndex must be a non-negative safe integer" : null,
    ].filter((message): message is string => message !== null).join("; ")));
  }
  return persistentSuccess(Object.freeze({
    schemaVersion: 1,
    kind: "panel-request-identity",
    requestId: requestId.value,
    issuance: Object.freeze({
      schemaVersion: 1,
      kind: "issued-spawn-request-proof",
      runId: runId.value,
      effectId: effectId.value,
      publicationDigest: publicationDigest.value,
      batchIndex,
    }),
  }));
}

function rehydrationFailure(panel: "architecture" | "refutation", expected: AgentRequestAuthority, error: Readonly<{ kind: "invalid-accepted-agent-result"; field?: string; message: string }>): PersistentPanelResult<never> {
  const cause = Object.freeze({ kind: error.kind, ...(error.field === undefined ? {} : { field: error.field }), message: boundedPanelMessage(error.message) });
  return persistentFailure(panelError(panel, "request-rehydration-failed", `request ${expected.requestId} could not be rehydrated: ${cause.message}`, {
    requestId: expected.requestId, slotId: expected.slotId, rehydration: cause,
  }));
}

function resolvePanelRequest(
  panel: "architecture" | "refutation",
  roster: ExactRoster,
  identityRaw: unknown,
  resolver: PublicationAuthorityResolver,
): PersistentPanelResult<Readonly<{ identity: PanelRequestIdentity; request: IssuedSpawnRequest; expected: AgentRequestAuthority }>> {
  const identity = parsePanelRequestIdentity(identityRaw);
  if (!identity.ok) return persistentFailure(panelError(panel, identity.error.kind, identity.error.message));
  const expected = findRosterRequest(roster, identity.value.requestId);
  if (expected === null) return persistentFailure(panelError(panel, "unknown-request", `request ${identity.value.requestId} is not in the canonical roster`, { requestId: identity.value.requestId }));
  const issued = parseIssuedSpawnRequest(resolver, {
    authority: expected,
    context: { digest: expected.contextDigest, slot: `contexts/${expected.contextDigest}.json` },
    issuance: identity.value.issuance,
  });
  if (!issued.ok) return rehydrationFailure(panel, expected, issued.error);
  if (!authorityMatches(issued.value.authority, expected)) {
    return persistentFailure(panelError(panel, "request-binding-mismatch", "rehydrated request does not match the exact canonical panel slot", { requestId: expected.requestId, slotId: expected.slotId }));
  }
  return persistentSuccess(Object.freeze({ identity: identity.value, request: issued.value, expected }));
}

function orderedAccepted<Result>(roster: ExactRoster, slots: NonEmpty<OpenSlot<Result>>): readonly DurableAcceptedPanelResult<Result>[] {
  return Object.freeze(roster.orderedSlots.flatMap(({ slotId }) => {
    const slot = slots.find((candidate) => candidate.slotId === slotId);
    return slot?.status === "accepted" ? [slot.result] : [];
  }));
}

function completeSlotProgress<Result>(slots: NonEmpty<OpenSlot<Result>>): CompleteSlotProgress<Result> | null {
  return slots.every((slot): slot is AcceptedSlot<Result> => slot.status === "accepted")
    ? slots as CompleteSlotProgress<Result>
    : null;
}

/** Canonical accepted candidate projection, derived only from slot progress. */
export function selectAcceptedArchitectureCandidates(
  state: ArchitecturePanelState,
): readonly DurableAcceptedPanelResult<ArchitectureCandidateResult>[] {
  const slots = state.stage === "awaiting-candidates" ||
      (state.stage === "terminal-blocked" && state.failedStage === "candidates")
    ? state.slots
    : state.candidateSlots;
  return orderedAccepted(state.authority.candidateRoster, slots);
}

/** Canonical accepted judge projection, derived only from slot progress. */
export function selectAcceptedArchitectureJudges(
  state: ArchitecturePanelState,
): readonly DurableAcceptedPanelResult<JudgeVerdict>[] {
  if (state.stage === "awaiting-candidates" ||
      (state.stage === "terminal-blocked" && state.failedStage === "candidates")) return Object.freeze([]);
  const slots = state.stage === "awaiting-judges" || state.stage === "terminal-blocked"
    ? state.slots
    : state.judgeSlots;
  return orderedAccepted(state.authority.judgeRoster, slots);
}

/** Canonical accepted verdict projection, derived only from slot progress. */
export function selectAcceptedRefutationVerdicts(
  state: RefutationPanelState,
): readonly DurableAcceptedPanelResult<VerdictEnvelope<RefutationVerdict>>[] {
  return orderedAccepted(state.authority.verifierRoster, state.slots);
}

function replaceSlot<Result>(slots: NonEmpty<OpenSlot<Result>>, index: number, replacement: OpenSlot<Result>): NonEmpty<OpenSlot<Result>> {
  return Object.freeze(slots.map((slot, candidateIndex) => candidateIndex === index ? replacement : slot)) as unknown as NonEmpty<OpenSlot<Result>>;
}

function settleAccepted<Result>(
  roster: ExactRoster,
  slots: NonEmpty<OpenSlot<Result>>,
  result: DurableAcceptedPanelResult<Result>,
): PersistentPanelResult<NonEmpty<OpenSlot<Result>>> {
  const located = locateProgress(roster, slots, result.request.requestId);
  if (!located.ok) return located;
  return persistentSuccess(replaceSlot(slots, located.value.index, Object.freeze({
    slotId: located.value.expected.slotId,
    status: "accepted" as const,
    result,
  })));
}

function retryDiagnostic(roster: ExactRoster, slotId: SlotId, category: "malformed-result" | "result-binding-mismatch", message: string): BlockedDiagnostic | null {
  const slot = roster.byId.get(slotId);
  if (slot === undefined) return null;
  const diagnostic = semanticRetryDiagnostic({ category, failedRequest: slot.attempts[0], retryRequest: slot.attempts[1], message });
  return diagnostic.ok ? diagnostic.value : null;
}

function settleRejected<Result>(
  panel: "architecture" | "refutation",
  roster: ExactRoster,
  slots: NonEmpty<OpenSlot<Result>>,
  event: Readonly<{ request: PanelRequestIdentity; attempt: SemanticAttempt; category: "malformed-result" | "result-binding-mismatch"; message: string }>,
): PersistentPanelResult<Readonly<{ slots?: NonEmpty<OpenSlot<Result>>; diagnostic: BlockedDiagnostic; terminal: boolean }>> {
  const located = locateProgress(roster, slots, event.request.requestId);
  if (!located.ok) return located;
  if (event.attempt !== located.value.expected.attempt) return persistentFailure(panelError(panel, "stale-request", `expected attempt ${located.value.expected.attempt}, received ${event.attempt}`, { requestId: event.request.requestId, slotId: located.value.expected.slotId }));
  const message = sanitizeProse(event.message);
  if (message.length === 0) return persistentFailure(panelError(panel, "malformed-result", "rejection message must be non-empty after sanitization"));
  if (event.attempt === 1) {
    const diagnostic = retryDiagnostic(roster, located.value.expected.slotId, event.category, message);
    if (diagnostic === null) return persistentFailure(panelError(panel, "invalid-authority", "cannot construct retry diagnostic"));
    return persistentSuccess(Object.freeze({
      slots: replaceSlot(slots, located.value.index, Object.freeze({ slotId: located.value.expected.slotId, status: "pending" as const, nextAttempt: 2 as const })),
      diagnostic, terminal: false,
    }));
  }
  const terminal = terminalBlockedDiagnostic({ category: event.category, failedRequest: located.value.expected as AgentRequestAuthority<2>, message });
  if (!terminal.ok) return persistentFailure(panelError(panel, "invalid-authority", terminal.error.message));
  return persistentSuccess(Object.freeze({ diagnostic: terminal.value, terminal: true }));
}

function parseCandidateClaim(raw: unknown, expectedLens: PanelLens, expectedCandidate: CandidateFilename): PersistentPanelResult<ArchitectureCandidateResult> {
  const candidate = safeRecord(raw, ["lens", "candidate", "artifact"]);
  const artifact = candidate !== null && typeof candidate.artifact === "string" ? candidate.artifact : "";
  if (candidate === null || typeof candidate.lens !== "string" || typeof candidate.candidate !== "string" || artifact.trim().length === 0) {
    return persistentFailure(panelError("architecture", "malformed-result", "candidate result must contain lens, candidate, and a non-empty artifact"));
  }
  if (candidate.lens !== expectedLens || candidate.candidate !== expectedCandidate) {
    return persistentFailure(panelError("architecture", "request-binding-mismatch", "caller candidate/lens claims do not match the canonical request slot"));
  }
  return persistentSuccess(Object.freeze({ lens: expectedLens, candidate: expectedCandidate, artifact }));
}

function parseCanonicalJudge(raw: unknown, authority: ArchitecturePanelAuthority, expectedCriterion: ArchitectureCriterion): DomainResult<JudgeVerdict, Readonly<{ message: string }>> {
  try {
    const record = safeRecord(raw, ["criterion", "entries"]);
    if (record === null || record.criterion !== expectedCriterion) return { ok: false, error: { message: `judge criterion must match canonical request slot '${expectedCriterion}'` } };
    const entries = safeArray(record.entries);
    if (entries === null) return { ok: false, error: { message: "judge entries must be an array" } };
    const external = {
      criterion: expectedCriterion,
      rankings: entries.map((entry) => {
        const ranking = safeRecord(entry, ["candidate", "score", "fatalFlaw", "strongestIdea"]);
        return ranking === null ? null : { candidate: ranking.candidate, score: ranking.score, fatal_flaw: ranking.fatalFlaw, strongest_idea: ranking.strongestIdea };
      }),
    };
    const parsed = parseJudgeVerdict(JSON.stringify(external), expectedCriterion, authority.candidateIds);
    return parsed.ok ? { ok: true, value: parsed.value } : { ok: false, error: { message: parsed.errors.join("; ") } };
  } catch (error) {
    // Fail closed to the fixed sentence, but keep the thrown class so a code
    // regression stays distinguishable from malformed input (the reducers'
    // reason; `review-output`'s `inspectionFailure` keeps the class the same way).
    return { ok: false, error: { message: `judge result could not be safely parsed (${boundedThrownCause(error, "judge result").name})` } };
  }
}

function parseCanonicalRefutation(raw: unknown, authority: RefutationPanelAuthority, expectedLens: ReviewLens): DomainResult<VerdictEnvelope<RefutationVerdict>, Readonly<{ message: string }>> {
  try {
    const record = safeRecord(raw, ["criterion", "entries"]);
    if (record === null || record.criterion !== expectedLens) return { ok: false, error: { message: `refutation lens must match canonical request slot '${expectedLens}'` } };
    const entries = safeArray(record.entries);
    if (entries === null) return { ok: false, error: { message: "refutation entries must be an array" } };
    const external = {
      criterion: expectedLens,
      verdicts: entries.map((entry) => {
        const verdict = safeRecord(entry, ["findingId", "verdict", "reasoning"]);
        return verdict === null ? null : { finding_id: verdict.findingId, verdict: verdict.verdict, reasoning: verdict.reasoning };
      }),
    };
    const parsed = parseRefutationVerdict(JSON.stringify(external), expectedLens, authority.findings.map(({ id }) => id));
    return parsed.ok ? { ok: true, value: parsed.value } : { ok: false, error: { message: parsed.errors.join("; ") } };
  } catch (error) {
    // Same reason as `parseCanonicalJudge`: keep the thrown class.
    return { ok: false, error: { message: `refutation result could not be safely parsed (${boundedThrownCause(error, "refutation result").name})` } };
  }
}

function parseRejection<Result>(
  raw: Readonly<Record<string, unknown>>,
  panel: "architecture" | "refutation",
  roster: ExactRoster,
  slots: NonEmpty<OpenSlot<Result>>,
  resolver: PublicationAuthorityResolver,
): PersistentPanelResult<Readonly<{ request: PanelRequestIdentity; attempt: SemanticAttempt; category: "malformed-result" | "result-binding-mismatch"; message: string }>> {
  const resolved = resolvePanelRequest(panel, roster, raw.request, resolver);
  if (!resolved.ok) return resolved;
  const located = locateProgress(roster, slots, resolved.value.expected.requestId);
  if (!located.ok) return located;
  const attempt = raw.attempt === 1 || raw.attempt === 2 ? raw.attempt : null;
  const category = raw.category === "malformed-result" || raw.category === "result-binding-mismatch" ? raw.category : null;
  const message = typeof raw.message === "string" ? sanitizeProse(raw.message) : "";
  if (attempt === null || category === null || message.length === 0) {
    return persistentFailure(panelError(panel, "malformed-event", "rejection event requires issued request identity, attempt, category, and non-empty sanitized message"));
  }
  if (attempt !== resolved.value.expected.attempt) {
    return persistentFailure(panelError(panel, "stale-request", `expected attempt ${resolved.value.expected.attempt}, received ${attempt}`, {
      requestId: resolved.value.expected.requestId,
      slotId: resolved.value.expected.slotId,
    }));
  }
  return persistentSuccess(Object.freeze({ request: resolved.value.identity, attempt, category, message }));
}

/**
 * The roster's DERIVED lookup views. `ExactRoster.byId` and `CompleteRoster.bySlot`
 * are built by the roster parser from `orderedSlots`/`ordered` and by nothing
 * else, so they carry no information a comparison of those arrays does not
 * already have.
 */
const DERIVED_ROSTER_VIEWS: ReadonlySet<string> = new Set(["byId", "bySlot"]);

/**
 * Structural equality for any two panel values compared by content: a durable
 * checkpoint's state, a replayed event prefix, a deterministic aggregate, and a
 * panel authority projection all come through here.
 *
 * The derived roster views are dropped from BOTH sides, because including them
 * made the comparison depend on how a `Map` happens to serialize — and it did,
 * silently and wrongly. A checkpoint written before the roster view became a
 * real `Map` holds the literal text `"byId":{"size":3}`: `JSON.stringify` had
 * dropped every function-valued key of the old fake-`ReadonlyMap` record and
 * left only its size, so this check was proving that two rosters had the same
 * NUMBER of slots and nothing whatsoever about which slots they were.
 *
 * Dropping the derived keys compares the arrays they are projected from, which
 * is strictly stronger, and makes the check independent of any serialization
 * choice for `Map` — including the correct one.
 */
function jsonEqual(left: unknown, right: unknown): boolean {
  const withoutDerivedViews = (value: unknown): string | undefined =>
    JSON.stringify(value, (key, entry: unknown) => (DERIVED_ROSTER_VIEWS.has(key) ? undefined : entry));
  try { return withoutDerivedViews(left) === withoutDerivedViews(right); } catch { return false; }
}

export function parsePersistentArchitecturePanelEvent(
  state: ArchitecturePanelState,
  raw: unknown,
  resolver: PublicationAuthorityResolver,
): PersistentPanelResult<PersistentArchitecturePanelEvent> {
  if (!architectureStateProofs.has(state)) return persistentFailure(panelError("architecture", "malformed-checkpoint", "event parsing requires a parser-produced architecture state"));
  const envelope = safeRecord(raw, ["schemaVersion", "type", "request", "value", "attempt", "category", "message", "ranking", "source"]);
  if (envelope === null || envelope.schemaVersion !== 1 || typeof envelope.type !== "string") return persistentFailure(panelError("architecture", "malformed-event", "architecture event must be an exact schemaVersion 1 data record"));
  if (envelope.type === "architecture-candidate-accepted") {
    const exact = safeRecord(raw, ["schemaVersion", "type", "request", "value"]);
    if (exact === null || state.stage !== "awaiting-candidates") return persistentFailure(panelError("architecture", "unexpected-event", `candidate result is not accepted during ${state.stage}`));
    const resolved = resolvePanelRequest("architecture", state.authority.candidateRoster, exact.request, resolver);
    if (!resolved.ok) return resolved;
    const located = locateProgress(state.authority.candidateRoster, state.slots, resolved.value.expected.requestId);
    if (!located.ok) return located;
    const bound = boundCandidateEntry(state.authority, resolved.value.expected.slotId);
    if (!bound.ok) return bound;
    const value = parseCandidateClaim(exact.value, bound.value.lens, bound.value.candidate);
    if (!value.ok) return value;
    return persistentSuccess(architectureEvent(Object.freeze({ schemaVersion: 1, type: "architecture-candidate-accepted", request: resolved.value.identity, value: value.value })));
  }
  if (envelope.type === "architecture-judge-accepted") {
    const exact = safeRecord(raw, ["schemaVersion", "type", "request", "value", "source"]);
    if (exact === null || state.stage !== "awaiting-judges") return persistentFailure(panelError("architecture", "unexpected-event", `judge result is not accepted during ${state.stage}`));
    const resolved = resolvePanelRequest("architecture", state.authority.judgeRoster, exact.request, resolver);
    if (!resolved.ok) return resolved;
    const located = locateProgress(state.authority.judgeRoster, state.slots, resolved.value.expected.requestId);
    if (!located.ok) return located;
    const criterion = boundJudgeCriterion(state.authority, resolved.value.expected.slotId);
    if (!criterion.ok) return criterion;
    const value = parseCanonicalJudge(exact.value, state.authority, criterion.value);
    if (!value.ok) return persistentFailure(panelError("architecture", "request-binding-mismatch", value.error.message, { requestId: resolved.value.expected.requestId, slotId: resolved.value.expected.slotId }));
    // The accepted event's source arm: absent is the historical projection
    // (genuinely pre-feature accepted events were extraction); present must be
    // exact — malformed present-day source fields are NOT historical absence.
    const source = projectPanelVerdictSourceArm(exact.source);
    if (!source.ok) return persistentFailure(panelError("architecture", "malformed-event", source.error));
    return persistentSuccess(architectureEvent(Object.freeze({ schemaVersion: 1, type: "architecture-judge-accepted", request: resolved.value.identity, value: value.value, source: source.value })));
  }
  // One branch per rejection kind rather than a shared stage-guard prelude and
  // a re-test of the same conditions below it: the paired form left a third
  // "wrong stage" arm that the guards had already made unreachable, and the
  // re-test was the only thing narrowing `state` for its own roster.
  if (envelope.type === "architecture-candidate-rejected") {
    const exact = safeRecord(raw, ["schemaVersion", "type", "request", "attempt", "category", "message"]);
    if (exact === null) return persistentFailure(panelError("architecture", "malformed-event", "architecture rejection event contains unknown or missing fields"));
    if (state.stage !== "awaiting-candidates") {
      return persistentFailure(panelError("architecture", "unexpected-event", `candidate rejection is not accepted during ${state.stage}`));
    }
    const rejection = parseRejection(exact, "architecture", state.authority.candidateRoster, state.slots, resolver);
    if (!rejection.ok) return rejection;
    return persistentSuccess(architectureEvent(Object.freeze({ schemaVersion: 1, type: envelope.type, ...rejection.value })));
  }
  if (envelope.type === "architecture-judge-rejected") {
    const exact = safeRecord(raw, ["schemaVersion", "type", "request", "attempt", "category", "message"]);
    if (exact === null) return persistentFailure(panelError("architecture", "malformed-event", "architecture rejection event contains unknown or missing fields"));
    if (state.stage !== "awaiting-judges") {
      return persistentFailure(panelError("architecture", "unexpected-event", `judge rejection is not accepted during ${state.stage}`));
    }
    const rejection = parseRejection(exact, "architecture", state.authority.judgeRoster, state.slots, resolver);
    if (!rejection.ok) return rejection;
    return persistentSuccess(architectureEvent(Object.freeze({ schemaVersion: 1, type: envelope.type, ...rejection.value })));
  }
  if (envelope.type === "architecture-ranking-completed") {
    const exact = safeRecord(raw, ["schemaVersion", "type", "ranking"]);
    if (exact === null || state.stage !== "ready-to-aggregate") return persistentFailure(panelError("architecture", "unexpected-event", `ranking is not available during ${state.stage}`));
    const proof = proveArchitectureJudgeRoster(state, resolver);
    if (!proof.ok) return proof;
    const ranking = aggregateArchitecturePanel(state.authority, proof.value);
    if (!ranking.ok) return ranking;
    if (!jsonEqual(exact.ranking, ranking.value)) return persistentFailure(panelError("architecture", "invalid-aggregate", "persisted ranking does not equal the deterministic complete-roster aggregate"));
    return persistentSuccess(architectureEvent(Object.freeze({ schemaVersion: 1, type: "architecture-ranking-completed", ranking: ranking.value })));
  }
  return persistentFailure(panelError("architecture", "malformed-event", `unknown architecture event type: ${envelope.type}`));
}

export function parsePersistentRefutationPanelEvent(
  state: RefutationPanelState,
  raw: unknown,
  resolver: PublicationAuthorityResolver,
): PersistentPanelResult<PersistentRefutationPanelEvent> {
  if (!refutationStateProofs.has(state)) return persistentFailure(panelError("refutation", "malformed-checkpoint", "event parsing requires a parser-produced refutation state"));
  const envelope = safeRecord(raw, ["schemaVersion", "type", "request", "value", "attempt", "category", "message", "decision", "source"]);
  if (envelope === null || envelope.schemaVersion !== 1 || typeof envelope.type !== "string") return persistentFailure(panelError("refutation", "malformed-event", "refutation event must be an exact schemaVersion 1 data record"));
  if (envelope.type === "refutation-verdict-accepted") {
    const exact = safeRecord(raw, ["schemaVersion", "type", "request", "value", "source"]);
    if (exact === null || state.stage !== "awaiting-verdicts") return persistentFailure(panelError("refutation", "unexpected-event", `verdict is not accepted during ${state.stage}`));
    const resolved = resolvePanelRequest("refutation", state.authority.verifierRoster, exact.request, resolver);
    if (!resolved.ok) return resolved;
    const located = locateProgress(state.authority.verifierRoster, state.slots, resolved.value.expected.requestId);
    if (!located.ok) return located;
    const boundLens = boundRefutationLens(state.authority, resolved.value.expected.slotId);
    if (!boundLens.ok) return boundLens;
    const value = parseCanonicalRefutation(exact.value, state.authority, boundLens.value);
    if (!value.ok) return persistentFailure(panelError("refutation", "request-binding-mismatch", value.error.message, { requestId: resolved.value.expected.requestId, slotId: resolved.value.expected.slotId }));
    // The same source-arm projection the judge events use (AD-8 historical
    // projection; malformed present-day arms refuse).
    const source = projectPanelVerdictSourceArm(exact.source);
    if (!source.ok) return persistentFailure(panelError("refutation", "malformed-event", source.error));
    return persistentSuccess(refutationEvent(Object.freeze({ schemaVersion: 1, type: "refutation-verdict-accepted", request: resolved.value.identity, value: value.value, source: source.value })));
  }
  if (envelope.type === "refutation-verdict-rejected") {
    const exact = safeRecord(raw, ["schemaVersion", "type", "request", "attempt", "category", "message"]);
    if (exact === null) return persistentFailure(panelError("refutation", "malformed-event", "refutation rejection event contains unknown or missing fields"));
    if (state.stage !== "awaiting-verdicts") {
      return persistentFailure(panelError("refutation", "unexpected-event", `verdict rejection is not accepted during ${state.stage}`));
    }
    const rejection = parseRejection(exact, "refutation", state.authority.verifierRoster, state.slots, resolver);
    if (!rejection.ok) return rejection;
    return persistentSuccess(refutationEvent(Object.freeze({ schemaVersion: 1, type: "refutation-verdict-rejected", ...rejection.value })));
  }
  if (envelope.type === "refutation-tally-completed") {
    const exact = safeRecord(raw, ["schemaVersion", "type", "decision"]);
    if (exact === null || state.stage !== "ready-to-tally") return persistentFailure(panelError("refutation", "unexpected-event", `tally is not available during ${state.stage}`));
    const proof = proveRefutationRoster(state, resolver);
    if (!proof.ok) return proof;
    const rawDecision = safeRecord(exact.decision, ["threshold", "lenses", "verdicts", "outcomes", "retained", "refuted"]);
    const threshold = rawDecision?.threshold;
    if (typeof threshold !== "number") return persistentFailure(panelError("refutation", "invalid-aggregate", "persisted decision threshold is malformed"));
    const decision = tallyRefutationPanel(state.authority, proof.value, threshold);
    if (!decision.ok) return decision;
    if (!jsonEqual(exact.decision, decision.value)) return persistentFailure(panelError("refutation", "invalid-aggregate", "persisted decision does not equal the deterministic complete-roster tally"));
    return persistentSuccess(refutationEvent(Object.freeze({ schemaVersion: 1, type: "refutation-tally-completed", decision: decision.value })));
  }
  return persistentFailure(panelError("refutation", "malformed-event", `unknown refutation event type: ${envelope.type}`));
}

function durableAccepted<T>(request: PanelRequestIdentity, value: T): DurableAcceptedPanelResult<T> {
  return Object.freeze({ schemaVersion: 1, kind: "panel-result-accepted", request, value });
}

function terminalArchitecture(state: ArchitecturePanelState): PersistentPanelResult<PersistentArchitectureStep> {
  return persistentFailure(panelError("architecture", "terminal-state", `architecture panel is ${state.stage} and cannot transition`));
}
function terminalRefutation(state: RefutationPanelState): PersistentPanelResult<PersistentRefutationStep> {
  return persistentFailure(panelError("refutation", "terminal-state", `refutation panel is ${state.stage} and cannot transition`));
}

function reduceArchitectureCandidateAccepted(state: ArchitecturePanelState, event: Extract<PersistentArchitecturePanelEvent, { type: "architecture-candidate-accepted" }>): PersistentPanelResult<PersistentArchitectureStep> {
  if (state.stage !== "awaiting-candidates") return persistentFailure(panelError("architecture", "unexpected-event", `candidate result is not accepted during ${state.stage}`));
  const result = durableAccepted(event.request, event.value);
  const settled = settleAccepted(state.authority.candidateRoster, state.slots, result);
  if (!settled.ok) return settled;
  const complete = completeSlotProgress(settled.value);
  const next = complete !== null
    ? architectureState(Object.freeze({
        panel: "architecture" as const,
        authority: state.authority,
        stage: "awaiting-judges" as const,
        candidateSlots: complete,
        slots: initialSlots<JudgeVerdict>(state.authority.judgeRoster),
      }))
    : architectureState(Object.freeze({ ...state, slots: settled.value }));
  return persistentSuccess(Object.freeze({ state: next, action: next.stage === "awaiting-candidates" ? null : architectureAction(next) }));
}

function reduceArchitectureCandidateRejected(state: ArchitecturePanelState, event: Extract<PersistentArchitecturePanelEvent, { type: "architecture-candidate-rejected" }>): PersistentPanelResult<PersistentArchitectureStep> {
  if (state.stage !== "awaiting-candidates") return persistentFailure(panelError("architecture", "unexpected-event", `candidate rejection is not accepted during ${state.stage}`));
  const settled = settleRejected("architecture", state.authority.candidateRoster, state.slots, event);
  if (!settled.ok) return settled;
  if (settled.value.terminal) {
    const next = architectureState(Object.freeze({
      panel: "architecture" as const,
      authority: state.authority,
      stage: "terminal-blocked" as const,
      failedStage: "candidates" as const,
      slots: state.slots,
      diagnostic: settled.value.diagnostic as TerminalBlockedDiagnostic,
    }));
    return persistentSuccess(Object.freeze({ state: next, action: architectureAction(next) }));
  }
  const next = architectureState(Object.freeze({ ...state, slots: settled.value.slots! }));
  const retry = requireRosterAttempt(state.authority.candidateRoster, requireRosterRequest(state.authority.candidateRoster, event.request.requestId).slotId, 2);
  return persistentSuccess(Object.freeze({ state: next, action: Object.freeze({ kind: "spawn-architecture-candidates" as const, runId: state.authority.runId, requests: Object.freeze([retry]) as NonEmpty<AgentRequestAuthority> }) }));
}

function reduceArchitectureJudgeRejected(state: ArchitecturePanelState, event: Extract<PersistentArchitecturePanelEvent, { type: "architecture-judge-rejected" }>): PersistentPanelResult<PersistentArchitectureStep> {
  if (state.stage !== "awaiting-judges") return persistentFailure(panelError("architecture", "unexpected-event", `judge rejection is not accepted during ${state.stage}`));
  const settled = settleRejected("architecture", state.authority.judgeRoster, state.slots, event);
  if (!settled.ok) return settled;
  if (settled.value.terminal) {
    const next = architectureState(Object.freeze({
      panel: "architecture" as const,
      authority: state.authority,
      stage: "terminal-blocked" as const,
      failedStage: "judges" as const,
      candidateSlots: state.candidateSlots,
      slots: state.slots,
      diagnostic: settled.value.diagnostic as TerminalBlockedDiagnostic,
    }));
    return persistentSuccess(Object.freeze({ state: next, action: architectureAction(next) }));
  }
  const next = architectureState(Object.freeze({ ...state, slots: settled.value.slots! }));
  const retry = requireRosterAttempt(state.authority.judgeRoster, requireRosterRequest(state.authority.judgeRoster, event.request.requestId).slotId, 2);
  return persistentSuccess(Object.freeze({ state: next, action: Object.freeze({ kind: "spawn-architecture-judges" as const, runId: state.authority.runId, requests: Object.freeze([retry]) as NonEmpty<AgentRequestAuthority> }) }));
}

function reduceArchitectureJudgeAccepted(state: ArchitecturePanelState, event: Extract<PersistentArchitecturePanelEvent, { type: "architecture-judge-accepted" }>): PersistentPanelResult<PersistentArchitectureStep> {
  if (state.stage !== "awaiting-judges") return persistentFailure(panelError("architecture", "unexpected-event", `judge result is not accepted during ${state.stage}`));
  const result = durableAccepted(event.request, event.value);
  const settled = settleAccepted(state.authority.judgeRoster, state.slots, result);
  if (!settled.ok) return settled;
  const complete = completeSlotProgress(settled.value);
  const next = complete !== null
    ? architectureState(Object.freeze({
        panel: "architecture" as const,
        authority: state.authority,
        stage: "ready-to-aggregate" as const,
        candidateSlots: state.candidateSlots,
        judgeSlots: complete,
      }))
    : architectureState(Object.freeze({ ...state, slots: settled.value }));
  return persistentSuccess(Object.freeze({ state: next, action: next.stage === "awaiting-judges" ? null : architectureAction(next) }));
}

export function reducePersistentArchitecturePanel(state: ArchitecturePanelState, event: PersistentArchitecturePanelEvent): PersistentPanelResult<PersistentArchitectureStep> {
  try {
    if (!architectureStateProofs.has(state)) return persistentFailure(panelError("architecture", "malformed-checkpoint", "architecture reducer requires a parser-produced state"));
    if (state.stage === "done" || state.stage === "terminal-blocked") return terminalArchitecture(state);
    if (typeof event !== "object" || event === null || !architectureEventProofs.has(event)) return persistentFailure(panelError("architecture", "malformed-event", "architecture reducer requires a strictly parsed durable event"));
    switch (event.type) {
      case "architecture-candidate-accepted":
        return reduceArchitectureCandidateAccepted(state, event);
      case "architecture-candidate-rejected":
        return reduceArchitectureCandidateRejected(state, event);
      case "architecture-judge-rejected":
        return reduceArchitectureJudgeRejected(state, event);
      case "architecture-judge-accepted":
        return reduceArchitectureJudgeAccepted(state, event);
      case "architecture-ranking-completed": {
        if (state.stage !== "ready-to-aggregate") return persistentFailure(panelError("architecture", "unexpected-event", `ranking is not available during ${state.stage}`));
        const next = architectureState(Object.freeze({ ...state, stage: "done" as const, ranking: event.ranking }));
        return persistentSuccess(Object.freeze({ state: next, action: architectureAction(next) }));
      }
    }
  } catch (error) {
    // The message is KEPT. `requireRosterEntry`/`requireRosterAttempt` throw a
    // specific invariant violation naming the slot and attempt, and a bare
    // `catch {}` collapsed that into the same sentence a genuinely malformed
    // event produces — an operator could not tell a code regression from bad
    // input. Fail-closed is unchanged; only the diagnostic survives, exactly as
    // `panel-kernel`’s analogous catch already does.
    return persistentFailure(panelError(
      "architecture",
      "malformed-event",
      `architecture event could not be safely reduced: ${error instanceof Error ? error.message : String(error)}`,
    ));
  }
}

export function reducePersistentRefutationPanel(state: RefutationPanelState, event: PersistentRefutationPanelEvent): PersistentPanelResult<PersistentRefutationStep> {
  try {
    if (!refutationStateProofs.has(state)) return persistentFailure(panelError("refutation", "malformed-checkpoint", "refutation reducer requires a parser-produced state"));
    if (state.stage === "done" || state.stage === "terminal-blocked") return terminalRefutation(state);
    if (typeof event !== "object" || event === null || !refutationEventProofs.has(event)) return persistentFailure(panelError("refutation", "malformed-event", "refutation reducer requires a strictly parsed durable event"));
    if (event.type === "refutation-verdict-accepted") {
      if (state.stage !== "awaiting-verdicts") return persistentFailure(panelError("refutation", "unexpected-event", `verdict is not accepted during ${state.stage}`));
      const result = durableAccepted(event.request, event.value);
      const settled = settleAccepted(state.authority.verifierRoster, state.slots, result);
      if (!settled.ok) return settled;
      const complete = completeSlotProgress(settled.value);
      const next = complete !== null
        ? refutationState(Object.freeze({ panel: "refutation" as const, authority: state.authority, stage: "ready-to-tally" as const, slots: complete }))
        : refutationState(Object.freeze({ ...state, slots: settled.value }));
      return persistentSuccess(Object.freeze({ state: next, action: next.stage === "awaiting-verdicts" ? null : refutationAction(next) }));
    }
    if (event.type === "refutation-verdict-rejected") {
      if (state.stage !== "awaiting-verdicts") return persistentFailure(panelError("refutation", "unexpected-event", `verdict rejection is not accepted during ${state.stage}`));
      const settled = settleRejected("refutation", state.authority.verifierRoster, state.slots, event);
      if (!settled.ok) return settled;
      if (settled.value.terminal) {
        const next = refutationState(Object.freeze({
          panel: "refutation" as const,
          authority: state.authority,
          stage: "terminal-blocked" as const,
          slots: state.slots,
          diagnostic: settled.value.diagnostic as TerminalBlockedDiagnostic,
        }));
        return persistentSuccess(Object.freeze({ state: next, action: refutationAction(next) }));
      }
      const next = refutationState(Object.freeze({ ...state, slots: settled.value.slots! }));
      const retry = requireRosterAttempt(state.authority.verifierRoster, requireRosterRequest(state.authority.verifierRoster, event.request.requestId).slotId, 2);
      return persistentSuccess(Object.freeze({ state: next, action: Object.freeze({ kind: "spawn-refutation-verifiers" as const, runId: state.authority.runId, requests: Object.freeze([retry]) as NonEmpty<AgentRequestAuthority> }) }));
    }
    if (state.stage !== "ready-to-tally") return persistentFailure(panelError("refutation", "unexpected-event", `tally is not available during ${state.stage}`));
    const next = refutationState(Object.freeze({ ...state, stage: "done" as const, decision: event.decision }));
    return persistentSuccess(Object.freeze({ state: next, action: refutationAction(next) }));
  } catch (error) {
    // Same reason as the architecture reducer above: the thrown invariant names
    // the slot and attempt, and discarding it made a regression indistinguishable
    // from malformed input.
    return persistentFailure(panelError(
      "refutation",
      "malformed-event",
      `refutation event could not be safely reduced: ${error instanceof Error ? error.message : String(error)}`,
    ));
  }
}

function rejectionEvent(panel: "architecture" | "refutation", stage: "candidate" | "judge" | "verdict", request: PanelRequestIdentity, expected: AgentRequestAuthority, error: PersistentPanelError): PersistentArchitecturePanelEvent | PersistentRefutationPanelEvent {
  const category: "malformed-result" | "result-binding-mismatch" = error.kind === "request-binding-mismatch"
    ? "result-binding-mismatch"
    : "malformed-result";
  const fields = { schemaVersion: 1 as const, request, attempt: expected.attempt, category, message: error.message };
  if (panel === "refutation") return Object.freeze({ type: "refutation-verdict-rejected" as const, ...fields });
  return stage === "candidate"
    ? Object.freeze({ type: "architecture-candidate-rejected" as const, ...fields })
    : Object.freeze({ type: "architecture-judge-rejected" as const, ...fields });
}

function reduceParsedArchitecture(state: ArchitecturePanelState, rawEvent: PersistentArchitecturePanelEvent, resolver: PublicationAuthorityResolver): PersistentPanelResult<PersistentArchitectureStep> {
  const parsed = parsePersistentArchitecturePanelEvent(state, rawEvent, resolver);
  if (!parsed.ok) return parsed;
  const reduced = reducePersistentArchitecturePanel(state, parsed.value);
  return reduced.ok
    ? persistentSuccess(architectureRecordedStep(Object.freeze({ ...reduced.value, recordedEvent: parsed.value })))
    : reduced;
}
function reduceParsedRefutation(state: RefutationPanelState, rawEvent: PersistentRefutationPanelEvent, resolver: PublicationAuthorityResolver): PersistentPanelResult<PersistentRefutationStep> {
  const parsed = parsePersistentRefutationPanelEvent(state, rawEvent, resolver);
  if (!parsed.ok) return parsed;
  const reduced = reducePersistentRefutationPanel(state, parsed.value);
  return reduced.ok
    ? persistentSuccess(refutationRecordedStep(Object.freeze({ ...reduced.value, recordedEvent: parsed.value })))
    : reduced;
}

export function submitArchitectureCandidateResult(state: ArchitecturePanelState, resolver: PublicationAuthorityResolver, requestIdentity: unknown, raw: unknown): PersistentPanelResult<PersistentArchitectureStep> {
  if (state.stage !== "awaiting-candidates") return persistentFailure(panelError("architecture", "unexpected-event", `candidate cannot be submitted during ${state.stage}`));
  const resolved = resolvePanelRequest("architecture", state.authority.candidateRoster, requestIdentity, resolver);
  if (!resolved.ok) return resolved;
  const located = locateProgress(state.authority.candidateRoster, state.slots, resolved.value.expected.requestId);
  if (!located.ok) return located;
  const bound = boundCandidateEntry(state.authority, resolved.value.expected.slotId);
  if (!bound.ok) return bound;
  const parsed = parseCandidateClaim(raw, bound.value.lens, bound.value.candidate);
  if (!parsed.ok) return reduceParsedArchitecture(state, rejectionEvent("architecture", "candidate", resolved.value.identity, resolved.value.expected, parsed.error) as PersistentArchitecturePanelEvent, resolver);
  return reduceParsedArchitecture(state, Object.freeze({ schemaVersion: 1, type: "architecture-candidate-accepted", request: resolved.value.identity, value: parsed.value }), resolver);
}

/** The parsed JSON value of `text`, or `null` when it is not JSON. */
function parseJsonText(text: string): Readonly<{ value: unknown }> | null {
  try {
    return Object.freeze({ value: JSON.parse(text) as unknown });
  } catch {
    return null;
  }
}

function publicResultClaimsForeignAuthority(
  rawJson: unknown,
  expectedCriterion: string,
  collectionField: "rankings" | "verdicts",
  identityField: "candidate" | "finding_id",
  entryFields: readonly string[],
  expectedIdentities: readonly string[],
): boolean {
  if (typeof rawJson !== "string") return false;
  // Only the JSON parse is guarded: invalid JSON is ordinary malformed input
  // and claims no foreign authority. Everything after it reads through the
  // non-throwing `safeRecord`/`safeArray` snapshots, so a throw there is a code
  // regression and must surface, not silently downgrade the classification.
  const parsedJson = parseJsonText(rawJson);
  if (parsedJson === null) return false;
  const root = safeRecord(parsedJson.value, ["criterion", collectionField]);
  if (root === null) return false;
  if (typeof root.criterion === "string" && root.criterion !== expectedCriterion) return true;
  const entries = safeArray(root[collectionField]);
  if (entries === null) return false;
  return entries.some((rawEntry) => {
    const entry = safeRecord(rawEntry, entryFields);
    const claimedIdentity = entry?.[identityField];
    return typeof claimedIdentity === "string" && !expectedIdentities.includes(claimedIdentity);
  });
}

export function submitArchitectureJudgeResult(
  state: ArchitecturePanelState,
  resolver: PublicationAuthorityResolver,
  requestIdentity: unknown,
  rawJson: unknown,
  emission?: PanelVerdictEmissionSelectionOf<"judge-verdict">,
): PersistentPanelResult<PersistentArchitectureStep> {
  if (state.stage !== "awaiting-judges") return persistentFailure(panelError("architecture", "unexpected-event", `judge cannot be submitted during ${state.stage}`));
  const resolved = resolvePanelRequest("architecture", state.authority.judgeRoster, requestIdentity, resolver);
  if (!resolved.ok) return resolved;
  const located = locateProgress(state.authority.judgeRoster, state.slots, resolved.value.expected.requestId);
  if (!located.ok) return located;
  const bound = boundJudgeCriterion(state.authority, resolved.value.expected.slotId);
  if (!bound.ok) return bound;
  // AD-8: the verdict-source selection runs BEFORE the authoritative parse —
  // `foldVerdictSubmission` selects which bytes reach `parseJudgeVerdict`, and
  // the parse keeps its criterion binding and complete candidate coverage (the
  // source can never override issuance). Without an emission input the fold is
  // this seam's pre-selection behavior exactly.
  const issuanceProblem = panelVerdictEmissionIssuanceProblem(emission, resolved.value.expected.requestId, "architecture");
  if (issuanceProblem !== null) return persistentFailure(issuanceProblem);
  const fold = foldVerdictSubmission({
    label: "judge verdict",
    expectedRequestId: resolved.value.expected.requestId,
    emission,
    rawJson,
    parse: (target): ParseResult<JudgeVerdict> => typeof target === "string"
      ? parseJudgeVerdict(target, bound.value, state.authority.candidateIds)
      : fail(["judge result must be raw JSON text"]),
    classifyRaw: (target) => publicResultClaimsForeignAuthority(
      target,
      bound.value,
      "rankings",
      "candidate",
      ["candidate", "score", "fatal_flaw", "strongest_idea"],
      state.authority.candidateIds,
    ) ? "request-binding-mismatch" : "malformed-result",
    foreignAuthorityMessage: "judge criterion or candidate claims do not match the canonical request slot",
  });
  if (fold.kind === "rejected") {
    return reduceParsedArchitecture(state, rejectionEvent("architecture", "judge", resolved.value.identity, resolved.value.expected, panelError("architecture", fold.errorKind, fold.message)) as PersistentArchitecturePanelEvent, resolver);
  }
  return reduceParsedArchitecture(state, Object.freeze({ schemaVersion: 1, type: "architecture-judge-accepted", request: resolved.value.identity, value: fold.value, source: fold.source }), resolver);
}

export function submitRefutationVerdict(
  state: RefutationPanelState,
  resolver: PublicationAuthorityResolver,
  requestIdentity: unknown,
  rawJson: unknown,
  emission?: PanelVerdictEmissionSelectionOf<"refutation-verdict">,
): PersistentPanelResult<PersistentRefutationStep> {
  if (state.stage !== "awaiting-verdicts") return persistentFailure(panelError("refutation", "unexpected-event", `verdict cannot be submitted during ${state.stage}`));
  const resolved = resolvePanelRequest("refutation", state.authority.verifierRoster, requestIdentity, resolver);
  if (!resolved.ok) return resolved;
  const located = locateProgress(state.authority.verifierRoster, state.slots, resolved.value.expected.requestId);
  if (!located.ok) return located;
  const boundLens = boundRefutationLens(state.authority, resolved.value.expected.slotId);
  if (!boundLens.ok) return boundLens;
  const lens = boundLens.value;
  const findingIds = state.authority.findings.map(({ id }) => id);
  // AD-8, as the judge seam above: selection before the authoritative parse;
  // the parse keeps its lens binding and complete finding coverage (FR-012).
  const issuanceProblem = panelVerdictEmissionIssuanceProblem(emission, resolved.value.expected.requestId, "refutation");
  if (issuanceProblem !== null) return persistentFailure(issuanceProblem);
  const fold = foldVerdictSubmission({
    label: "refutation verdict",
    expectedRequestId: resolved.value.expected.requestId,
    emission,
    rawJson,
    parse: (target): ParseResult<VerdictEnvelope<RefutationVerdict>> => typeof target === "string"
      ? parseRefutationVerdict(target, lens, findingIds)
      : fail(["refutation result must be raw JSON text"]),
    classifyRaw: (target) => publicResultClaimsForeignAuthority(
      target,
      lens,
      "verdicts",
      "finding_id",
      ["finding_id", "verdict", "reasoning"],
      findingIds,
    ) ? "request-binding-mismatch" : "malformed-result",
    foreignAuthorityMessage: "refutation criterion or Finding claims do not match the canonical request slot",
  });
  if (fold.kind === "rejected") {
    return reduceParsedRefutation(state, rejectionEvent("refutation", "verdict", resolved.value.identity, resolved.value.expected, panelError("refutation", fold.errorKind, fold.message)) as PersistentRefutationPanelEvent, resolver);
  }
  return reduceParsedRefutation(state, Object.freeze({ schemaVersion: 1, type: "refutation-verdict-accepted", request: resolved.value.identity, value: fold.value, source: fold.source }), resolver);
}

/**
 * Records a capture rejection for one refutation verdict: the attempt's bytes
 * never landed (the harness terminally rejected the capture, e.g. a child that
 * exited without a final payload), so there is no verdict to parse and the
 * slot advances to its attempt-2 retry with the capture diagnostic as the
 * rejection message. `submitRefutationVerdict` cannot record this — its
 * diagnostic is derived from parsing bytes that never landed — so the resume
 * that detects the tombstone calls this with the capture runtime's own
 * diagnostic instead. The category is `malformed-result` because the verdict
 * was malformed by absence: it never existed as a valid payload.
 */
export function rejectRefutationVerdict(state: RefutationPanelState, resolver: PublicationAuthorityResolver, requestIdentity: unknown, diagnostic: string): PersistentPanelResult<PersistentRefutationStep> {
  if (state.stage !== "awaiting-verdicts") return persistentFailure(panelError("refutation", "unexpected-event", `a capture rejection cannot be recorded during ${state.stage}`));
  const resolved = resolvePanelRequest("refutation", state.authority.verifierRoster, requestIdentity, resolver);
  if (!resolved.ok) return resolved;
  const located = locateProgress(state.authority.verifierRoster, state.slots, resolved.value.expected.requestId);
  if (!located.ok) return located;
  return reduceParsedRefutation(state, rejectionEvent("refutation", "verdict", resolved.value.identity, located.value.expected, panelError("refutation", "malformed-result", diagnostic)) as PersistentRefutationPanelEvent, resolver);
}

function rehydrateAccepted<T>(panel: "architecture" | "refutation", roster: ExactRoster, accepted: readonly DurableAcceptedPanelResult<T>[], resolver: PublicationAuthorityResolver): PersistentPanelResult<readonly AcceptedAgentResult<T>[]> {
  const results: AcceptedAgentResult<T>[] = [];
  for (const durable of accepted) {
    const resolved = resolvePanelRequest(panel, roster, durable.request, resolver);
    if (!resolved.ok) return resolved;
    const acceptedResult = acceptedAgentResult(resolved.value.request, durable.value);
    if (!acceptedResult.ok) return rehydrationFailure(panel, resolved.value.expected, acceptedResult.error);
    results.push(acceptedResult.value);
  }
  return persistentSuccess(Object.freeze(results));
}

export function proveArchitectureJudgeRoster(state: ArchitecturePanelState, resolver: PublicationAuthorityResolver): PersistentPanelResult<CompleteRoster<AcceptedAgentResult<JudgeVerdict>>> {
  const accepted = rehydrateAccepted("architecture", state.authority.judgeRoster, selectAcceptedArchitectureJudges(state), resolver);
  if (!accepted.ok) return accepted;
  const proven = parseCompleteRoster(resolver, state.authority.judgeRoster, accepted.value, (raw) => {
    const record = safeRecord(raw, ["criterion", "entries"]);
    const expected = record === null ? undefined : state.authority.judgeCriteria.find((criterion) => criterion === record.criterion);
    return expected === undefined ? { ok: false, error: { message: "judge criterion is not authoritative" } } : parseCanonicalJudge(raw, state.authority, expected);
  });
  if (!proven.ok) return persistentFailure(panelError("architecture", "incomplete-roster", proven.error.violations.map(({ kind }) => kind).join("; ")));
  architectureJudgeRosterProofs.set(proven.value, state.authority);
  return persistentSuccess(proven.value);
}

export function proveRefutationRoster(state: RefutationPanelState, resolver: PublicationAuthorityResolver): PersistentPanelResult<CompleteRoster<AcceptedAgentResult<VerdictEnvelope<RefutationVerdict>>>> {
  const accepted = rehydrateAccepted("refutation", state.authority.verifierRoster, selectAcceptedRefutationVerdicts(state), resolver);
  if (!accepted.ok) return accepted;
  const proven = parseCompleteRoster(resolver, state.authority.verifierRoster, accepted.value, (raw) => {
    const record = safeRecord(raw, ["criterion", "entries"]);
    const expected = record === null ? undefined : state.authority.lenses.find((lens) => lens === record.criterion);
    return expected === undefined ? { ok: false, error: { message: "refutation lens is not authoritative" } } : parseCanonicalRefutation(raw, state.authority, expected);
  });
  if (!proven.ok) return persistentFailure(panelError("refutation", "incomplete-roster", proven.error.violations.map(({ kind }) => kind).join("; ")));
  refutationRosterProofs.set(proven.value, state.authority);
  return persistentSuccess(proven.value);
}

function completeRosterMatches(roster: ExactRoster, complete: CompleteRoster<AcceptedAgentResult<unknown>>): boolean {
  return complete.ordered.length === roster.orderedSlots.length && roster.orderedSlots.every((slot, index) => {
    const result = complete.ordered[index];
    return result !== undefined && result.authority.slotId === slot.slotId && authorityMatches(result.authority, result.authority.attempt === 1 ? slot.attempts[0] : slot.attempts[1]);
  });
}

export function aggregateArchitecturePanel(authority: ArchitecturePanelAuthority, complete: CompleteRoster<AcceptedAgentResult<JudgeVerdict>>): PersistentPanelResult<readonly CandidateRanking[]> {
  try {
    if (architectureJudgeRosterProofs.get(complete) !== authority || !completeRosterMatches(authority.judgeRoster, complete as CompleteRoster<AcceptedAgentResult<unknown>>)) return persistentFailure(panelError("architecture", "incomplete-roster", "complete judge roster is unproved, stale, or belongs to another panel"));
    const aggregated = aggregateVerdicts(complete.ordered.map(({ value }) => value), authority.judgeCriteria, authority.candidateIds);
    return aggregated.ok ? persistentSuccess(Object.freeze([...aggregated.value])) : persistentFailure(panelError("architecture", "invalid-aggregate", aggregated.errors.join("; ")));
  } catch (error) {
    // The message is KEPT, for the reason the sibling reducers above document:
    // a bare `catch {}` makes a code regression indistinguishable from bad
    // input. Fail-closed is unchanged; only the diagnostic survives.
    return persistentFailure(panelError("architecture", "invalid-aggregate", `judge roster could not be safely aggregated: ${error instanceof Error ? error.message : String(error)}`));
  }
}

export function tallyRefutationPanel(authority: RefutationPanelAuthority, complete: CompleteRoster<AcceptedAgentResult<VerdictEnvelope<RefutationVerdict>>>, requestedThreshold = defaultRefutationThreshold(authority.lenses.length)): PersistentPanelResult<RefutationDecision> {
  try {
    if (refutationRosterProofs.get(complete) !== authority || !completeRosterMatches(authority.verifierRoster, complete as CompleteRoster<AcceptedAgentResult<unknown>>)) return persistentFailure(panelError("refutation", "incomplete-roster", "complete verifier roster is unproved, stale, or belongs to another panel"));
    const strictMajority = defaultRefutationThreshold(authority.lenses.length);
    if (requestedThreshold !== strictMajority) return persistentFailure(panelError("refutation", "invalid-aggregate", `threshold must equal the derived strict majority ${strictMajority}`));
    const verdicts = complete.ordered.map(({ value }) => value);
    const tallied = tallyRefutations(verdicts, authority.lenses, authority.findings, strictMajority);
    if (!tallied.ok) return persistentFailure(panelError("refutation", "invalid-aggregate", tallied.errors.join("; ")));
    const outcomes = Object.freeze([...tallied.value]);
    return persistentSuccess(Object.freeze({ threshold: strictMajority, lenses: authority.lenses, verdicts: Object.freeze(verdicts), outcomes, retained: Object.freeze(outcomes.filter(({ survives }) => survives)), refuted: Object.freeze(outcomes.filter(({ survives }) => !survives)) }));
  } catch (error) {
    // Same reasoning as `aggregateArchitecturePanel` above: keep the message.
    return persistentFailure(panelError("refutation", "invalid-aggregate", `verifier roster could not be safely tallied: ${error instanceof Error ? error.message : String(error)}`));
  }
}

export function completePersistentArchitecturePanel(state: ArchitecturePanelState, resolver: PublicationAuthorityResolver): PersistentPanelResult<PersistentArchitectureStep> {
  const proof = proveArchitectureJudgeRoster(state, resolver);
  if (!proof.ok) return proof;
  const ranking = aggregateArchitecturePanel(state.authority, proof.value);
  if (!ranking.ok) return ranking;
  return reduceParsedArchitecture(state, Object.freeze({ schemaVersion: 1, type: "architecture-ranking-completed", ranking: ranking.value }), resolver);
}

export function completePersistentRefutationPanel(state: RefutationPanelState, resolver: PublicationAuthorityResolver, threshold?: number): PersistentPanelResult<PersistentRefutationStep> {
  const proof = proveRefutationRoster(state, resolver);
  if (!proof.ok) return proof;
  const decision = tallyRefutationPanel(state.authority, proof.value, threshold);
  if (!decision.ok) return decision;
  return reduceParsedRefutation(state, Object.freeze({ schemaVersion: 1, type: "refutation-tally-completed", decision: decision.value }), resolver);
}

type ReplayedArchitecturePrefix = Readonly<{
  step: PersistentArchitectureStep;
  events: readonly PersistentArchitecturePanelEvent[];
}>;
type ReplayedRefutationPrefix = Readonly<{
  step: PersistentRefutationStep;
  events: readonly PersistentRefutationPanelEvent[];
}>;

function replayArchitecturePrefix(
  authority: ArchitecturePanelAuthority,
  rawEvents: unknown,
  resolver: PublicationAuthorityResolver,
): PersistentPanelResult<ReplayedArchitecturePrefix> {
  const events = safeArray(rawEvents);
  if (events === null) return persistentFailure(panelError("architecture", "malformed-event", "architecture history must be a dense JSON event array"));
  const parsedEvents: PersistentArchitecturePanelEvent[] = [];
  let step = startPersistentArchitecturePanel(authority);
  for (const raw of events) {
    const parsed = parsePersistentArchitecturePanelEvent(step.state, raw, resolver);
    if (!parsed.ok) return parsed;
    const reduced = reducePersistentArchitecturePanel(step.state, parsed.value);
    if (!reduced.ok) return reduced;
    parsedEvents.push(parsed.value);
    step = reduced.value;
  }
  return persistentSuccess(Object.freeze({ step, events: Object.freeze(parsedEvents) }));
}

function replayRefutationPrefix(
  authority: RefutationPanelAuthority,
  rawEvents: unknown,
  resolver: PublicationAuthorityResolver,
): PersistentPanelResult<ReplayedRefutationPrefix> {
  const events = safeArray(rawEvents);
  if (events === null) return persistentFailure(panelError("refutation", "malformed-event", "refutation history must be a dense JSON event array"));
  const parsedEvents: PersistentRefutationPanelEvent[] = [];
  let step = startPersistentRefutationPanel(authority);
  for (const raw of events) {
    const parsed = parsePersistentRefutationPanelEvent(step.state, raw, resolver);
    if (!parsed.ok) return parsed;
    const reduced = reducePersistentRefutationPanel(step.state, parsed.value);
    if (!reduced.ok) return reduced;
    parsedEvents.push(parsed.value);
    step = reduced.value;
  }
  return persistentSuccess(Object.freeze({ step, events: Object.freeze(parsedEvents) }));
}

export function replayPersistentArchitecturePanel(authority: ArchitecturePanelAuthority, rawEvents: unknown, resolver: PublicationAuthorityResolver): PersistentPanelResult<PersistentArchitectureStep> {
  const replayed = replayArchitecturePrefix(authority, rawEvents, resolver);
  return replayed.ok ? persistentSuccess(replayed.value.step) : replayed;
}

export function replayPersistentRefutationPanel(authority: RefutationPanelAuthority, rawEvents: unknown, resolver: PublicationAuthorityResolver): PersistentPanelResult<PersistentRefutationStep> {
  const replayed = replayRefutationPrefix(authority, rawEvents, resolver);
  return replayed.ok ? persistentSuccess(replayed.value.step) : replayed;
}

/** Parse and replay an immutable architecture event prefix into persistence authority. */
export function parsePersistentArchitecturePanelHistory(
  authority: ArchitecturePanelAuthority,
  rawEvents: unknown,
  resolver: PublicationAuthorityResolver,
): PersistentPanelResult<PersistentArchitecturePanelHistory> {
  const replayed = replayArchitecturePrefix(authority, rawEvents, resolver);
  if (!replayed.ok) return replayed;
  const history = Object.freeze({
    panel: "architecture" as const,
    authority,
    events: replayed.value.events,
  }) as PersistentArchitecturePanelHistory;
  architectureHistoryProofs.add(history);
  return persistentSuccess(history);
}

/** Parse and replay an immutable refutation event prefix into persistence authority. */
export function parsePersistentRefutationPanelHistory(
  authority: RefutationPanelAuthority,
  rawEvents: unknown,
  resolver: PublicationAuthorityResolver,
): PersistentPanelResult<PersistentRefutationPanelHistory> {
  const replayed = replayRefutationPrefix(authority, rawEvents, resolver);
  if (!replayed.ok) return replayed;
  const history = Object.freeze({
    panel: "refutation" as const,
    authority,
    events: replayed.value.events,
  }) as PersistentRefutationPanelHistory;
  refutationHistoryProofs.add(history);
  return persistentSuccess(history);
}

function architectureAuthorityJson(authority: ArchitecturePanelAuthority): ArchitecturePanelAuthorityInput {
  return Object.freeze({ runId: authority.runId, candidateLenses: authority.candidateLenses, judgeCriteria: authority.judgeCriteria, candidateSlots: authority.candidateRoster.orderedSlots, judgeSlots: authority.judgeRoster.orderedSlots });
}
function refutationAuthorityJson(authority: RefutationPanelAuthority): RefutationPanelAuthorityInput {
  return Object.freeze({
    runId: authority.runId,
    identityRunId: authority.identityRunId,
    findings: authority.findings,
    lenses: authority.lenses,
    verifierSlots: authority.verifierRoster.orderedSlots,
  });
}

export type ArchitecturePanelCheckpoint = Readonly<{ schemaVersion: 2; kind: "architecture-panel-checkpoint"; authority: ArchitecturePanelAuthorityInput; events: readonly PersistentArchitecturePanelEvent[]; state: unknown }>;
export type RefutationPanelCheckpoint = Readonly<{ schemaVersion: 2; kind: "refutation-panel-checkpoint"; authority: RefutationPanelAuthorityInput; events: readonly PersistentRefutationPanelEvent[]; state: unknown }>;

export function architecturePanelCheckpoint(
  state: ArchitecturePanelState,
  events: readonly PersistentArchitecturePanelEvent[],
  resolver: PublicationAuthorityResolver,
): PersistentPanelResult<ArchitecturePanelCheckpoint> {
  if (!architectureStateProofs.has(state)) return persistentFailure(panelError("architecture", "malformed-checkpoint", "checkpoint requires parser-produced architecture state"));
  const replayed = replayArchitecturePrefix(state.authority, events, resolver);
  if (!replayed.ok) return replayed;
  if (!jsonEqual(replayed.value.step.state, state)) return persistentFailure(panelError("architecture", "malformed-checkpoint", "architecture checkpoint event prefix does not replay to the supplied state"));
  const replayedState = JSON.parse(JSON.stringify(replayed.value.step.state)) as unknown;
  return persistentSuccess(Object.freeze({ schemaVersion: 2, kind: "architecture-panel-checkpoint", authority: architectureAuthorityJson(state.authority), events: replayed.value.events, state: replayedState }));
}
export function refutationPanelCheckpoint(
  state: RefutationPanelState,
  events: readonly PersistentRefutationPanelEvent[],
  resolver: PublicationAuthorityResolver,
): PersistentPanelResult<RefutationPanelCheckpoint> {
  if (!refutationStateProofs.has(state)) return persistentFailure(panelError("refutation", "malformed-checkpoint", "checkpoint requires parser-produced refutation state"));
  const replayed = replayRefutationPrefix(state.authority, events, resolver);
  if (!replayed.ok) return replayed;
  if (!jsonEqual(replayed.value.step.state, state)) return persistentFailure(panelError("refutation", "malformed-checkpoint", "refutation checkpoint event prefix does not replay to the supplied state"));
  const replayedState = JSON.parse(JSON.stringify(replayed.value.step.state)) as unknown;
  return persistentSuccess(Object.freeze({ schemaVersion: 2, kind: "refutation-panel-checkpoint", authority: refutationAuthorityJson(state.authority), events: replayed.value.events, state: replayedState }));
}

export function parseArchitecturePanelCheckpoint(raw: unknown, resolver: PublicationAuthorityResolver): PersistentPanelResult<PersistentArchitectureStep> {
  const checkpoint = safeRecord(raw, ["schemaVersion", "kind", "authority", "events", "state"]);
  if (checkpoint === null || checkpoint.schemaVersion !== 2 || checkpoint.kind !== "architecture-panel-checkpoint") return persistentFailure(panelError("architecture", "malformed-checkpoint", "architecture checkpoint must be an exact schemaVersion 2 record"));
  const authority = parseArchitecturePanelAuthority(checkpoint.authority as ArchitecturePanelAuthorityInput);
  if (!authority.ok) return authority;
  const replayed = replayPersistentArchitecturePanel(authority.value, checkpoint.events, resolver);
  if (!replayed.ok) return replayed;
  if (!jsonEqual(checkpoint.state, replayed.value.state)) return persistentFailure(panelError("architecture", "malformed-checkpoint", "architecture checkpoint state disagrees with its immutable event prefix"));
  return replayed;
}
export function parseRefutationPanelCheckpoint(raw: unknown, resolver: PublicationAuthorityResolver): PersistentPanelResult<PersistentRefutationStep> {
  const checkpoint = safeRecord(raw, ["schemaVersion", "kind", "authority", "events", "state"]);
  if (checkpoint === null || checkpoint.schemaVersion !== 2 || checkpoint.kind !== "refutation-panel-checkpoint") return persistentFailure(panelError("refutation", "malformed-checkpoint", "refutation checkpoint must be an exact schemaVersion 2 record"));
  const authority = parseRefutationPanelAuthority(checkpoint.authority as RefutationPanelAuthorityInput);
  if (!authority.ok) return authority;
  const replayed = replayPersistentRefutationPanel(authority.value, checkpoint.events, resolver);
  if (!replayed.ok) return replayed;
  if (!jsonEqual(checkpoint.state, replayed.value.state)) return persistentFailure(panelError("refutation", "malformed-checkpoint", "refutation checkpoint state disagrees with its immutable event prefix"));
  return replayed;
}

export type ArchitecturePanelPersistenceEffect =
  | Readonly<{ schemaVersion: 1; kind: "append-architecture-panel-event"; runId: OrchestrationRunId; sequence: number; dedupKey: string; event: PersistentArchitecturePanelEvent }>
  | Readonly<{ schemaVersion: 1; kind: "replace-architecture-panel-checkpoint"; runId: OrchestrationRunId; sequence: number; dedupKey: string; checkpoint: ArchitecturePanelCheckpoint }>;
export type RefutationPanelPersistenceEffect =
  | Readonly<{ schemaVersion: 1; kind: "append-refutation-panel-event"; runId: OrchestrationRunId; sequence: number; dedupKey: string; event: PersistentRefutationPanelEvent }>
  | Readonly<{ schemaVersion: 1; kind: "replace-refutation-panel-checkpoint"; runId: OrchestrationRunId; sequence: number; dedupKey: string; checkpoint: RefutationPanelCheckpoint }>;
export type PanelPersistenceReceipt = Readonly<{ schemaVersion: 1; kind: "panel-persistence-recorded"; panel: "architecture" | "refutation"; runId: OrchestrationRunId; sequence: number; dedupKey: string }>;

function persistenceKey(runId: OrchestrationRunId, sequence: number, payload: unknown): string {
  return `${runId}:${sequence}:${sha256Hex(JSON.stringify(payload))}`;
}

export function planArchitecturePanelPersistence(
  step: PersistentArchitectureStep,
  history: PersistentArchitecturePanelHistory,
  resolver: PublicationAuthorityResolver,
): PersistentPanelResult<readonly [ArchitecturePanelPersistenceEffect, ArchitecturePanelPersistenceEffect]> {
  const event = step.recordedEvent;
  if (event === undefined || !architectureRecordedStepProofs.has(step) ||
      !architectureStateProofs.has(step.state) || !architectureEventProofs.has(event)) {
    return persistentFailure(panelError("architecture", "malformed-event", "persistence planning requires a parser/reducer-produced architecture step and event"));
  }
  if (!architectureHistoryProofs.has(history) || history.panel !== "architecture" ||
      !jsonEqual(architectureAuthorityJson(history.authority), architectureAuthorityJson(step.state.authority))) {
    return persistentFailure(panelError("architecture", "malformed-history", "persistence planning requires a replay-proved architecture history for the same panel authority"));
  }
  const events = Object.freeze([...history.events, event]);
  const replayed = replayArchitecturePrefix(step.state.authority, events, resolver);
  if (!replayed.ok) return replayed;
  if (!jsonEqual(replayed.value.step.state, step.state)) {
    return persistentFailure(panelError("architecture", "malformed-checkpoint", "architecture event prefix does not replay exactly to the proposed checkpoint state"));
  }
  const checkpoint = architecturePanelCheckpoint(replayed.value.step.state, replayed.value.events, resolver);
  if (!checkpoint.ok) return checkpoint;
  const sequence = events.length;
  const append = Object.freeze({ schemaVersion: 1 as const, kind: "append-architecture-panel-event" as const, runId: step.state.authority.runId, sequence, dedupKey: persistenceKey(step.state.authority.runId, sequence, event), event });
  const replace = Object.freeze({ schemaVersion: 1 as const, kind: "replace-architecture-panel-checkpoint" as const, runId: step.state.authority.runId, sequence, dedupKey: persistenceKey(step.state.authority.runId, sequence, checkpoint.value), checkpoint: checkpoint.value });
  return persistentSuccess(Object.freeze([append, replace]) as readonly [ArchitecturePanelPersistenceEffect, ArchitecturePanelPersistenceEffect]);
}
export function planRefutationPanelPersistence(
  step: PersistentRefutationStep,
  history: PersistentRefutationPanelHistory,
  resolver: PublicationAuthorityResolver,
): PersistentPanelResult<readonly [RefutationPanelPersistenceEffect, RefutationPanelPersistenceEffect]> {
  const event = step.recordedEvent;
  if (event === undefined || !refutationRecordedStepProofs.has(step) ||
      !refutationStateProofs.has(step.state) || !refutationEventProofs.has(event)) {
    return persistentFailure(panelError("refutation", "malformed-event", "persistence planning requires a parser/reducer-produced refutation step and event"));
  }
  if (!refutationHistoryProofs.has(history) || history.panel !== "refutation" ||
      !jsonEqual(refutationAuthorityJson(history.authority), refutationAuthorityJson(step.state.authority))) {
    return persistentFailure(panelError("refutation", "malformed-history", "persistence planning requires a replay-proved refutation history for the same panel authority"));
  }
  const events = Object.freeze([...history.events, event]);
  const replayed = replayRefutationPrefix(step.state.authority, events, resolver);
  if (!replayed.ok) return replayed;
  if (!jsonEqual(replayed.value.step.state, step.state)) {
    return persistentFailure(panelError("refutation", "malformed-checkpoint", "refutation event prefix does not replay exactly to the proposed checkpoint state"));
  }
  const checkpoint = refutationPanelCheckpoint(replayed.value.step.state, replayed.value.events, resolver);
  if (!checkpoint.ok) return checkpoint;
  const sequence = events.length;
  const append = Object.freeze({ schemaVersion: 1 as const, kind: "append-refutation-panel-event" as const, runId: step.state.authority.runId, sequence, dedupKey: persistenceKey(step.state.authority.runId, sequence, event), event });
  const replace = Object.freeze({ schemaVersion: 1 as const, kind: "replace-refutation-panel-checkpoint" as const, runId: step.state.authority.runId, sequence, dedupKey: persistenceKey(step.state.authority.runId, sequence, checkpoint.value), checkpoint: checkpoint.value });
  return persistentSuccess(Object.freeze([append, replace]) as readonly [RefutationPanelPersistenceEffect, RefutationPanelPersistenceEffect]);
}

export function parsePanelPersistenceReceipt(raw: unknown, expected: ArchitecturePanelPersistenceEffect | RefutationPanelPersistenceEffect): PersistentPanelResult<PanelPersistenceReceipt> {
  const panel = expected.kind.includes("architecture") ? "architecture" : "refutation";
  const receipt = safeRecord(raw, ["schemaVersion", "kind", "panel", "runId", "sequence", "dedupKey"]);
  if (receipt === null || receipt.schemaVersion !== 1 || receipt.kind !== "panel-persistence-recorded" || receipt.panel !== panel || receipt.runId !== expected.runId || receipt.sequence !== expected.sequence || receipt.dedupKey !== expected.dedupKey) {
    return persistentFailure(panelError(panel, "persistence-receipt-mismatch", "panel persistence receipt does not match the exact journal/checkpoint effect"));
  }
  return persistentSuccess(Object.freeze({ schemaVersion: 1, kind: "panel-persistence-recorded", panel, runId: expected.runId, sequence: expected.sequence, dedupKey: expected.dedupKey }));
}

