import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  createPiParentSessions,
  legacyReservationItem,
  ownPiSpawnReservation,
  reservationItemOf,
  type PiSpawnReservation,
} from "../../../pi/spawn-reservation";
import { legacyReservedSlot, type ReservedSlot } from "../../../pi/reserved-slot";
import { slot } from "../fixtures/pi-reserved-slot";
import { parseAgentId, parseSessionId, type SessionTaskGraphPointerBinding } from "../../src/machine";
import {
  createImplementationAttemptAuthority,
  parseIsoInstant,
  parseReservationId,
} from "../../src/core/implementation-completion";
import { parseArtifactDigest, parseOrchestrationRunId } from "../../src/core/orchestration-contract";

const sessionId = parseSessionId("019fca39-f989-7510-8e62-50dadbcad480")!;
const rosterId = parseAgentId("pi-spawn-reservation-roster-1")!;
const pointer = { directory: "/state", pointerName: "p", registryName: "r", target: "/graph.json" } as unknown as SessionTaskGraphPointerBinding;

const reservation = (overrides: Partial<PiSpawnReservation> = {}): PiSpawnReservation => ({
  sessionId,
  needsTaskGraphLifecycle: true,
  graphActiveAtSpawn: true,
  orchestrationRunBinding: null,
  pointerBinding: null,
  items: [],
  ...overrides,
});

const legacyItem = legacyReservationItem({ rosterId, emissionLaunch: null, kind: "non-implementation" }, "code-reviewer", "T1");

describe("createPiParentSessions", () => {
  it("creates one runtime per session on first use and returns the same one after", () => {
    const sessions = createPiParentSessions();
    expect(sessions.get(sessionId)).toBeUndefined();
    const runtime = sessions.runtimeFor(sessionId);
    expect(sessions.runtimeFor(sessionId)).toBe(runtime);
    expect(sessions.get(sessionId)).toBe(runtime);
  });

  it("retains grant debt and prunes the runtime in the same step once it owes nothing", () => {
    const sessions = createPiParentSessions();
    sessions.retainWriteGrantDebt(sessionId, "call-1", [{ slot: 0, token: "token" }]);
    const runtime = sessions.get(sessionId);
    expect(runtime?.issuedWriteGrants.get("call-1")).toEqual([{ slot: 0, token: "token" }]);
    sessions.retainWriteGrantDebt(sessionId, "call-1", []);
    expect(sessions.get(sessionId)).toBeUndefined();
  });

  it("keeps a reservation only while it names a roster entry or pointer lease", () => {
    const sessions = createPiParentSessions();
    sessions.retainSpawnCleanupDebt(sessionId, "call-1", reservation({ items: [legacyItem] }));
    expect(sessions.get(sessionId)?.spawnReservations.get("call-1")?.items).toHaveLength(1);
    sessions.retainSpawnCleanupDebt(sessionId, "call-1", reservation({ pointerBinding: pointer }));
    expect(sessions.get(sessionId)?.spawnReservations.get("call-1")?.pointerBinding).toBe(pointer);
    sessions.retainSpawnCleanupDebt(sessionId, "call-1", reservation());
    expect(sessions.get(sessionId)).toBeUndefined();
  });

  it("never creates a runtime to forget debt, and never prunes a session that still owes", () => {
    fc.assert(fc.property(
      fc.array(fc.record({
        call: fc.constantFrom("call-1", "call-2"),
        grants: fc.boolean(),
        debt: fc.boolean(),
      }), { maxLength: 10 }),
      (steps) => {
        const sessions = createPiParentSessions();
        const owed = new Map<string, { grants: boolean; debt: boolean }>();
        for (const step of steps) {
          sessions.retainWriteGrantDebt(sessionId, step.call, step.grants ? [{ slot: 0, token: "token" }] : []);
          sessions.retainSpawnCleanupDebt(
            sessionId,
            step.call,
            reservation(step.debt ? { pointerBinding: pointer } : {}),
          );
          owed.set(step.call, { grants: step.grants, debt: step.debt });
          const owesAnything = [...owed.values()].some(({ grants, debt }) => grants || debt);
          expect(sessions.get(sessionId) !== undefined).toBe(owesAnything);
        }
      },
    ));
  });
});

describe("reservationItemOf — the per-kind slot invariant at the producer", () => {
  const instant = parseIsoInstant("2026-08-24T00:00:00.000Z");
  const reservationId = parseReservationId("pi-spawn-reservation");
  if (!instant.ok || !reservationId.ok) throw new Error("fixture identity failed");
  const implementation = createImplementationAttemptAuthority({
    taskId: "T1", wave: 1, semanticAttempt: 1, reservationId: reservationId.value,
    headSha: "1".repeat(40), reservedAt: instant.value, taskScopeBaseline: [], dirtySetBaseline: [],
  });
  if (!implementation.ok) throw new Error(implementation.error.errors.join("; "));
  const runId = parseOrchestrationRunId("run.spawn-reservation");
  const batchEpoch = parseArtifactDigest("b".repeat(64));
  if (!runId.ok || !batchEpoch.ok) throw new Error("fixture identity failed");

  // Every slot is minted by the production producer: a ReservedSlot cannot be
  // spelled as an object literal.
  const slots: Readonly<Record<ReservedSlot["role"], ReservedSlot>> = {
    implementation: slot({ agentType: "code-implementer-agent", taskId: "T1", implementationAuthority: implementation.value }),
    review: slot({
      agentType: "code-reviewer", taskId: "T1",
      reviewAuthority: { kind: "legacy", taskId: "T1", agentType: "code-reviewer", generation: 0 },
    }),
    "spec-check": slot({
      agentType: "spec-check-invoker", taskId: null,
      specCheckAuthority: { runId: runId.value, wave: 1, batchEpoch: batchEpoch.value, slotId: "wave-slot:spec-check", attempt: 1 },
    }),
    legacy: legacyReservedSlot("code-reviewer", "T1"),
  };
  const admits = {
    implementation: ["implementation", "legacy"],
    "non-implementation": ["review", "spec-check", "legacy"],
    standalone: ["legacy"],
  } as const;

  it("admits exactly the roles each lifecycle kind can carry, and refuses the rest", () => {
    for (const kind of ["implementation", "non-implementation", "standalone"] as const) {
      for (const [role, slot] of Object.entries(slots)) {
        const item = reservationItemOf({ rosterId, emissionLaunch: null, kind }, slot);
        const admitted = (admits[kind] as readonly string[]).includes(role);
        expect(item.ok, `${kind}/${role}`).toBe(admitted);
        if (item.ok) {
          expect(item.value).toMatchObject({ kind, rosterId, role, agentType: slot.agentType, taskId: slot.taskId });
          expect(Object.isFrozen(item.value)).toBe(true);
        } else {
          expect(item.error).toBe(`reserved ${kind} spawn item for ${slot.agentType} cannot carry ${role} authority`);
        }
      }
    }
  });

  it("builds the authority-free item every kind admits for cleanup debt and recovery", () => {
    for (const kind of ["implementation", "non-implementation", "standalone"] as const) {
      expect(legacyReservationItem({ rosterId, emissionLaunch: null, kind }, "code-reviewer", null)).toEqual({
        rosterId, emissionLaunch: null, kind, agentType: "code-reviewer", taskId: null, role: "legacy",
      });
    }
  });
});

describe("ownPiSpawnReservation — settlement reads one session", () => {
  const otherSession = parseSessionId("019fca39-f989-7510-8e62-50dadbcad481")!;

  it("owns a reservation naming its owner session, unchanged", () => {
    const named = reservation({ items: [legacyItem], pointerBinding: pointer });
    expect(ownPiSpawnReservation(sessionId, named)).toEqual({ ok: true, value: named });
  });

  it("refuses a reservation naming another session", () => {
    expect(ownPiSpawnReservation(otherSession, reservation())).toEqual({
      ok: false,
      error: `Pi spawn reservation names session ${sessionId}, not its owner session ${otherSession}`,
    });
  });
});
