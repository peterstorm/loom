/**
 * Refutation Panel verifier authority shared by the standalone and Wave Gate
 * programs: one verifier slot per lens, both attempts' Context Packets and
 * requests, and the panel authority over them.
 *
 * ADR-0023: a request is checked against today's catalog ONCE, where it is
 * minted. A panel whose verifier requests are already on record — its
 * attempt-1 batch receipt, or the panel a program checkpointed — is history,
 * so its requests are read from that record; only a panel with no record is
 * minted. Re-minting a recorded panel would compare today's binding with the
 * recorded one and refuse every run issued before the catalog changed.
 */
import {
  issueAgentRosterSlot,
  mintAgentRequestAuthority,
  parseAgentRosterSlot,
  parseStoredAgentRequestAuthorityForAttempt,
  sameAgentRequestAuthority,
  type AgentRequestAuthority,
  type AgentRequestIdentity,
  type AgentRosterSlot,
  type DomainResult,
  type InitialSpawnRequestInput,
  type MintedAgentRosterSlot,
  type NonEmpty,
  type OrchestrationRunId,
  type RequestId,
  type RosterViolation,
  type SemanticAttempt,
  type SlotId,
} from '../../../core/orchestration-contract';
import type { ContextPacket } from '../../../core/context-packets';
import type { BriefFinding, ReviewLens } from '../../../core/review-panel';
import {
  deriveRefutationVerifierBinding,
  issueRefutationPanelAuthority,
  parseRefutationPanelAuthority,
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

export type RefutationVerifierPreparation = Readonly<{
  panel: RefutationPanelAuthority;
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

/** The issued (or recorded) slot, or a thrown refusal: the one owner of the verifier-slot error wording. */
function verifierSlot<Slot extends AgentRosterSlot>(
  slotId: SlotId,
  slot: DomainResult<Slot, Readonly<{ violations: NonEmpty<RosterViolation> }>>,
): Slot {
  if (!slot.ok) throw new Error(`verifier slot ${slotId} is invalid: ${slot.error.violations.map(({ kind }) => kind).join(", ")}`);
  return slot.value;
}

function mintedVerifierSlot(draft: DraftSlot): MintedAgentRosterSlot {
  const first = mintAgentRequestAuthority(draft.attempts[0].identity);
  const retry = mintAgentRequestAuthority(draft.attempts[1].identity);
  if (!first.ok || !retry.ok) {
    throw new Error([first, retry].flatMap((minted) => minted.ok ? [] : minted.error.violations.map(({ message }) => message)).join("; "));
  }
  return verifierSlot(draft.slotId, issueAgentRosterSlot(first.value, retry.value));
}

function recordedVerifierSlot(draft: DraftSlot, recorded: ReadonlyMap<string, AgentRequestAuthority>): AgentRosterSlot {
  const [firstDraft, retryDraft] = draft.attempts;
  const recordedFirst = recorded.get(firstDraft.identity.requestId);
  if (recordedFirst === undefined) {
    throw new Error(`refutation panel record lacks verifier request ${firstDraft.identity.requestId}`);
  }
  return verifierSlot(draft.slotId, parseAgentRosterSlot(
    recordedAttempt(firstDraft, recordedFirst),
    recordedAttempt(retryDraft, recorded.get(retryDraft.identity.requestId) ?? recordedFirst),
  ));
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
  const drafts: DraftSlot[] = lenses.map((lens) => {
    const binding = deriveRefutationVerifierBinding(identityRunId, lens, findingIds);
    if (!binding.ok) throw new Error(binding.errors.join("; "));
    const { slotId, requestIds } = binding.value;
    const draft = <Attempt extends SemanticAttempt>(attempt: Attempt): DraftAttempt<Attempt> => {
      const packet = plan.packet(lens, requestIds[attempt - 1]!, attempt);
      return Object.freeze({
        packet,
        identity: Object.freeze({
          runId: handle.runId,
          requestId: requestIds[attempt - 1]!,
          slotId,
          program: "refutation-panel" as const,
          role: VERIFIER_ROLE,
          attempt,
          contextDigest: packet.digest,
          outputSlot: `transcripts/${slotId}/attempt-${attempt}.raw`,
        }),
      });
    };
    return Object.freeze({ slotId, attempts: Object.freeze([draft(1), draft(2)] as const) });
  });

  const recorded = recordedVerifierRequests(plan, drafts);
  const panelInput = { runId: handle.runId, identityRunId, findings, lenses };
  let panel: RefutationPanelAuthority;
  let slots: readonly AgentRosterSlot[];
  if (recorded.size === 0) {
    const minted = drafts.map(mintedVerifierSlot);
    const issued = issueRefutationPanelAuthority({ ...panelInput, verifierSlots: minted });
    if (!issued.ok) throw new Error(issued.error.message);
    panel = issued.value;
    slots = minted;
  } else {
    slots = drafts.map((draft) => recordedVerifierSlot(draft, recorded));
    const parsed = parseRefutationPanelAuthority({ ...panelInput, verifierSlots: slots });
    if (!parsed.ok) throw new Error(parsed.error.message);
    panel = parsed.value;
  }

  const prepared = slots.map((slot, index) => slot.attempts.map((authority, attempt) => {
    const packet = drafts[index]!.attempts[attempt]!.packet;
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
  }));
  return Object.freeze({
    panel,
    inputs: Object.freeze(prepared.map(([first]) => first!.input)),
    packets: Object.freeze(prepared.map(([first]) => first!.packet)),
    retryInputs: Object.freeze(prepared.map(([, retry]) => retry!)),
  });
}
