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
  type ExactRoster,
  type MintedAgentRequestAuthority,
  type MintedAgentRosterSlot,
  type SlotId,
} from "../../src/core/orchestration-contract";
import { agentRequestIdentity } from "../fixtures/agent-request-identity";

/**
 * Minting is the one way to a `MintedAgentRequestAuthority`: a slot is minted
 * from its two identities by one helper every issuer shares, and an issued
 * roster keeps the minted slot type without re-parsing its slots.
 */

const RUN = "run:roster-minting";

/** One identity per slot index; its digest varies with index and attempt, so no two minted identities share one. */
const identity = <Attempt extends 1 | 2>(role: LoomAgentName, index: number, attempt: Attempt) =>
  agentRequestIdentity(role, attempt, {
    runId: RUN,
    slotId: `slot:minting-${index}`,
    contextDigest: `${index.toString(16).padStart(3, "0")}${attempt}`.repeat(16),
  });

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
  it("issues exactly the roster parseExactRoster reads from the same slots, keeping the minted slot type (property)", () => {
    fc.assert(fc.property(fc.uniqueArray(fc.nat({ max: 40 }), { minLength: 1, maxLength: 4 }), roles, (indices, role) => {
      const slots = indices.map((index) => mintedSlot(role, index));
      const issued = issueExactRoster(slots);
      const parsed = parseExactRoster(slots);
      expect(issued.ok).toBe(true);
      if (!issued.ok || !parsed.ok) return;
      const minted: ExactRoster<MintedAgentRosterSlot> = issued.value;
      expect(minted.orderedSlots).toEqual(parsed.value.orderedSlots);
      expect([minted.runId, minted.program]).toEqual([parsed.value.runId, parsed.value.program]);
    }));
  });

  it("applies the same cross-slot rules: an empty roster and a repeated slot are refused", () => {
    expect(issueExactRoster([])).toMatchObject({ ok: false, error: { violations: [{ kind: "empty-roster" }] } });
    const slot = mintedSlot("code-reviewer", 3);
    const repeated = issueExactRoster([slot, slot]);
    expect(repeated.ok).toBe(false);
    if (!repeated.ok) expect(repeated.error.violations.map(({ kind }) => kind)).toContain("duplicate-slot");
    expect(repeated).toEqual(parseExactRoster([slot, slot]));
  });

  it("re-checks each slot's pairing at run time: a minted slot relabelled past the type is refused as parseExactRoster refuses it", () => {
    const slot = mintedSlot("code-reviewer", 4);
    const relabelled: MintedAgentRosterSlot = { ...slot, slotId: "slot:relabelled" as SlotId };
    const issued = issueExactRoster([relabelled]);
    expect(issued).toMatchObject({ ok: false, error: { violations: [{ kind: "attempt-pair-mismatch", slotId: slot.slotId, field: "slotId" }] } });
    expect(issued).toEqual(parseExactRoster([relabelled]));
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
