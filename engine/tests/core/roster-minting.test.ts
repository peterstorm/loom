import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { AGENT_POLICIES, type LoomAgentName } from "../../src/core/model-profiles";
import {
  issueExactRoster,
  mintAgentRequestAuthority,
  mintAgentRosterSlot,
  parseAgentRequestAuthority,
  parseAgentRosterSlot,
  parseExactRoster,
  rosterSlotErrorMessages,
  type AgentRosterSlotIdentities,
  type ExactRoster,
  type MintedAgentRequestAuthority,
  type MintedAgentRosterSlot,
} from "../../src/core/orchestration-contract";
import { agentRequestIdentity } from "../fixtures/agent-request-identity";

/**
 * Minting is the one way to a `MintedAgentRequestAuthority`: a slot is minted
 * from its two identities by one helper every issuer shares, and a roster is
 * issued from its slots' identities by one seam that mints them itself and
 * keeps the minted slot type, re-checking nothing.
 */

const RUN = "run:roster-minting";

/** One identity per slot index; its digest varies with index and attempt, so no two minted identities share one. */
const identity = <Attempt extends 1 | 2>(role: LoomAgentName, index: number, attempt: Attempt) =>
  agentRequestIdentity(role, attempt, {
    runId: RUN,
    slotId: `slot:minting-${index}`,
    contextDigest: `${index.toString(16).padStart(3, "0")}${attempt}`.repeat(16),
  });

const slotIdentities = (role: LoomAgentName, index: number): AgentRosterSlotIdentities =>
  [identity(role, index, 1), identity(role, index, 2)];

function mintedSlot(role: LoomAgentName, index: number): MintedAgentRosterSlot {
  const slot = mintAgentRosterSlot(identity(role, index, 1), identity(role, index, 2));
  if (!slot.ok) throw new Error(rosterSlotErrorMessages(slot.error).join("; "));
  return slot.value;
}

const roles = fc.constantFrom(...AGENT_POLICIES.map(({ agent }) => agent));

describe("mintAgentRosterSlot", () => {
  it("mints the slot a recorded read of its two separately minted requests parses (property)", () => {
    fc.assert(fc.property(roles, fc.nat({ max: 50 }), (role, index) => {
      const first = mintAgentRequestAuthority(identity(role, index, 1));
      const retry = mintAgentRequestAuthority(identity(role, index, 2));
      if (!first.ok || !retry.ok) throw new Error("every catalog role mints");
      expect(mintAgentRosterSlot(identity(role, index, 1), identity(role, index, 2)))
        .toEqual(parseAgentRosterSlot(first.value, retry.value));
    }));
  });

  it("issues a slot that reads back unchanged as recorded history (property)", () => {
    fc.assert(fc.property(roles, fc.nat({ max: 50 }), (role, index) => {
      const slot = mintedSlot(role, index);
      expect(parseAgentRosterSlot(slot.attempts[0], slot.attempts[1])).toEqual({ ok: true, value: slot });
    }));
  });

  it("propagates each attempt's own catalog violation as its message", () => {
    const slot = mintAgentRosterSlot(
      { ...identity("code-reviewer", 1, 1), contextDigest: "not-a-digest" },
      { ...identity("code-reviewer", 1, 2), outputSlot: "../escape" },
    );
    expect(slot.ok).toBe(false);
    if (slot.ok) return;
    expect(slot.error.violations.map(({ kind }) => kind)).toEqual(["malformed-attempt-authority", "malformed-attempt-authority"]);
    const messages = rosterSlotErrorMessages(slot.error);
    expect(messages).toEqual(slot.error.violations.flatMap((violation) =>
      violation.kind === "malformed-attempt-authority" ? violation.authorityViolations.map(({ message }) => message) : []));
    expect(messages.length).toBeGreaterThanOrEqual(2);
  });

  it("names a pair violation by its kind and the field the attempts disagree on", () => {
    const slot = mintAgentRosterSlot(identity("code-reviewer", 1, 1), { ...identity("code-reviewer", 1, 2), slotId: "slot:other" });
    expect(slot.ok).toBe(false);
    if (slot.ok) return;
    expect(rosterSlotErrorMessages(slot.error)).toContain("roster slot: attempt-pair-mismatch (slotId)");
  });
});

describe("issueExactRoster", () => {
  it("mints each slot from its identities and issues exactly the roster parseExactRoster reads from those slots, keeping the minted slot type (property)", () => {
    fc.assert(fc.property(fc.uniqueArray(fc.nat({ max: 40 }), { minLength: 1, maxLength: 4 }), roles, (indices, role) => {
      const issued = issueExactRoster(indices.map((index) => slotIdentities(role, index)));
      const slots = indices.map((index) => mintedSlot(role, index));
      const parsed = parseExactRoster(slots);
      expect(issued.ok).toBe(true);
      if (!issued.ok || !parsed.ok) return;
      const minted: ExactRoster<MintedAgentRosterSlot> = issued.value;
      expect(minted.orderedSlots).toEqual(slots);
      expect(minted.orderedSlots).toEqual(parsed.value.orderedSlots);
      expect([minted.runId, minted.program]).toEqual([parsed.value.runId, parsed.value.program]);
    }));
  });

  it("applies the same cross-slot rules: an empty roster and a repeated slot are refused", () => {
    expect(issueExactRoster([])).toMatchObject({ ok: false, error: { violations: [{ kind: "empty-roster" }] } });
    const repeated = issueExactRoster([slotIdentities("code-reviewer", 3), slotIdentities("code-reviewer", 3)]);
    expect(repeated).toMatchObject({ ok: false, error: { kind: "invalid-exact-roster" } });
    if (!repeated.ok && repeated.error.kind === "invalid-exact-roster") {
      expect(repeated.error.violations.map(({ kind }) => kind)).toContain("duplicate-slot");
    }
    const slot = mintedSlot("code-reviewer", 3);
    expect(repeated).toEqual(parseExactRoster([slot, slot]));
  });

  it("refuses the first slot the catalog will not mint, naming the slot id it declares and the catalog's own reasons", () => {
    const unmintable = (index: number): AgentRosterSlotIdentities =>
      [{ ...identity("code-reviewer", index, 1), contextDigest: "not-a-digest" }, identity("code-reviewer", index, 2)];
    const refused = mintAgentRosterSlot(...unmintable(5));
    if (refused.ok) throw new Error("the fixture must not mint");
    expect(issueExactRoster([slotIdentities("code-reviewer", 4), unmintable(5), unmintable(6)]))
      .toEqual({ ok: false, error: { kind: "unmintable-roster-slot", slotId: "slot:minting-5", error: refused.error } });
  });

  it("refuses a slot whose identities disagree exactly as mintAgentRosterSlot refuses it", () => {
    const disagreeing: AgentRosterSlotIdentities = [identity("code-reviewer", 4, 1), { ...identity("code-reviewer", 4, 2), slotId: "slot:relabelled" }];
    const refused = mintAgentRosterSlot(...disagreeing);
    if (refused.ok) throw new Error("the fixture must not mint");
    expect(rosterSlotErrorMessages(refused.error)).toContain("roster slot: attempt-pair-mismatch (slotId)");
    expect(issueExactRoster([disagreeing]))
      .toEqual({ ok: false, error: { kind: "unmintable-roster-slot", slotId: "slot:minting-4", error: refused.error } });
  });

  it("takes only identities: a slot minted or read elsewhere cannot be passed in", () => {
    const slot = mintedSlot("code-reviewer", 7);
    // Only the type is under test: the roster holds exactly the slots it minted itself.
    // @ts-expect-error a minted slot is not an issuer's identities
    void (() => issueExactRoster([slot]));
  });
});

describe("the minted brand has one constructor", () => {
  it("proves an authority current with the strict parse, without minting it", () => {
    const minted = mintAgentRequestAuthority(identity("code-reviewer", 5, 1));
    if (!minted.ok) throw new Error("mint failed");
    const parsed = parseAgentRequestAuthority(minted.value);
    expect(parsed).toEqual(minted);
    if (!parsed.ok) return;
    // @ts-expect-error only mintAgentRequestAuthority constructs a minted authority
    const forged: MintedAgentRequestAuthority = parsed.value;
    expect(forged).toEqual(minted.value);
  });
});
