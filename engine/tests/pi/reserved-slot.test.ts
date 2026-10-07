/**
 * A spawn producer's role claims parse into exactly one role arm before the
 * slot is reserved. Claims carrying several role authorities, an authority
 * for a role their agent does not play, or an implementation authority for
 * another Task are refused at the producer — the stored reservation can only
 * hold a parsed `ReservedSlot`.
 */

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  createImplementationAttemptAuthority,
  parseIsoInstant,
  parseReservationId,
} from "../../src/core/implementation-completion";
import { parseArtifactDigest, parseOrchestrationRunId } from "../../src/core/orchestration-contract";
import {
  implementationAuthorityOf,
  parseReservedSlot,
  reviewAuthorityOf,
  specCheckAuthorityOf,
  type PiReviewAttemptAuthority,
  type PiSpecCheckAttemptAuthority,
  type ReservedSlotClaims,
} from "../../../pi/reserved-slot";
import { slotClaims } from "../fixtures/pi-reserved-slot";

function implementationAuthority() {
  const instant = parseIsoInstant("2026-08-24T00:00:00.000Z");
  const reservationId = parseReservationId("pi-reserved-slot");
  if (!instant.ok || !reservationId.ok) throw new Error("fixture identity failed");
  const created = createImplementationAttemptAuthority({
    taskId: "T1", wave: 1, semanticAttempt: 1, reservationId: reservationId.value,
    headSha: "1".repeat(40), reservedAt: instant.value,
    taskScopeBaseline: [], dirtySetBaseline: [],
  });
  if (!created.ok) throw new Error(created.error.errors.join("; "));
  return created.value;
}

const REVIEW: PiReviewAttemptAuthority = Object.freeze({
  kind: "legacy", taskId: "T1", agentType: "code-reviewer", generation: 0,
});

function specCheckAuthority(): PiSpecCheckAttemptAuthority {
  const runId = parseOrchestrationRunId("run.reserved-slot");
  const batchEpoch = parseArtifactDigest("b".repeat(64));
  if (!runId.ok || !batchEpoch.ok) throw new Error("fixture identity failed");
  return Object.freeze({
    runId: runId.value, wave: 1, batchEpoch: batchEpoch.value, slotId: "wave-slot:spec-check", attempt: 1,
  });
}

const IMPLEMENTATION = implementationAuthority();
const SPEC_CHECK = specCheckAuthority();

/** Each role authority with the one agent allowed to carry it. */
const ROLES = [
  { role: "implementation", agentType: "code-implementer-agent", field: { implementationAuthority: IMPLEMENTATION } },
  { role: "review", agentType: "code-reviewer", field: { reviewAuthority: REVIEW } },
  { role: "spec-check", agentType: "spec-check-invoker", field: { specCheckAuthority: SPEC_CHECK } },
] as const;

describe("parseReservedSlot", () => {
  it("parses a record with no role authority as the legacy arm", () => {
    const parsed = parseReservedSlot(slotClaims({ agentType: "code-reviewer", taskId: "T1" }));
    expect(parsed).toEqual({ ok: true, value: { role: "legacy", agentType: "code-reviewer", taskId: "T1" } });
    const value = parsed.ok ? parsed.value : undefined;
    expect([implementationAuthorityOf(value), reviewAuthorityOf(value), specCheckAuthorityOf(value)])
      .toEqual([null, null, null]);
  });

  it.each(ROLES)("parses a lone $role authority on its own agent into that arm only", ({ role, agentType, field }) => {
    const parsed = parseReservedSlot(slotClaims({ agentType, taskId: "T1", ...field }));
    expect(parsed.ok && parsed.value.role).toBe(role);
    const value = parsed.ok ? parsed.value : undefined;
    expect(implementationAuthorityOf(value)).toBe(role === "implementation" ? IMPLEMENTATION : null);
    expect(reviewAuthorityOf(value)).toBe(role === "review" ? REVIEW : null);
    expect(specCheckAuthorityOf(value)).toBe(role === "spec-check" ? SPEC_CHECK : null);
  });

  it("refuses every record carrying more than one role authority, whatever its agent", () => {
    fc.assert(fc.property(
      fc.subarray([...ROLES], { minLength: 2 }),
      fc.constantFrom(...ROLES.map(({ agentType }) => agentType)),
      (roles, agentType) => {
        const record: ReservedSlotClaims = slotClaims({
          agentType,
          taskId: "T1",
          ...Object.assign({}, ...roles.map(({ field }) => field)),
        });
        const parsed = parseReservedSlot(record);
        expect(parsed.ok).toBe(false);
        expect(!parsed.ok && parsed.error).toContain(`carries ${roles.length} role authorities`);
      },
    ));
  });

  it("refuses a lone authority on an agent that does not play its role", () => {
    fc.assert(fc.property(
      fc.constantFrom(...ROLES),
      fc.constantFrom(...ROLES.map(({ agentType }) => agentType), "architecture-agent"),
      ({ agentType: owner, field }, agentType) => {
        fc.pre(agentType !== owner);
        const parsed = parseReservedSlot(slotClaims({ agentType, taskId: "T1", ...field }));
        expect(parsed.ok).toBe(false);
        expect(!parsed.ok && parsed.error).toMatch(/but the agent is not/);
      },
    ));
  });

  it("refuses an implementation authority for a Task other than the one the slot reserves", () => {
    for (const taskId of ["T2", null] as const) {
      const parsed = parseReservedSlot(slotClaims({
        agentType: "code-implementer-agent",
        taskId,
        implementationAuthority: IMPLEMENTATION,
      }));
      expect(parsed).toEqual({
        ok: false,
        error: `reserved slot for code-implementer-agent reserves Task ${taskId ?? "missing"}, but its implementation authority is for T1`,
      });
    }
  });

  it("returns frozen slots, the implementation arm naming its authority's Task", () => {
    const parsed = parseReservedSlot(slotClaims({
      agentType: "code-implementer-agent", taskId: "T1", implementationAuthority: IMPLEMENTATION,
    }));
    expect(parsed).toEqual({
      ok: true,
      value: { agentType: "code-implementer-agent", taskId: "T1", role: "implementation", authority: IMPLEMENTATION },
    });
    expect(parsed.ok && Object.isFrozen(parsed.value)).toBe(true);
  });
});
