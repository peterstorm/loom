/**
 * The durable, authority-bound refutation panel program (schema v2): its
 * stage topology, durable event parser and result parsing, instantiated over
 * the persistent program kernel.
 *
 * Every invariant the panel relies on is stated once:
 *
 *   - the slot-progress kernel here (`locateProgress`, `acceptSlot`,
 *     `rejectSlot`, `reduceRejectedSlot`) owns stale-request,
 *     duplicate-result, retry-to-attempt-2 and terminal-blocked for the
 *     verifier roster;
 *   - the program kernel (`core/persistent-panel-program`: the
 *     `PanelProgramDefinition`, the reducer guard, replay and checkpoints)
 *     owns replay-equals-state; this module supplies only `REFUTATION_PROGRAM`;
 *   - one module-private membership domain (`proofs`, from the kernel's
 *     `createPanelProofs`) owns which values came from start, reduction,
 *     replay or checkpoint parsing.
 *
 * The panel contributes only its stage topology and its result parsing. Every
 * state, event and recorded step is minted in this module's private proof
 * domain, so a value that did not come from start, reduction, replay or
 * checkpoint parsing cannot be resumed, reduced or checkpointed. The issued
 * roster authority comes from `panel-authority`; the verdict-source selection
 * a verdict submission runs before its authoritative parse comes from
 * `panel-verdict-source`.
 *
 * Architecture panels do not run here: the registered architecture panel is
 * driven by `handlers/helpers/programs/legacy-panel.ts` over its Run Directory
 * journal (ADR-0029, ADR-0030).
 *
 * Durable bytes are unchanged by the shared kernel: every state, event and
 * checkpoint is built with the key order its persisted form has
 * always had, because checkpoint parsing compares the recorded state with the
 * replayed one as JSON text.
 *
 * Pure module: no I/O, no clock, no randomness.
 */
import {
  defaultRefutationThreshold,
  parseRefutationVerdict,
  tallyRefutations,
  type FindingOutcome,
  type RefutationVerdict,
  type ReviewLens,
} from "./review-panel";
import { fail, sanitizeProse, type ParseResult, type VerdictEnvelope } from "./panel-kernel";
import {
  createPanelProofs,
  jsonEqual,
  panelProgramCheckpoint,
  parsePanelProgramCheckpoint,
  reduceParsedPanelEvent,
  reducePanelProgram,
  replayPanelProgram,
  resumePanelProgram,
  type PanelCheckpoint,
  type PanelProgramDefinition,
  type PanelStep,
} from "./persistent-panel-program";
import { safeArray, safeRecord } from "./exact-data";
import { isRecord } from "./plain-record";
import {
  authorityMatches,
  boundRefutationLens,
  boundedPanelMessage,
  panelError,
  parseRefutationPanelAuthority,
  persistentFailure,
  persistentSuccess,
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
  canonicalExactRosterJson,
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

declare const REFUTATION_PANEL_STATE: unique symbol;

type RefutationPanelStateBrand = Readonly<{ [REFUTATION_PANEL_STATE]: "RefutationPanelState" }>;

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

export type RefutationPanelAction =
  | Readonly<{ kind: "spawn-refutation-verifiers"; runId: OrchestrationRunId; requests: NonEmpty<AgentRequestAuthority> }>
  | Readonly<{ kind: "refutation-tally-ready"; runId: OrchestrationRunId }>
  | Readonly<{ kind: "refutation-blocked"; runId: OrchestrationRunId; diagnostic: BlockedDiagnostic }>
  | Readonly<{ kind: "refutation-done"; runId: OrchestrationRunId; decision: RefutationDecision }>;

/** The two durable rejection categories a slot rejection event carries. */
type RejectionCategory = "malformed-result" | "result-binding-mismatch";

/** The fields every slot rejection event carries. */
type SlotRejection = Readonly<{ request: PanelRequestIdentity; attempt: SemanticAttempt; category: RejectionCategory; message: string }>;

export type PersistentRefutationPanelEvent =
  | Readonly<{ schemaVersion: 1; type: "refutation-verdict-accepted"; request: PanelRequestIdentity; value: VerdictEnvelope<RefutationVerdict>; source: PanelVerdictSource }>
  | Readonly<{ schemaVersion: 1; type: "refutation-verdict-rejected"; request: PanelRequestIdentity; attempt: SemanticAttempt; category: RejectionCategory; message: string }>
  | Readonly<{ schemaVersion: 1; type: "refutation-tally-completed"; decision: RefutationDecision }>;

export type PersistentRefutationStep = PanelStep<RefutationPanelState, RefutationPanelAction, PersistentRefutationPanelEvent>;

// ---------------------------------------------------------------------------
// Membership proofs: the ONE authority over which values this module minted
// ---------------------------------------------------------------------------

/** Every minted state, event and recorded step of the panel, in one
 *  module-private domain: no other module can mint into it. */
const proofs = createPanelProofs();
const { prove, proven } = proofs;
/** Each proved complete roster, bound to the exact panel authority it was proved for. */
const completeRosterProofs = new WeakMap<object, RefutationPanelAuthority>();

/** The panel's durable error, its one panel kind bound once. */
const refutationError = (
  kind: PersistentPanelError["kind"],
  message: string,
  request?: Parameters<typeof panelError>[3],
): PersistentPanelError => panelError("refutation", kind, message, request);

function refutationState<T extends RefutationPanelStateData>(state: T): T & RefutationPanelStateBrand {
  return prove("refutation:state", state) as T & RefutationPanelStateBrand;
}

// ---------------------------------------------------------------------------
// Roster access
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// The slot-progress kernel: the verifier roster's slots
// ---------------------------------------------------------------------------

function initialSlots<Result>(roster: ExactRoster): NonEmpty<OpenSlot<Result>> {
  return Object.freeze(roster.orderedSlots.map(({ slotId }) => Object.freeze({ slotId, status: "pending" as const, nextAttempt: 1 as const }))) as unknown as NonEmpty<OpenSlot<Result>>;
}

function pendingAuthorities<Result>(roster: ExactRoster, slots: NonEmpty<OpenSlot<Result>>): NonEmpty<AgentRequestAuthority> | null {
  const requests = slots.flatMap((progress) => progress.status === "accepted" ? [] : [requireRosterAttempt(roster, progress.slotId, progress.nextAttempt)]);
  return requests.length === 0 ? null : Object.freeze(requests) as unknown as NonEmpty<AgentRequestAuthority>;
}

type LocatedProgress<Result> = Readonly<{ index: number; slot: OpenSlot<Result>; expected: AgentRequestAuthority }>;

/** The open slot a request belongs to: unknown, duplicate and stale requests
 *  refuse here, once. */
function locateProgress<Result>(
  roster: ExactRoster,
  slots: NonEmpty<OpenSlot<Result>>,
  requestId: string,
): PersistentPanelResult<LocatedProgress<Result>> {
  const authority = findRosterRequest(roster, requestId);
  if (authority === null) return persistentFailure(refutationError("unknown-request", `request ${requestId} is not in the active canonical roster`, { requestId }));
  const index = slots.findIndex(({ slotId }) => slotId === authority.slotId);
  if (index < 0) return persistentFailure(refutationError("unknown-request", `request ${requestId} does not belong to the active panel stage`, { requestId, slotId: authority.slotId }));
  const progress = slots[index]!;
  if (progress.status === "accepted") return persistentFailure(refutationError("duplicate-result", `slot ${progress.slotId} already has an accepted result`, { requestId, slotId: progress.slotId }));
  const expected = requireRosterAttempt(roster, progress.slotId, progress.nextAttempt);
  if (expected.requestId !== requestId) return persistentFailure(refutationError("stale-request", `slot ${progress.slotId} expects attempt ${progress.nextAttempt}, not request ${requestId}`, { requestId, slotId: progress.slotId }));
  return persistentSuccess(Object.freeze({ index, slot: progress, expected }));
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

function replaceSlot<Result>(slots: NonEmpty<OpenSlot<Result>>, index: number, replacement: OpenSlot<Result>): NonEmpty<OpenSlot<Result>> {
  return Object.freeze(slots.map((slot, candidateIndex) => candidateIndex === index ? replacement : slot)) as unknown as NonEmpty<OpenSlot<Result>>;
}

function durableAccepted<T>(request: PanelRequestIdentity, value: T): DurableAcceptedPanelResult<T> {
  return Object.freeze({ schemaVersion: 1, kind: "panel-result-accepted", request, value });
}

/** An accepted result either leaves its stage waiting (`partial`) or completes it. */
type SlotAcceptance<Result> =
  | Readonly<{ kind: "partial"; slots: NonEmpty<OpenSlot<Result>> }>
  | Readonly<{ kind: "complete"; slots: CompleteSlotProgress<Result> }>;

function acceptSlot<Result>(
  roster: ExactRoster,
  slots: NonEmpty<OpenSlot<Result>>,
  request: PanelRequestIdentity,
  value: Result,
): PersistentPanelResult<SlotAcceptance<Result>> {
  const located = locateProgress(roster, slots, request.requestId);
  if (!located.ok) return located;
  const settled = replaceSlot(slots, located.value.index, Object.freeze({
    slotId: located.value.expected.slotId,
    status: "accepted" as const,
    result: durableAccepted(request, value),
  }));
  const complete = completeSlotProgress(settled);
  return persistentSuccess(complete === null
    ? Object.freeze({ kind: "partial" as const, slots: settled })
    : Object.freeze({ kind: "complete" as const, slots: complete }));
}

/**
 * The retry gate: an attempt-1 rejection retries only when the slot's retry
 * request pair can carry a semantic retry diagnostic. The diagnostic itself
 * is not kept — the `retry` outcome carries the attempt-2 request, not a
 * diagnostic — so only its constructibility is the gate.
 */
function retryDiagnosticConstructible(roster: ExactRoster, slotId: SlotId, category: RejectionCategory, message: string): boolean {
  const slot = roster.byId.get(slotId);
  return slot !== undefined &&
    semanticRetryDiagnostic({ category, failedRequest: slot.attempts[0], retryRequest: slot.attempts[1], message }).ok;
}

/** A rejected attempt 1 retries its slot at attempt 2; a rejected attempt 2 is terminal. */
type SlotRejectionOutcome<Result> =
  | Readonly<{ kind: "retry"; slots: NonEmpty<OpenSlot<Result>>; retry: AgentRequestAuthority }>
  | Readonly<{ kind: "terminal"; diagnostic: TerminalBlockedDiagnostic }>;

function rejectSlot<Result>(
  roster: ExactRoster,
  slots: NonEmpty<OpenSlot<Result>>,
  event: SlotRejection,
): PersistentPanelResult<SlotRejectionOutcome<Result>> {
  const located = locateProgress(roster, slots, event.request.requestId);
  if (!located.ok) return located;
  const { expected, index } = located.value;
  if (event.attempt !== expected.attempt) return persistentFailure(refutationError("stale-request", `expected attempt ${expected.attempt}, received ${event.attempt}`, { requestId: event.request.requestId, slotId: expected.slotId }));
  const message = sanitizeProse(event.message);
  if (message.length === 0) return persistentFailure(refutationError("malformed-result", "rejection message must be non-empty after sanitization"));
  if (event.attempt === 1) {
    if (!retryDiagnosticConstructible(roster, expected.slotId, event.category, message)) {
      return persistentFailure(refutationError("invalid-authority", "cannot construct retry diagnostic"));
    }
    return persistentSuccess(Object.freeze({
      kind: "retry" as const,
      slots: replaceSlot(slots, index, Object.freeze({ slotId: expected.slotId, status: "pending" as const, nextAttempt: 2 as const })),
      retry: requireRosterAttempt(roster, expected.slotId, 2),
    }));
  }
  const terminal = terminalBlockedDiagnostic({ category: event.category, failedRequest: expected as AgentRequestAuthority<2>, message });
  if (!terminal.ok) return persistentFailure(refutationError("invalid-authority", terminal.error.message));
  return persistentSuccess(Object.freeze({ kind: "terminal" as const, diagnostic: terminal.value }));
}

/**
 * The ONE rejected-slot transition: the retry-versus-terminal decision, the
 * attempt-2 lookup and the retry spawn live here. The stage supplies only its
 * terminal state, the state that keeps waiting with the retried slot, and the
 * spawn action that carries the retry.
 */
function reduceRejectedSlot<Result, State, Action, Event>(
  roster: ExactRoster,
  slots: NonEmpty<OpenSlot<Result>>,
  event: SlotRejection,
  stage: Readonly<{
    terminal: (diagnostic: TerminalBlockedDiagnostic) => PanelStep<State, Action, Event>;
    waiting: (slots: NonEmpty<OpenSlot<Result>>) => State;
    spawn: (requests: NonEmpty<AgentRequestAuthority>) => Action;
  }>,
): PersistentPanelResult<PanelStep<State, Action, Event>> {
  const rejected = rejectSlot(roster, slots, event);
  if (!rejected.ok) return rejected;
  const outcome = rejected.value;
  if (outcome.kind === "terminal") return persistentSuccess(stage.terminal(outcome.diagnostic));
  return persistentSuccess(Object.freeze({
    state: stage.waiting(outcome.slots),
    action: stage.spawn(Object.freeze([outcome.retry]) as NonEmpty<AgentRequestAuthority>),
  }));
}

// ---------------------------------------------------------------------------
// Request identity and rehydration
// ---------------------------------------------------------------------------

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
    return persistentFailure(refutationError("malformed-event", "panel request identity tag or schemaVersion is invalid"));
  }
  const requestId = parseRequestId(identity.requestId);
  const issuance = safeRecord(identity.issuance, ["schemaVersion", "kind", "runId", "effectId", "publicationDigest", "batchIndex"]);
  if (!requestId.ok || issuance === null || issuance.schemaVersion !== 1 || issuance.kind !== "issued-spawn-request-proof") {
    return persistentFailure(refutationError("malformed-event", requestId.ok ? "panel request issuance identity is invalid" : requestId.error.message));
  }
  const runId = parseOrchestrationRunId(issuance.runId);
  const effectId = parseEffectId(issuance.effectId);
  const publicationDigest = parseArtifactDigest(issuance.publicationDigest);
  const batchIndex = typeof issuance.batchIndex === "number" && Number.isSafeInteger(issuance.batchIndex) && issuance.batchIndex >= 0
    ? issuance.batchIndex
    : null;
  if (!runId.ok || !effectId.ok || !publicationDigest.ok || batchIndex === null) {
    return persistentFailure(refutationError("malformed-event", [
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

function rehydrationFailure(expected: AgentRequestAuthority, error: Readonly<{ kind: "invalid-accepted-agent-result"; field?: string; message: string }>): PersistentPanelResult<never> {
  const cause = Object.freeze({ kind: error.kind, ...(error.field === undefined ? {} : { field: error.field }), message: boundedPanelMessage(error.message) });
  return persistentFailure(refutationError("request-rehydration-failed", `request ${expected.requestId} could not be rehydrated: ${cause.message}`, {
    requestId: expected.requestId, slotId: expected.slotId, rehydration: cause,
  }));
}

type ResolvedPanelRequest = Readonly<{ identity: PanelRequestIdentity; request: IssuedSpawnRequest; expected: AgentRequestAuthority }>;

function resolvePanelRequest(
  roster: ExactRoster,
  identityRaw: unknown,
  resolver: PublicationAuthorityResolver,
): PersistentPanelResult<ResolvedPanelRequest> {
  const identity = parsePanelRequestIdentity(identityRaw);
  if (!identity.ok) return identity;
  const expected = findRosterRequest(roster, identity.value.requestId);
  if (expected === null) return persistentFailure(refutationError("unknown-request", `request ${identity.value.requestId} is not in the canonical roster`, { requestId: identity.value.requestId }));
  const issued = parseIssuedSpawnRequest(resolver, {
    authority: expected,
    context: { digest: expected.contextDigest, slot: `contexts/${expected.contextDigest}.json` },
    issuance: identity.value.issuance,
  });
  if (!issued.ok) return rehydrationFailure(expected, issued.error);
  if (!authorityMatches(issued.value.authority, expected)) {
    return persistentFailure(refutationError("request-binding-mismatch", "rehydrated request does not match the exact canonical panel slot", { requestId: expected.requestId, slotId: expected.slotId }));
  }
  return persistentSuccess(Object.freeze({ identity: identity.value, request: issued.value, expected }));
}

/** A rehydrated request that is also the expected attempt of an open slot of
 *  the active stage — the joint precondition of every submission and of every
 *  durable slot event. */
function resolveOpenRequest<Result>(
  roster: ExactRoster,
  slots: NonEmpty<OpenSlot<Result>>,
  identityRaw: unknown,
  resolver: PublicationAuthorityResolver,
): PersistentPanelResult<Readonly<{ resolved: ResolvedPanelRequest; located: LocatedProgress<Result> }>> {
  const resolved = resolvePanelRequest(roster, identityRaw, resolver);
  if (!resolved.ok) return resolved;
  const located = locateProgress(roster, slots, resolved.value.expected.requestId);
  if (!located.ok) return located;
  return persistentSuccess(Object.freeze({ resolved: resolved.value, located: located.value }));
}

// ---------------------------------------------------------------------------
// Accepted-result projection
// ---------------------------------------------------------------------------

/** Canonical accepted verdict projection, derived only from slot progress. */
export function selectAcceptedRefutationVerdicts(
  state: RefutationPanelState,
): readonly DurableAcceptedPanelResult<VerdictEnvelope<RefutationVerdict>>[] {
  return orderedAccepted(state.authority.verifierRoster, state.slots);
}

// ---------------------------------------------------------------------------
// Result parsing
// ---------------------------------------------------------------------------

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
    // Fail closed to the fixed sentence, but keep the thrown class so a code
    // regression stays distinguishable from malformed input — the reason the
    // kernel's `reducePanelProgram` keeps its thrown message (`review-output`'s
    // `inspectionFailure` keeps the class the same way).
    return { ok: false, error: { message: `refutation result could not be safely parsed (${boundedThrownCause(error, "refutation result").name})` } };
  }
}

// ---------------------------------------------------------------------------
// Durable event parsing
// ---------------------------------------------------------------------------

/** A durable slot rejection: the issued request identity of the open slot's expected attempt, its category and sanitized message. */
function parseRejection<Result>(
  raw: Readonly<Record<string, unknown>>,
  roster: ExactRoster,
  slots: NonEmpty<OpenSlot<Result>>,
  resolver: PublicationAuthorityResolver,
): PersistentPanelResult<SlotRejection> {
  const open = resolveOpenRequest(roster, slots, raw.request, resolver);
  if (!open.ok) return open;
  const { expected, identity } = open.value.resolved;
  const attempt = raw.attempt === 1 || raw.attempt === 2 ? raw.attempt : null;
  const category = raw.category === "malformed-result" || raw.category === "result-binding-mismatch" ? raw.category : null;
  const message = typeof raw.message === "string" ? sanitizeProse(raw.message) : "";
  if (attempt === null || category === null || message.length === 0) {
    return persistentFailure(refutationError("malformed-event", "rejection event requires issued request identity, attempt, category, and non-empty sanitized message"));
  }
  if (attempt !== expected.attempt) {
    return persistentFailure(refutationError("stale-request", `expected attempt ${expected.attempt}, received ${attempt}`, {
      requestId: expected.requestId,
      slotId: expected.slotId,
    }));
  }
  return persistentSuccess(Object.freeze({ request: identity, attempt, category, message }));
}

const REFUTATION_EVENT_FIELDS = ["schemaVersion", "type", "request", "value", "attempt", "category", "message", "decision", "source"] as const;

export function parsePersistentRefutationPanelEvent(
  state: RefutationPanelState,
  raw: unknown,
  resolver: PublicationAuthorityResolver,
): PersistentPanelResult<PersistentRefutationPanelEvent> {
  if (!proven("refutation:state", state)) return persistentFailure(refutationError("malformed-checkpoint", "event parsing requires a parser-produced refutation state"));
  const envelope = safeRecord(raw, REFUTATION_EVENT_FIELDS);
  if (envelope === null || envelope.schemaVersion !== 1 || typeof envelope.type !== "string") return persistentFailure(refutationError("malformed-event", "refutation event must be an exact schemaVersion 1 data record"));
  const event = (parsed: PersistentRefutationPanelEvent): PersistentPanelResult<PersistentRefutationPanelEvent> =>
    persistentSuccess(prove("refutation:event", Object.freeze(parsed)));
  switch (envelope.type) {
    case "refutation-verdict-accepted": {
      // An absent source arm is the historical projection (genuinely
      // pre-feature accepted events were extraction); a present arm must be
      // exact — malformed present-day source fields are NOT historical absence.
      const exact = safeRecord(raw, ["schemaVersion", "type", "request", "value", "source"]);
      if (exact === null || state.stage !== "awaiting-verdicts") return persistentFailure(refutationError("unexpected-event", `verdict is not accepted during ${state.stage}`));
      const open = resolveOpenRequest(state.authority.verifierRoster, state.slots, exact.request, resolver);
      if (!open.ok) return open;
      const { expected, identity } = open.value.resolved;
      const lens = boundRefutationLens(state.authority, expected.slotId);
      if (!lens.ok) return lens;
      const value = parseCanonicalRefutation(exact.value, state.authority, lens.value);
      if (!value.ok) return persistentFailure(refutationError("request-binding-mismatch", value.error.message, { requestId: expected.requestId, slotId: expected.slotId }));
      const source = projectPanelVerdictSourceArm(exact.source);
      if (!source.ok) return persistentFailure(refutationError("malformed-event", source.error));
      return event({ schemaVersion: 1, type: "refutation-verdict-accepted", request: identity, value: value.value, source: source.value });
    }
    case "refutation-verdict-rejected": {
      const exact = safeRecord(raw, ["schemaVersion", "type", "request", "attempt", "category", "message"]);
      if (exact === null) return persistentFailure(refutationError("malformed-event", "refutation rejection event contains unknown or missing fields"));
      if (state.stage !== "awaiting-verdicts") return persistentFailure(refutationError("unexpected-event", `verdict rejection is not accepted during ${state.stage}`));
      const rejection = parseRejection(exact, state.authority.verifierRoster, state.slots, resolver);
      if (!rejection.ok) return rejection;
      return event({ schemaVersion: 1, type: "refutation-verdict-rejected", ...rejection.value });
    }
    case "refutation-tally-completed": {
      const exact = safeRecord(raw, ["schemaVersion", "type", "decision"]);
      if (exact === null || state.stage !== "ready-to-tally") return persistentFailure(refutationError("unexpected-event", `tally is not available during ${state.stage}`));
      const proof = proveRefutationRoster(state, resolver);
      if (!proof.ok) return proof;
      // The decision is re-derived, never read: a persisted bar other than the
      // roster's strict majority is just one more way to disagree with it.
      const decision = tallyRefutationPanel(state.authority, proof.value);
      if (!decision.ok) return decision;
      if (!jsonEqual(exact.decision, decision.value)) return persistentFailure(refutationError("invalid-aggregate", "persisted decision does not equal the deterministic complete-roster tally"));
      return event({ schemaVersion: 1, type: "refutation-tally-completed", decision: decision.value });
    }
    default:
      return persistentFailure(refutationError("malformed-event", `unknown refutation event type: ${envelope.type}`));
  }
}

// ---------------------------------------------------------------------------
// The reducer: the panel's stage topology over the slot-progress kernel
// ---------------------------------------------------------------------------

// The reducer guard (proved, non-terminal state; strictly parsed event; the
// catch that keeps `requireRosterEntry`/`requireRosterAttempt`'s invariant
// message) is the program kernel's `reducePanelProgram`; the transitions below
// run only behind it.

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

/** A step that entered `next`: its action is the new state's own. */
const refutationStep = (next: RefutationPanelState): PersistentRefutationStep => Object.freeze({ state: next, action: refutationAction(next) });
/** A step that stays in its stage still waiting on other slots: nothing new to spawn. */
const waitingStep = <State>(next: State) => Object.freeze({ state: next, action: null });

export function startPersistentRefutationPanel(authority: RefutationPanelAuthority): PersistentRefutationStep {
  return refutationStep(refutationState(Object.freeze({
    panel: "refutation" as const, authority, stage: "awaiting-verdicts" as const,
    slots: initialSlots<VerdictEnvelope<RefutationVerdict>>(authority.verifierRoster),
  })));
}

type RefutationEventOf<T extends PersistentRefutationPanelEvent["type"]> = Extract<PersistentRefutationPanelEvent, Readonly<{ type: T }>>;

function reduceRefutationTransition(state: RefutationPanelState, event: PersistentRefutationPanelEvent): PersistentPanelResult<PersistentRefutationStep> {
  switch (event.type) {
    case "refutation-verdict-accepted": return reduceRefutationVerdictAccepted(state, event);
    case "refutation-verdict-rejected": return reduceRefutationVerdictRejected(state, event);
    case "refutation-tally-completed": {
      if (state.stage !== "ready-to-tally") return persistentFailure(refutationError("unexpected-event", `tally is not available during ${state.stage}`));
      return persistentSuccess(refutationStep(refutationState(Object.freeze({ ...state, stage: "done" as const, decision: event.decision }))));
    }
  }
}

function reduceRefutationVerdictAccepted(state: RefutationPanelState, event: RefutationEventOf<"refutation-verdict-accepted">): PersistentPanelResult<PersistentRefutationStep> {
  if (state.stage !== "awaiting-verdicts") return persistentFailure(refutationError("unexpected-event", `verdict is not accepted during ${state.stage}`));
  const accepted = acceptSlot(state.authority.verifierRoster, state.slots, event.request, event.value);
  if (!accepted.ok) return accepted;
  return persistentSuccess(accepted.value.kind === "complete"
    ? refutationStep(refutationState(Object.freeze({ panel: "refutation" as const, authority: state.authority, stage: "ready-to-tally" as const, slots: accepted.value.slots })))
    : waitingStep(refutationState(Object.freeze({ ...state, slots: accepted.value.slots }))));
}

function reduceRefutationVerdictRejected(state: RefutationPanelState, event: RefutationEventOf<"refutation-verdict-rejected">): PersistentPanelResult<PersistentRefutationStep> {
  if (state.stage !== "awaiting-verdicts") return persistentFailure(refutationError("unexpected-event", `verdict rejection is not accepted during ${state.stage}`));
  return reduceRejectedSlot(state.authority.verifierRoster, state.slots, event, {
    terminal: (diagnostic) => refutationStep(refutationState(Object.freeze({
      panel: "refutation" as const,
      authority: state.authority,
      stage: "terminal-blocked" as const,
      slots: state.slots,
      diagnostic,
    }))),
    waiting: (slots) => refutationState(Object.freeze({ ...state, slots })),
    spawn: (requests) => Object.freeze({ kind: "spawn-refutation-verifiers" as const, runId: state.authority.runId, requests }),
  });
}

// ---------------------------------------------------------------------------
// The program over the persistent program kernel
// ---------------------------------------------------------------------------

/** The fields of a panel authority whose value is (or may be) an issued roster. */
export type PanelAuthorityRosterField<Authority> = {
  [Field in keyof Authority]-?: [Extract<Authority[Field], ExactRoster>] extends [never] ? never : Field;
}[keyof Authority];

/**
 * Exactly the roster fields of `Authority`, each named once. The set is
 * derived from the authority type, so a roster field added to an authority
 * without being named here, or a non-roster field named here, fails to
 * compile — the comparison can never silently fall back to a roster's
 * serialization. An authority with no roster field has no set at all (`never`,
 * not the empty record, which would accept any field).
 */
export type PanelAuthorityRosterFields<Authority> = [PanelAuthorityRosterField<Authority>] extends [never]
  ? never
  : Readonly<Record<PanelAuthorityRosterField<Authority>, true>>;

/** The default `Authority` of `canonicalPanelStateJson`, and its parameter type
 *  while that default stands: the `never`-valued property admits no value, and
 *  its name is the diagnostic a caller who omitted the type argument reads. */
type AuthorityTypeArgumentRequired = Readonly<{
  "canonicalPanelStateJson requires an explicit Authority type argument": never;
}>;

/**
 * The canonical form of one panel's state (live, or JSON read back from a
 * checkpoint): the issued rosters of its authority — the only place the
 * panel's state carries a derived view — each taken to the roster's own
 * canonical form (`canonicalExactRosterJson`), and every other field, key
 * order included, untouched. Positional, never by key name: a `byId` anywhere
 * else in the state stays part of the comparison.
 *
 * Callers must pass the authority type explicitly, e.g.
 * `canonicalPanelStateJson<RefutationPanelAuthority>({ verifierRoster: true })`.
 * The roster-field set is checked against that type, so the type cannot be
 * inferred from the set. Without it, the parameter becomes
 * `AuthorityTypeArgumentRequired`, which no value satisfies and whose one
 * property names the omission in the compiler error.
 */
export const canonicalPanelStateJson = <Authority = AuthorityTypeArgumentRequired>(
  rosterFields: [Authority] extends [AuthorityTypeArgumentRequired]
    ? AuthorityTypeArgumentRequired
    : PanelAuthorityRosterFields<NoInfer<Authority>>,
) => (state: unknown): unknown => {
  if (!isRecord(state) || !isRecord(state.authority)) return state;
  const authority = Object.fromEntries(Object.entries(state.authority).map(([field, value]) =>
    [field, Object.hasOwn(rosterFields, field) ? canonicalExactRosterJson(value) : value] as const));
  return { ...state, authority };
};

const REFUTATION_PROGRAM: PanelProgramDefinition<RefutationPanelAuthority, RefutationPanelAuthorityInput, RefutationPanelState, RefutationPanelAction, PersistentRefutationPanelEvent> = {
  panel: "refutation",
  proofs,
  start: startPersistentRefutationPanel,
  action: refutationAction,
  parseEvent: parsePersistentRefutationPanelEvent,
  transition: reduceRefutationTransition,
  parseAuthority: parseRefutationPanelAuthority,
  authorityJson: (authority) => Object.freeze({
    runId: authority.runId,
    identityRunId: authority.identityRunId,
    findings: authority.findings,
    lenses: authority.lenses,
    verifierSlots: authority.verifierRoster.orderedSlots,
  }),
  canonicalStateJson: canonicalPanelStateJson<RefutationPanelAuthority>({ verifierRoster: true }),
};

export function reducePersistentRefutationPanel(state: RefutationPanelState, event: PersistentRefutationPanelEvent): PersistentPanelResult<PersistentRefutationStep> {
  return reducePanelProgram(REFUTATION_PROGRAM, state, event);
}

// ---------------------------------------------------------------------------
// Resume
// ---------------------------------------------------------------------------

export function resumePersistentRefutationPanel(state: RefutationPanelState): PersistentPanelResult<PersistentRefutationStep> {
  return resumePanelProgram(REFUTATION_PROGRAM, state);
}

// ---------------------------------------------------------------------------
// Submissions
// ---------------------------------------------------------------------------

/**
 * The issuance join between an emission selection input and the submitted
 * request: the binding must certify THIS slot's request. A binding for another
 * request is a caller defect, not an attempt observation — a typed failure
 * before any selection, never a rejection event consuming the attempt.
 */
function panelVerdictEmissionIssuanceProblem(
  emission: PanelVerdictEmissionSelectionOf<"refutation-verdict"> | undefined,
  expectedRequestId: RequestId,
): PersistentPanelError | null {
  if (emission === undefined || emission.binding.requestId === expectedRequestId) return null;
  return refutationError("invalid-authority",
    `issued emission binding certifies request ${emission.binding.requestId}, not the submitted request ${expectedRequestId}`);
}

/** The durable rejection event of one slot attempt, its category derived from the submission's error kind. */
function rejectionEvent(
  request: PanelRequestIdentity,
  expected: AgentRequestAuthority,
  error: PersistentPanelError,
): Readonly<{ type: "refutation-verdict-rejected"; schemaVersion: 1 } & SlotRejection> {
  const category: RejectionCategory = error.kind === "request-binding-mismatch"
    ? "result-binding-mismatch"
    : "malformed-result";
  return Object.freeze({ type: "refutation-verdict-rejected" as const, schemaVersion: 1 as const, request, attempt: expected.attempt, category, message: error.message });
}

/** The parsed JSON value of `text`, or `null` when it is not JSON. */
function parseJsonText(text: string): Readonly<{ value: unknown }> | null {
  try {
    return Object.freeze({ value: JSON.parse(text) as unknown });
  } catch {
    return null;
  }
}

/** Does a raw verdict claim a lens or Finding the canonical slot does not own? */
function verdictClaimsForeignAuthority(
  rawJson: unknown,
  expectedLens: string,
  expectedFindingIds: readonly string[],
): boolean {
  if (typeof rawJson !== "string") return false;
  // Only the JSON parse is guarded: invalid JSON is ordinary malformed input
  // and claims no foreign authority. Everything after it reads through the
  // non-throwing `safeRecord`/`safeArray` snapshots, so a throw there is a code
  // regression and must surface, not silently downgrade the classification.
  const parsedJson = parseJsonText(rawJson);
  if (parsedJson === null) return false;
  const root = safeRecord(parsedJson.value, ["criterion", "verdicts"]);
  if (root === null) return false;
  if (typeof root.criterion === "string" && root.criterion !== expectedLens) return true;
  const entries = safeArray(root.verdicts);
  if (entries === null) return false;
  return entries.some((rawEntry) => {
    const entry = safeRecord(rawEntry, ["finding_id", "verdict", "reasoning"]);
    const claimedFinding = entry?.finding_id;
    return typeof claimedFinding === "string" && !expectedFindingIds.includes(claimedFinding);
  });
}

export function submitRefutationVerdict(
  state: RefutationPanelState,
  resolver: PublicationAuthorityResolver,
  requestIdentity: unknown,
  rawJson: unknown,
  emission?: PanelVerdictEmissionSelectionOf<"refutation-verdict">,
): PersistentPanelResult<PersistentRefutationStep> {
  if (state.stage !== "awaiting-verdicts") return persistentFailure(refutationError("unexpected-event", `verdict cannot be submitted during ${state.stage}`));
  const open = resolveOpenRequest(state.authority.verifierRoster, state.slots, requestIdentity, resolver);
  if (!open.ok) return open;
  const { identity, expected } = open.value.resolved;
  const boundLens = boundRefutationLens(state.authority, expected.slotId);
  if (!boundLens.ok) return boundLens;
  const lens = boundLens.value;
  const findingIds = state.authority.findings.map(({ id }) => id);
  // AD-8: the verdict-source selection runs BEFORE the authoritative parse —
  // `foldVerdictSubmission` selects which bytes reach `parseRefutationVerdict`,
  // and the parse keeps its lens binding and complete finding coverage
  // (FR-012; the source can never override issuance). Without an emission
  // input the fold is this seam's pre-selection behavior exactly.
  const issuanceProblem = panelVerdictEmissionIssuanceProblem(emission, expected.requestId);
  if (issuanceProblem !== null) return persistentFailure(issuanceProblem);
  const fold = foldVerdictSubmission({
    label: "refutation verdict",
    expectedRequestId: expected.requestId,
    emission,
    rawJson,
    parse: (target): ParseResult<VerdictEnvelope<RefutationVerdict>> => typeof target === "string"
      ? parseRefutationVerdict(target, lens, findingIds)
      : fail(["refutation result must be raw JSON text"]),
    classifyRaw: (target) => verdictClaimsForeignAuthority(target, lens, findingIds)
      ? "request-binding-mismatch"
      : "malformed-result",
    foreignAuthorityMessage: "refutation criterion or Finding claims do not match the canonical request slot",
  });
  if (fold.kind === "rejected") {
    return reduceParsedPanelEvent(REFUTATION_PROGRAM, state, rejectionEvent(identity, expected, refutationError(fold.errorKind, fold.message)), resolver);
  }
  return reduceParsedPanelEvent(REFUTATION_PROGRAM, state, Object.freeze({ schemaVersion: 1, type: "refutation-verdict-accepted", request: identity, value: fold.value, source: fold.source }), resolver);
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
  if (state.stage !== "awaiting-verdicts") return persistentFailure(refutationError("unexpected-event", `a capture rejection cannot be recorded during ${state.stage}`));
  const open = resolveOpenRequest(state.authority.verifierRoster, state.slots, requestIdentity, resolver);
  if (!open.ok) return open;
  return reduceParsedPanelEvent(REFUTATION_PROGRAM, state, rejectionEvent(open.value.resolved.identity, open.value.located.expected, refutationError("malformed-result", diagnostic)), resolver);
}

// ---------------------------------------------------------------------------
// Complete-roster proof and the deterministic tally
// ---------------------------------------------------------------------------

function rehydrateAccepted<T>(roster: ExactRoster, accepted: readonly DurableAcceptedPanelResult<T>[], resolver: PublicationAuthorityResolver): PersistentPanelResult<readonly AcceptedAgentResult<T>[]> {
  const results: AcceptedAgentResult<T>[] = [];
  for (const durable of accepted) {
    const resolved = resolvePanelRequest(roster, durable.request, resolver);
    if (!resolved.ok) return resolved;
    const acceptedResult = acceptedAgentResult(resolved.value.request, durable.value);
    if (!acceptedResult.ok) return rehydrationFailure(resolved.value.expected, acceptedResult.error);
    results.push(acceptedResult.value);
  }
  return persistentSuccess(Object.freeze(results));
}

/**
 * Prove the verifier roster complete: every accepted verdict rehydrates
 * against its issued publication, the roster is exact and complete, and each
 * value re-parses under an authoritative lens. The proof is bound to the
 * exact panel authority, so only the tally of THIS panel accepts it.
 */
function proveRefutationRoster(state: RefutationPanelState, resolver: PublicationAuthorityResolver): PersistentPanelResult<CompleteRoster<AcceptedAgentResult<VerdictEnvelope<RefutationVerdict>>>> {
  const { authority } = state;
  const rehydrated = rehydrateAccepted(authority.verifierRoster, selectAcceptedRefutationVerdicts(state), resolver);
  if (!rehydrated.ok) return rehydrated;
  const proven = parseCompleteRoster(resolver, authority.verifierRoster, rehydrated.value, (raw) => {
    const record = safeRecord(raw, ["criterion", "entries"]);
    const expected = record === null ? undefined : authority.lenses.find((lens) => lens === record.criterion);
    return expected === undefined
      ? { ok: false, error: { message: "refutation lens is not authoritative" } }
      : parseCanonicalRefutation(raw, authority, expected);
  });
  if (!proven.ok) return persistentFailure(refutationError("incomplete-roster", proven.error.violations.map(({ kind }) => kind).join("; ")));
  completeRosterProofs.set(proven.value, authority);
  return persistentSuccess(proven.value);
}

function completeRosterMatches(roster: ExactRoster, complete: CompleteRoster<AcceptedAgentResult<unknown>>): boolean {
  return complete.ordered.length === roster.orderedSlots.length && roster.orderedSlots.every((slot, index) => {
    const result = complete.ordered[index];
    return result !== undefined && result.authority.slotId === slot.slotId && authorityMatches(result.authority, result.authority.attempt === 1 ? slot.attempts[0] : slot.attempts[1]);
  });
}

/** The panel's decision under the one bar its roster admits, the strict majority (ADR-0029). */
function tallyRefutationPanel(authority: RefutationPanelAuthority, complete: CompleteRoster<AcceptedAgentResult<VerdictEnvelope<RefutationVerdict>>>): PersistentPanelResult<RefutationDecision> {
  try {
    if (completeRosterProofs.get(complete) !== authority || !completeRosterMatches(authority.verifierRoster, complete as CompleteRoster<AcceptedAgentResult<unknown>>)) return persistentFailure(refutationError("incomplete-roster", "complete verifier roster is unproved, stale, or belongs to another panel"));
    const strictMajority = defaultRefutationThreshold(authority.lenses.length);
    const verdicts = complete.ordered.map(({ value }) => value);
    const tallied = tallyRefutations(verdicts, authority.lenses, authority.findings, strictMajority);
    if (!tallied.ok) return persistentFailure(refutationError("invalid-aggregate", tallied.errors.join("; ")));
    const outcomes = Object.freeze([...tallied.value]);
    return persistentSuccess(Object.freeze({ threshold: strictMajority, lenses: authority.lenses, verdicts: Object.freeze(verdicts), outcomes, retained: Object.freeze(outcomes.filter(({ survives }) => survives)), refuted: Object.freeze(outcomes.filter(({ survives }) => !survives)) }));
  } catch (error) {
    // The message is KEPT, for the reason the kernel's `reducePanelProgram`
    // documents: a bare `catch {}` makes a code regression indistinguishable
    // from bad input. Fail-closed is unchanged; only the diagnostic survives.
    return persistentFailure(refutationError("invalid-aggregate", `verifier roster could not be safely tallied: ${error instanceof Error ? error.message : String(error)}`));
  }
}

export function completePersistentRefutationPanel(state: RefutationPanelState, resolver: PublicationAuthorityResolver): PersistentPanelResult<PersistentRefutationStep> {
  const proof = proveRefutationRoster(state, resolver);
  if (!proof.ok) return proof;
  const decision = tallyRefutationPanel(state.authority, proof.value);
  if (!decision.ok) return decision;
  return reduceParsedPanelEvent(REFUTATION_PROGRAM, state, Object.freeze({ schemaVersion: 1, type: "refutation-tally-completed", decision: decision.value }), resolver);
}

// ---------------------------------------------------------------------------
// Replay and checkpoints
// ---------------------------------------------------------------------------

export function replayPersistentRefutationPanel(authority: RefutationPanelAuthority, rawEvents: unknown, resolver: PublicationAuthorityResolver): PersistentPanelResult<PersistentRefutationStep> {
  return replayPanelProgram(REFUTATION_PROGRAM, authority, rawEvents, resolver);
}

export type RefutationPanelCheckpoint = PanelCheckpoint<RefutationPanelAuthorityInput, PersistentRefutationPanelEvent>;

export function refutationPanelCheckpoint(
  state: RefutationPanelState,
  events: readonly PersistentRefutationPanelEvent[],
  resolver: PublicationAuthorityResolver,
): PersistentPanelResult<RefutationPanelCheckpoint> {
  return panelProgramCheckpoint(REFUTATION_PROGRAM, state, events, resolver);
}

export function parseRefutationPanelCheckpoint(raw: unknown, resolver: PublicationAuthorityResolver): PersistentPanelResult<PersistentRefutationStep> {
  return parsePanelProgramCheckpoint(REFUTATION_PROGRAM, raw, resolver);
}
