/**
 * Refutation Panel verifier authority, decided (functional core: no I/O).
 *
 * One verifier slot per lens, both attempts' Context Packets and requests,
 * and the panel authority over them, shared by the standalone and Wave
 * programs. It is the one place a verifier request is issued or read back.
 *
 * ADR-0023: a request is checked against today's catalog ONCE, where it is
 * minted. A panel whose verifier requests are already on record — the panel a
 * program checkpointed, or its attempt-1 batch receipt — is history, so its
 * requests are read from that record; only a panel with no record is minted.
 * Re-minting a recorded panel would compare today's binding with the recorded
 * one and refuse every run issued before the catalog changed.
 *
 * The record arrives already read, as the closed {@link RefutationPanelRecord};
 * the shell (`handlers/helpers/programs/refutation-verifiers.ts`) reads it.
 */
import {
  mintAgentRosterSlot,
  mintAgentRosterSlotAsOf,
  parseAgentRosterSlot,
  parseStoredAgentRequestAuthorityForAttempt,
  rosterSlotErrorMessages,
  sameAgentRequestAuthority,
  type AgentRequestAuthority,
  type AgentRequestIdentity,
  type AgentRosterSlot,
  type AgentRosterSlotError,
  type DomainResult,
  type InitialSpawnRequestInput,
  type NonEmpty,
  type OrchestrationRunId,
  type RequestId,
  type SemanticAttempt,
  type SlotId,
} from "./orchestration-contract";
import type { ContextPacket } from "./context-packets";
import type { LoomAgentName, PiCatalog } from "./model-profiles";
import type { BriefFinding, ReviewLens } from "./review-panel";
import {
  deriveRefutationVerifierBinding,
  issueRefutationPanelAuthority,
  parseRefutationPanelAuthority,
  type RefutationPanelAuthority,
  type RefutationVerifierBinding,
} from "./panel-authority";

const VERIFIER_ROLE = "review-verifier-agent" satisfies LoomAgentName;

/**
 * What a panel's verifier requests are already on record as, read before the
 * decision: nothing, the requests its attempt-1 batch receipt published, or
 * the whole panel a program checkpointed (the earliest record of issuance).
 */
export type RefutationPanelRecord =
  | Readonly<{ kind: "none" }>
  | Readonly<{ kind: "receipt-requests"; requests: readonly AgentRequestAuthority[] }>
  | Readonly<{ kind: "checkpointed-panel"; panel: RefutationPanelAuthority }>;

/** The panel a preparation is for: its run, semantic identity, Findings, lenses and Context Packets. */
export type RefutationVerifierPlan = Readonly<{
  runId: OrchestrationRunId;
  /** Semantic panel identity the verifier slots derive from; the run itself when omitted. */
  identityRunId?: OrchestrationRunId;
  findings: NonEmpty<BriefFinding>;
  lenses: NonEmpty<ReviewLens>;
  /** The program's Context Packet for one verifier attempt, or why it cannot be built. */
  packet: (lens: ReviewLens, requestId: RequestId, attempt: SemanticAttempt) => DomainResult<ContextPacket, Readonly<{ message: string }>>;
  /**
   * The catalog a panel with no record is minted under: `CURRENT_PI_CATALOG`
   * in production; a replay of a run written before a catalog retargeting
   * names the catalog as it stood (`piCatalogAsOf`). Required, so no issuing
   * path can mint under today's catalog by omission during a replay.
   */
  catalog: PiCatalog;
}>;

/** Why a panel's verifier requests could not be prepared. */
export type RefutationVerifierRefusal = Readonly<{
  kind:
    | "underivable-slot"
    | "unbuildable-packet"
    | "unmintable-slot"
    | "record-lacks-request"
    | "invalid-recorded-request"
    | "record-differs"
    | "invalid-recorded-slot"
    | "invalid-panel";
  message: string;
}>;

/** One verifier request ready to publish: its authority (typed, never re-parsed) and its packet. */
export type PreparedVerifierRequest = Readonly<{
  input: InitialSpawnRequestInput & Readonly<{ authority: AgentRequestAuthority }>;
  packet: ContextPacket;
}>;

/**
 * A prepared panel. `refutationAuthority` is the panel every consumer runs
 * and freezes, whether it was minted now or read back from its record: no
 * consumer branches on which, and a recovered panel is frozen exactly as an
 * issued one is (the standalone evidence replay freezes a receipt-recorded
 * panel), so the provenance is not part of the result — nor of
 * `RefutationPanelAuthority`. The minted proof is enforced at the issuing seam
 * (`issueRefutationPanelAuthority`): its input must be minted slots, and each
 * is re-checked against today's catalog at run time.
 */
export type RefutationVerifierPreparation = Readonly<{
  refutationAuthority: RefutationPanelAuthority;
  /** Attempt-1 requests and their packets, index-aligned, in lens order. */
  inputs: readonly PreparedVerifierRequest["input"][];
  packets: readonly ContextPacket[];
  /** Each slot's attempt-2 request, published only when the panel asks for that retry. */
  retryInputs: readonly PreparedVerifierRequest[];
}>;

type Result<T> = DomainResult<T, RefutationVerifierRefusal>;

const ok = <T>(value: T): Result<T> => Object.freeze({ ok: true, value });
const refused = <T = never>(kind: RefutationVerifierRefusal["kind"], message: string): Result<T> =>
  Object.freeze({ ok: false, error: Object.freeze({ kind, message }) });

/** Every result's value in order, or the first refusal. */
function all<T>(results: readonly Result<T>[]): Result<readonly T[]> {
  const values: T[] = [];
  for (const result of results) {
    if (!result.ok) return result;
    values.push(result.value);
  }
  return ok(Object.freeze(values));
}

type DraftAttempt<Attempt extends SemanticAttempt> = Readonly<{ identity: AgentRequestIdentity<Attempt>; packet: ContextPacket }>;
type DraftSlot = Readonly<{ slotId: SlotId; attempts: readonly [DraftAttempt<1>, DraftAttempt<2>] }>;

/** A verifier slot beside the draft it was issued or read for, so its packets are never looked up by index. */
type PairedSlot<Slot extends AgentRosterSlot = AgentRosterSlot> = Readonly<{ draft: DraftSlot; slot: Slot }>;

/** Each lens's verifier slot identity, in lens order. */
function verifierBindings(plan: RefutationVerifierPlan): Result<readonly LensBinding[]> {
  const identityRunId = plan.identityRunId ?? plan.runId;
  const findingIds = [plan.findings[0].id, ...plan.findings.slice(1).map(({ id }) => id)] as const;
  return all(plan.lenses.map((lens): Result<LensBinding> => {
    const binding = deriveRefutationVerifierBinding(identityRunId, lens, findingIds);
    return binding.ok ? ok(Object.freeze({ lens, binding: binding.value })) : refused("underivable-slot", binding.errors.join("; "));
  }));
}

/** One lens and the verifier slot identity it derives. */
type LensBinding = Readonly<{ lens: ReviewLens; binding: RefutationVerifierBinding }>;

/**
 * The attempt-1 request ids of the panel's verifier slots, in lens order: the
 * identity its attempt-1 batch receipt is published under, so the shell can
 * read that record before the decision.
 */
export function refutationVerifierRequestIds(plan: RefutationVerifierPlan): Result<readonly RequestId[]> {
  const bindings = verifierBindings(plan);
  return bindings.ok ? ok(Object.freeze(bindings.value.map(({ binding }) => binding.requestIds[0]))) : bindings;
}

/** The deterministic identities and packets of one lens's verifier slot. */
function draftSlot(plan: RefutationVerifierPlan, { lens, binding }: LensBinding): Result<DraftSlot> {
  const { slotId, requestIds: [firstRequestId, retryRequestId] } = binding;
  const draft = <Attempt extends SemanticAttempt>(attempt: Attempt, requestId: RequestId): Result<DraftAttempt<Attempt>> => {
    const packet = plan.packet(lens, requestId, attempt);
    if (!packet.ok) return refused("unbuildable-packet", packet.error.message);
    return ok(Object.freeze({
      packet: packet.value,
      identity: Object.freeze({
        runId: plan.runId,
        requestId,
        slotId,
        program: "refutation-panel" as const,
        role: VERIFIER_ROLE,
        attempt,
        contextDigest: packet.value.digest,
        outputSlot: `transcripts/${slotId}/attempt-${attempt}.raw`,
      }),
    }));
  };
  const first = draft(1, firstRequestId);
  if (!first.ok) return first;
  const retry = draft(2, retryRequestId);
  if (!retry.ok) return retry;
  return ok(Object.freeze({ slotId, attempts: Object.freeze([first.value, retry.value] as const) }));
}

/**
 * Mint each draft's slot with `mint` — today's catalog (`mintAgentRosterSlot`)
 * or a replayed one (`mintAgentRosterSlotAsOf`) — or name every reason the
 * catalog refused it.
 */
const mintedVerifierSlot = <Slot extends AgentRosterSlot>(
  mint: (first: AgentRequestIdentity<1>, retry: AgentRequestIdentity<2>) => DomainResult<Slot, AgentRosterSlotError>,
) =>
  (draft: DraftSlot): Result<PairedSlot<Slot>> => {
    const slot = mint(draft.attempts[0].identity, draft.attempts[1].identity);
    return slot.ok
      ? ok(Object.freeze({ draft, slot: slot.value }))
      : refused("unmintable-slot", `verifier slot ${draft.slotId} cannot be minted: ${rosterSlotErrorMessages(slot.error).join("; ")}`);
  };

/**
 * The recorded request for `draft`'s identity: the recorded profile, bindings
 * and Skill of `recorded`, which must be this exact request when it records
 * this attempt, or the slot's attempt 1 when the record holds only that — a
 * slot's two attempts share one profile, binding and Skill, so the retry is
 * read from the same issuance.
 */
function recordedAttempt<Attempt extends SemanticAttempt>(
  draft: DraftAttempt<Attempt>,
  recorded: AgentRequestAuthority,
): Result<AgentRequestAuthority<Attempt>> {
  const parsed = parseStoredAgentRequestAuthorityForAttempt({
    ...draft.identity,
    modelProfile: recorded.modelProfile,
    harnessBinding: recorded.harnessBinding,
    requiredSkill: recorded.requiredSkill,
  }, draft.identity.attempt);
  if (!parsed.ok) return refused("invalid-recorded-request", parsed.error.violations.map(({ message }) => message).join("; "));
  if (recorded.attempt === draft.identity.attempt && !sameAgentRequestAuthority(parsed.value, recorded)) {
    return refused("record-differs", `recorded verifier request ${recorded.requestId} differs from the panel's deterministic request`);
  }
  return ok(parsed.value);
}

function recordedVerifierSlot(draft: DraftSlot, recorded: ReadonlyMap<string, AgentRequestAuthority>): Result<PairedSlot> {
  const [firstDraft, retryDraft] = draft.attempts;
  const recordedFirst = recorded.get(firstDraft.identity.requestId);
  if (recordedFirst === undefined) {
    return refused("record-lacks-request", `refutation panel record lacks verifier request ${firstDraft.identity.requestId}`);
  }
  const first = recordedAttempt(firstDraft, recordedFirst);
  if (!first.ok) return first;
  const retry = recordedAttempt(retryDraft, recorded.get(retryDraft.identity.requestId) ?? recordedFirst);
  if (!retry.ok) return retry;
  const slot = parseAgentRosterSlot(first.value, retry.value);
  return slot.ok
    ? ok(Object.freeze({ draft, slot: slot.value }))
    : refused("invalid-recorded-slot", `verifier slot ${draft.slotId} is invalid: ${rosterSlotErrorMessages(slot.error).join("; ")}`);
}

/** The recorded verifier requests keyed by request id; `null` when the panel has no record. */
function recordedRequests(record: RefutationPanelRecord): ReadonlyMap<string, AgentRequestAuthority> | null {
  switch (record.kind) {
    case "none":
      return null;
    case "receipt-requests":
      return new Map(record.requests.map((authority) => [authority.requestId, authority] as const));
    case "checkpointed-panel":
      return new Map(record.panel.verifierRoster.orderedSlots.flatMap(({ attempts }) =>
        attempts.map((authority) => [authority.requestId, authority] as const)));
  }
}

function preparedRequest(authority: AgentRequestAuthority, packet: ContextPacket): PreparedVerifierRequest {
  return Object.freeze({
    input: Object.freeze({
      authority,
      context: Object.freeze({
        digest: packet.digest,
        slot: Object.freeze({ kind: "fixed-artifact-slot" as const, path: `contexts/${packet.digest}.json` }),
      }),
    }),
    packet,
  });
}

function preparation(refutationAuthority: RefutationPanelAuthority, paired: readonly PairedSlot[]): RefutationVerifierPreparation {
  const first = paired.map(({ draft, slot }) => preparedRequest(slot.attempts[0], draft.attempts[0].packet));
  return Object.freeze({
    refutationAuthority,
    inputs: Object.freeze(first.map(({ input }) => input)),
    packets: Object.freeze(first.map(({ packet }) => packet)),
    retryInputs: Object.freeze(paired.map(({ draft, slot }) => preparedRequest(slot.attempts[1], draft.attempts[1].packet))),
  });
}

/**
 * Decide a refutation panel's verifier requests from its already-read
 * `record`: read back as history when one exists, minted under the plan's
 * catalog — today's, unless a replay names the catalog as it stood — when
 * none does. A record that does not match the panel's deterministic
 * requests is refused, naming the request.
 */
export function decideRefutationVerifiers(
  plan: RefutationVerifierPlan,
  record: RefutationPanelRecord,
): Result<RefutationVerifierPreparation> {
  const bindings = verifierBindings(plan);
  if (!bindings.ok) return bindings;
  const drafts = all(bindings.value.map((lensBinding) => draftSlot(plan, lensBinding)));
  if (!drafts.ok) return drafts;
  const panelInput = { runId: plan.runId, identityRunId: plan.identityRunId ?? plan.runId, findings: plan.findings, lenses: plan.lenses };
  // A recorded or replayed panel is history, so it is parsed as recorded; only today's mint is issued.
  const parsedPanel = (verifierSlots: readonly AgentRosterSlot[]) => parseRefutationPanelAuthority({ ...panelInput, verifierSlots });

  const recorded = recordedRequests(record);
  if (recorded !== null) return panelPreparation(drafts.value, (draft) => recordedVerifierSlot(draft, recorded), parsedPanel);
  const { catalog } = plan;
  return catalog.kind === "recorded-as-of"
    ? panelPreparation(drafts.value, mintedVerifierSlot((first, retry) => mintAgentRosterSlotAsOf(catalog.lowering, first, retry)), parsedPanel)
    : panelPreparation(drafts.value, mintedVerifierSlot(mintAgentRosterSlot),
        (verifierSlots) => issueRefutationPanelAuthority({ ...panelInput, verifierSlots }));
}

/**
 * The one tail every origin of a panel shares: each draft's slot as `slotFor`
 * obtains it, the panel authority `panel` assembles over those slots, and the
 * preparation pairing each slot with its packets; a panel that does not
 * assemble is `invalid-panel`.
 */
function panelPreparation<Slot extends AgentRosterSlot>(
  drafts: readonly DraftSlot[],
  slotFor: (draft: DraftSlot) => Result<PairedSlot<Slot>>,
  panel: (verifierSlots: readonly Slot[]) => DomainResult<RefutationPanelAuthority, Readonly<{ message: string }>>,
): Result<RefutationVerifierPreparation> {
  const paired = all(drafts.map(slotFor));
  if (!paired.ok) return paired;
  const authority = panel(paired.value.map(({ slot }) => slot));
  return authority.ok ? ok(preparation(authority.value, paired.value)) : refused("invalid-panel", authority.error.message);
}
