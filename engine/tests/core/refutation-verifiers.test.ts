import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { buildContextPacket, encodeByteSection, type ContextPacket } from "../../src/core/context-packets";
import { currentProfileBindings, resolveAgentPolicy, type PiBinding } from "../../src/core/model-profiles";
import {
  parseAgentRosterSlot,
  parseOrchestrationRunId,
  type AgentRequestAuthority,
  type AgentRosterSlot,
} from "../../src/core/orchestration-contract";
import { parseRefutationPanelAuthority, type RefutationPanelAuthority } from "../../src/core/panel-authority";
import {
  decideRefutationVerifiers,
  refutationVerifierRequestIds,
  type RefutationPanelRecord,
  type RefutationVerifierPlan,
  type RefutationVerifierPreparation,
} from "../../src/core/refutation-verifiers";
import { REVIEW_LENSES, parseWaveFindingId, type BriefFinding, type ReviewLens } from "../../src/core/review-panel";
import { RETIRED_REFUTATION_PI_BINDING as RETIRED } from "../fixtures/local-pi-binding";

/**
 * The pure verifier decision: a panel with no record is minted from today's
 * catalog; a panel on record — checkpointed, or published by its attempt-1
 * receipt — is read back as history and never re-minted (ADR-0023).
 */

const runId = parseOrchestrationRunId("run.refutation-verifiers");
if (!runId.ok) throw new Error(runId.error.message);
const RUN_ID = runId.value;

const findingId = parseWaveFindingId("T1:finding-1");
if (findingId === null) throw new Error("fixture finding id must parse");
const FINDINGS: readonly [BriefFinding] = [Object.freeze({
  id: findingId, taskId: "T1", agent: "code-reviewer", severity: "critical", file: null, line: null, claim: "a claim",
})];
const LENSES: readonly [ReviewLens, ReviewLens] = ["reproduction", "intent"];

const fixturePacket: RefutationVerifierPlan["packet"] = (lens, requestId, attempt) => {
  const section = encodeByteSection("fixture-refutation-authority", JSON.stringify({ lens, attempt }));
  return section.ok
    ? buildContextPacket({
        requestId, role: "review-verifier-agent", requiredSkill: "none",
        outputContract: `Adjudicate through lens '${lens}'.`, fixedContext: [section.value], variableContext: [],
      })
    : section;
};

const plan = (overrides: Partial<RefutationVerifierPlan> = {}): RefutationVerifierPlan =>
  ({ runId: RUN_ID, findings: FINDINGS, lenses: LENSES, packet: fixturePacket, ...overrides });

const NONE: RefutationPanelRecord = { kind: "none" };
const checkpointed = (panel: RefutationPanelAuthority): RefutationPanelRecord => ({ kind: "checkpointed-panel", panel });
/** The requests an attempt-1 batch receipt publishes: each slot's first attempt. */
const receiptOf = (panel: RefutationPanelAuthority): RefutationPanelRecord =>
  ({ kind: "receipt-requests", requests: panel.verifierRoster.orderedSlots.map(({ attempts }) => attempts[0]) });

function decided(record: RefutationPanelRecord, overrides: Partial<RefutationVerifierPlan> = {}): RefutationVerifierPreparation {
  const result = decideRefutationVerifiers(plan(overrides), record);
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

/** `panel` as it would have been recorded with every verifier request on `pi`. */
function recordedOn(panel: RefutationPanelAuthority, pi: PiBinding): RefutationPanelAuthority {
  const rebind = (authority: AgentRequestAuthority) => ({ ...authority, harnessBinding: { ...authority.harnessBinding, pi } });
  const verifierSlots = panel.verifierRoster.orderedSlots.map(({ attempts }) => {
    const slot = parseAgentRosterSlot(rebind(attempts[0]), rebind(attempts[1]));
    if (!slot.ok) throw new Error(JSON.stringify(slot.error));
    return slot.value;
  });
  const parsed = parseRefutationPanelAuthority({
    runId: panel.runId, identityRunId: panel.identityRunId, findings: panel.findings, lenses: panel.lenses, verifierSlots,
  });
  if (!parsed.ok) throw new Error(parsed.error.message);
  return parsed.value;
}

const bindings = (slots: readonly AgentRosterSlot[]) =>
  slots.flatMap(({ attempts }) => attempts.map(({ harnessBinding }) => harnessBinding.pi));

describe("decideRefutationVerifiers: a panel with no record is minted", () => {
  it("mints every verifier request from today's catalog, index-aligned with its packets", () => {
    const prepared = decided(NONE);
    const slots = prepared.refutationAuthority.verifierRoster.orderedSlots;
    expect(bindings(slots)).toEqual(Array(4).fill(currentProfileBindings("refutation").pi));
    expect(prepared.inputs.map(({ authority }) => authority)).toEqual(slots.map(({ attempts }) => attempts[0]));
    expect(prepared.retryInputs.map(({ input }) => input.authority)).toEqual(slots.map(({ attempts }) => attempts[1]));
    expect(prepared.packets.map(({ digest }) => digest)).toEqual(prepared.inputs.map(({ authority }) => authority.contextDigest));
  });

  it("routes every minted request through the catalog's verifier policy", () => {
    const policy = resolveAgentPolicy("review-verifier-agent");
    if (!policy.ok) throw new Error(policy.error.message);
    const prepared = decided(NONE);
    for (const request of prepared.refutationAuthority.verifierRoster.orderedSlots.flatMap(({ attempts }) => attempts)) {
      expect(request.role).toBe("review-verifier-agent");
      expect(request.modelProfile).toBe(policy.value.profile);
      expect(request.requiredSkill).toBe(policy.value.requiredSkill);
      // Golden bytes: the serialized verifier authority's binding, as every
      // Refutation Panel (standalone and Wave) issues it today.
      expect(JSON.stringify(request.harnessBinding)).toBe(
        '{"pi":{"harness":"pi","provider":"desktop-vllm","model":"glm-5.3-flash-spark-tp2-v14","thinking":"high"},' +
        '"claude":{"harness":"claude-code","model":"opus"}}',
      );
    }
    expect(prepared.refutationAuthority.findings).toEqual(FINDINGS);
    expect(prepared.refutationAuthority.lenses).toEqual(LENSES);
  });

  it("names the catalog's own reasons when a verifier request cannot be minted", () => {
    const result = decideRefutationVerifiers(plan({
      // A forged packet: its digest is no Context Packet digest, so the catalog parse refuses it.
      packet: (lens, requestId, attempt) => {
        const packet = fixturePacket(lens, requestId, attempt);
        return packet.ok ? { ok: true, value: { ...packet.value, digest: "not-a-digest" } as unknown as ContextPacket } : packet;
      },
    }), NONE);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("unmintable-slot");
    const parsed = result.error.message.match(/^verifier slot (refutation-slot:[0-9a-f]+) cannot be minted: (.+)$/);
    expect(parsed).not.toBeNull();
    const reasons = parsed?.[2]?.split("; ") ?? [];
    // Both attempts' catalog violations are propagated verbatim, never collapsed.
    expect(reasons.length).toBeGreaterThanOrEqual(2);
    expect(reasons.some((reason) => /digest/i.test(reason))).toBe(true);
    expect(reasons.every((reason) => reason.length > 0 && reason !== "roster slot: invalid")).toBe(true);
  });

  it("refuses, as data, a packet the program cannot build", () => {
    const result = decideRefutationVerifiers(plan({ packet: () => ({ ok: false, error: { message: "no packet today" } }) }), NONE);
    expect(result).toEqual({ ok: false, error: { kind: "unbuildable-packet", message: "no packet today" } });
  });
});

describe("decideRefutationVerifiers: a panel on record is read back as history", () => {
  it.each([
    ["its checkpoint", checkpointed],
    ["its attempt-1 receipt", receiptOf],
  ] as const)("reads a panel recorded on a retired binding from %s instead of re-minting", (_label, record) => {
    const recorded = recordedOn(decided(NONE).refutationAuthority, RETIRED);
    const prepared = decided(record(recorded));
    expect(prepared.refutationAuthority).toEqual(recorded);
    expect(bindings(prepared.refutationAuthority.verifierRoster.orderedSlots)).toEqual(Array(4).fill(RETIRED));
    expect(prepared.retryInputs.map(({ input }) => input.authority.harnessBinding.pi)).toEqual([RETIRED, RETIRED]);
  });

  it("refuses a record whose request differs from the panel's deterministic request", () => {
    const recorded = recordedOn(decided(NONE).refutationAuthority, RETIRED);
    const result = decideRefutationVerifiers(plan({
      packet: (lens, requestId, attempt) => fixturePacket(lens, requestId, attempt === 1 ? 2 : 1),
    }), checkpointed(recorded));
    expect(result).toMatchObject({ ok: false, error: { kind: "record-differs", message: expect.stringMatching(/differs from the panel's deterministic request/) } });
  });

  it("refuses a record that lacks one of the panel's verifier slots", () => {
    const oneLens = decided(NONE, { lenses: ["reproduction"] }).refutationAuthority;
    const result = decideRefutationVerifiers(plan(), checkpointed(recordedOn(oneLens, RETIRED)));
    expect(result).toMatchObject({ ok: false, error: { kind: "record-lacks-request", message: expect.stringMatching(/lacks verifier request/) } });
  });

  it("keys the receipt by the panel's attempt-1 request ids, in lens order", () => {
    const ids = refutationVerifierRequestIds(plan());
    expect(ids).toEqual({ ok: true, value: decided(NONE).inputs.map(({ authority }) => authority.requestId) });
  });
});

describe("decideRefutationVerifiers: issuance and history agree", () => {
  const lensSets = fc.subarray([...REVIEW_LENSES], { minLength: 1 }) as fc.Arbitrary<ReviewLens[]>;
  const recordKinds = fc.constantFrom("checkpointed-panel", "receipt-requests") satisfies fc.Arbitrary<Exclude<RefutationPanelRecord["kind"], "none">>;

  it("re-reads a minted panel from either record as exactly the panel it minted", () => {
    fc.assert(fc.property(lensSets, recordKinds, (lensList, kind) => {
      const lenses = [lensList[0]!, ...lensList.slice(1)] as const;
      const minted = decided(NONE, { lenses });
      const reread = decided(kind === "checkpointed-panel" ? checkpointed(minted.refutationAuthority) : receiptOf(minted.refutationAuthority), { lenses });
      expect(reread).toEqual(minted);
    }), { numRuns: 40 });
  });

  it("is deterministic: the same plan and record decide the same preparation", () => {
    fc.assert(fc.property(lensSets, (lensList) => {
      const lenses = [lensList[0]!, ...lensList.slice(1)] as const;
      expect(decided(NONE, { lenses })).toEqual(decided(NONE, { lenses }));
    }), { numRuns: 20 });
  });
});
