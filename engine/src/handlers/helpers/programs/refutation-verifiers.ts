/**
 * Refutation Panel verifier authority shared by the standalone and Wave Gate
 * programs: one verifier slot per lens, both attempts' Context Packets and
 * requests, and the panel authority over them. It is the one place a
 * verifier request is issued or read back.
 *
 * ADR-0023: a request is checked against today's catalog ONCE, where it is
 * minted. A panel whose verifier requests are already on record — its
 * attempt-1 batch receipt, or the panel a program checkpointed — is history,
 * so its requests are read from that record; only a panel with no record is
 * minted. Re-minting a recorded panel would compare today's binding with the
 * recorded one and refuse every run issued before the catalog changed.
 */
import {
  mintAgentRosterSlot,
  parseAgentRosterSlot,
  parseStoredAgentRequestAuthorityForAttempt,
  rosterSlotErrorMessages,
  sameAgentRequestAuthority,
  type AgentRequestAuthority,
  type AgentRequestIdentity,
  type AgentRosterSlot,
  type InitialSpawnRequestInput,
  type MintedAgentRosterSlot,
  type NonEmpty,
  type OrchestrationRunId,
  type RequestId,
  type SemanticAttempt,
  type SlotId,
} from '../../../core/orchestration-contract';
import type { ContextPacket } from '../../../core/context-packets';
import type { BriefFinding, ReviewLens } from '../../../core/review-panel';
import {
  deriveRefutationVerifierBinding,
  issueRefutationPanelAuthority,
  parseRefutationPanelAuthority,
  type IssuedRefutationPanelAuthority,
  type RefutationPanelAuthority,
} from '../../../core/panel-authority';
import type { LoomAgentName } from '../../../core/model-profiles';
import type { RunDirHandle } from '../../../orchestration/run-directory-handle';
import { durablePublishedReceipt, refutationBatchEffectId } from './durable-requests';

const VERIFIER_ROLE = "review-verifier-agent" satisfies LoomAgentName;

/** One verifier request ready to publish: its authority (typed, never re-parsed) and its packet. */
export type PreparedVerifierRequest = Readonly<{
  input: InitialSpawnRequestInput & Readonly<{ authority: AgentRequestAuthority }>;
  packet: ContextPacket;
}>;

/**
 * The panel a preparation produced: `issued` when it was minted now from
 * today's catalog (its roster keeps the minted proof), `recorded` when it was
 * read back from the panel's record as history.
 */
export type PreparedRefutationPanel =
  | Readonly<{ kind: "issued"; authority: IssuedRefutationPanelAuthority }>
  | Readonly<{ kind: "recorded"; authority: RefutationPanelAuthority }>;

export type RefutationVerifierPreparation = Readonly<{
  panel: PreparedRefutationPanel;
  /** Attempt-1 requests and their packets, index-aligned, in lens order. */
  inputs: readonly PreparedVerifierRequest["input"][];
  packets: readonly ContextPacket[];
  /** Each slot's attempt-2 request, published only when the panel asks for that retry. */
  retryInputs: readonly PreparedVerifierRequest[];
}>;

export type RefutationVerifierPlan = Readonly<{
  handle: RunDirHandle;
  /** The durable effect label the attempt-1 batch is published under. */
  label: string;
  /** Semantic panel identity the verifier slots derive from; the run itself when omitted. */
  identityRunId?: OrchestrationRunId;
  findings: NonEmpty<BriefFinding>;
  lenses: NonEmpty<ReviewLens>;
  /** The program's Context Packet for one verifier attempt; it throws when the packet cannot be built. */
  packet: (lens: ReviewLens, requestId: RequestId, attempt: SemanticAttempt) => ContextPacket;
  /** The panel the program checkpointed, when it keeps one: the earliest record of issuance. */
  recorded?: RefutationPanelAuthority;
}>;

type DraftAttempt<Attempt extends SemanticAttempt> = Readonly<{ identity: AgentRequestIdentity<Attempt>; packet: ContextPacket }>;
type DraftSlot = Readonly<{ slotId: SlotId; attempts: readonly [DraftAttempt<1>, DraftAttempt<2>] }>;

/** A verifier slot beside the draft it was issued or read for, so its packets are never looked up by index. */
type PairedSlot<Slot extends AgentRosterSlot> = Readonly<{ draft: DraftSlot; slot: Slot }>;

/** The recorded verifier requests of the panel, keyed by request id; empty when the panel has no record. */
function recordedVerifierRequests(plan: RefutationVerifierPlan, drafts: readonly DraftSlot[]): ReadonlyMap<string, AgentRequestAuthority> {
  if (plan.recorded !== undefined) {
    return new Map(plan.recorded.verifierRoster.orderedSlots.flatMap(({ attempts }) =>
      attempts.map((authority) => [authority.requestId, authority] as const)));
  }
  const effectId = refutationBatchEffectId(plan.label, drafts.map(({ attempts }) => attempts[0].identity.requestId));
  if (!effectId.ok) throw new Error(effectId.error.message);
  const receipt = durablePublishedReceipt(plan.handle, effectId.value);
  if (receipt.kind === "corrupt") throw new Error(receipt.message);
  return receipt.kind === "absent"
    ? new Map()
    : new Map(receipt.receipt.issuedRequests.map(({ authority }) => [authority.requestId, authority] as const));
}

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
): AgentRequestAuthority<Attempt> {
  const parsed = parseStoredAgentRequestAuthorityForAttempt({
    ...draft.identity,
    modelProfile: recorded.modelProfile,
    harnessBinding: recorded.harnessBinding,
    requiredSkill: recorded.requiredSkill,
  }, draft.identity.attempt);
  if (!parsed.ok) throw new Error(parsed.error.violations.map(({ message }) => message).join("; "));
  if (recorded.attempt === draft.identity.attempt && !sameAgentRequestAuthority(parsed.value, recorded)) {
    throw new Error(`recorded verifier request ${recorded.requestId} differs from the panel's deterministic request`);
  }
  return parsed.value;
}

/** Mint `draft`'s slot from today's catalog, or throw naming every reason the catalog refused it. */
function mintedVerifierSlot(draft: DraftSlot): MintedAgentRosterSlot {
  const slot = mintAgentRosterSlot(draft.attempts[0].identity, draft.attempts[1].identity);
  if (!slot.ok) throw new Error(`verifier slot ${draft.slotId} cannot be minted: ${rosterSlotErrorMessages(slot.error).join("; ")}`);
  return slot.value;
}

function recordedVerifierSlot(draft: DraftSlot, recorded: ReadonlyMap<string, AgentRequestAuthority>): AgentRosterSlot {
  const [firstDraft, retryDraft] = draft.attempts;
  const recordedFirst = recorded.get(firstDraft.identity.requestId);
  if (recordedFirst === undefined) {
    throw new Error(`refutation panel record lacks verifier request ${firstDraft.identity.requestId}`);
  }
  const slot = parseAgentRosterSlot(
    recordedAttempt(firstDraft, recordedFirst),
    recordedAttempt(retryDraft, recorded.get(retryDraft.identity.requestId) ?? recordedFirst),
  );
  if (!slot.ok) throw new Error(`verifier slot ${draft.slotId} is invalid: ${slot.error.violations.map(({ kind }) => kind).join(", ")}`);
  return slot.value;
}

/** The deterministic identities and packets of one lens's verifier slot. */
function draftSlot(plan: RefutationVerifierPlan, identityRunId: OrchestrationRunId, lens: ReviewLens, findingIds: NonEmpty<BriefFinding["id"]>): DraftSlot {
  const binding = deriveRefutationVerifierBinding(identityRunId, lens, findingIds);
  if (!binding.ok) throw new Error(binding.errors.join("; "));
  const { slotId, requestIds: [firstRequestId, retryRequestId] } = binding.value;
  const draft = <Attempt extends SemanticAttempt>(attempt: Attempt, requestId: RequestId): DraftAttempt<Attempt> => {
    const packet = plan.packet(lens, requestId, attempt);
    return Object.freeze({
      packet,
      identity: Object.freeze({
        runId: plan.handle.runId,
        requestId,
        slotId,
        program: "refutation-panel" as const,
        role: VERIFIER_ROLE,
        attempt,
        contextDigest: packet.digest,
        outputSlot: `transcripts/${slotId}/attempt-${attempt}.raw`,
      }),
    });
  };
  return Object.freeze({ slotId, attempts: Object.freeze([draft(1, firstRequestId), draft(2, retryRequestId)] as const) });
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

function preparation(panel: PreparedRefutationPanel, paired: readonly PairedSlot<AgentRosterSlot>[]): RefutationVerifierPreparation {
  const first = paired.map(({ draft, slot }) => preparedRequest(slot.attempts[0], draft.attempts[0].packet));
  return Object.freeze({
    panel,
    inputs: Object.freeze(first.map(({ input }) => input)),
    packets: Object.freeze(first.map(({ packet }) => packet)),
    retryInputs: Object.freeze(paired.map(({ draft, slot }) => preparedRequest(slot.attempts[1], draft.attempts[1].packet))),
  });
}

/**
 * Prepare a refutation panel's verifier requests: read from its record when
 * one exists, minted from today's catalog when none does. Throws on a record
 * that does not match the panel's deterministic requests, as the programs'
 * preparation always has for an authority it cannot build.
 */
export function prepareRefutationVerifiers(plan: RefutationVerifierPlan): RefutationVerifierPreparation {
  const { handle, findings, lenses } = plan;
  const identityRunId = plan.identityRunId ?? handle.runId;
  const findingIds = [findings[0].id, ...findings.slice(1).map(({ id }) => id)] as const;
  const drafts = lenses.map((lens) => draftSlot(plan, identityRunId, lens, findingIds));
  const panelInput = { runId: handle.runId, identityRunId, findings, lenses };

  const recorded = recordedVerifierRequests(plan, drafts);
  if (recorded.size === 0) {
    const minted = drafts.map((draft): PairedSlot<MintedAgentRosterSlot> => ({ draft, slot: mintedVerifierSlot(draft) }));
    const issued = issueRefutationPanelAuthority({ ...panelInput, verifierSlots: minted.map(({ slot }) => slot) });
    if (!issued.ok) throw new Error(issued.error.message);
    return preparation(Object.freeze({ kind: "issued", authority: issued.value }), minted);
  }
  const read = drafts.map((draft): PairedSlot<AgentRosterSlot> => ({ draft, slot: recordedVerifierSlot(draft, recorded) }));
  const parsed = parseRefutationPanelAuthority({ ...panelInput, verifierSlots: read.map(({ slot }) => slot) });
  if (!parsed.ok) throw new Error(parsed.error.message);
  return preparation(Object.freeze({ kind: "recorded", authority: parsed.value }), read);
}
