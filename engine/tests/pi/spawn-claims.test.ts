/**
 * The spawn claims ledger: what an admission-time refusal and a `tool_result`
 * settlement must release, in which order, and exactly what stays as cleanup
 * debt when a release fails — all against plain in-memory release ports, no
 * session registry or pointer lease on disk.
 */

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  claimEmissionLaunches,
  claimGrantInjection,
  claimPointerLease,
  claimRosterEntry,
  claimWitnessRun,
  claimWriteGrant,
  NO_SPAWN_CLAIMS,
  planSpawnRollback,
  pointerLeaseOnly,
  releaseSpawnClaims,
  remainingSpawnClaims,
  remainingSpawnDebt,
  settledSpawnClaims,
  spawnDebtOf,
  spawnRollbackStepLabel,
  spawnSettlementStepLabel,
  withoutPointerLease,
  type SpawnClaimReleasePorts,
  type SpawnClaims,
} from "../../../pi/spawn-claims";
import { legacyReservationItem, type PiSpawnReservation } from "../../../pi/spawn-reservation";
import { parseAgentId, parseSessionId, type SessionTaskGraphPointerBinding } from "../../src/machine";
import type { AgentId } from "../../src/machine/evidence";
import type { SessionRunBinding } from "../../src/orchestration/session-run-bindings";

const sessionId = parseSessionId("spawn-claims-session")!;
const pointer = { directory: "/state", pointerName: "p", registryName: "r", target: "/graph.json" } as unknown as SessionTaskGraphPointerBinding;
const witnessRun = { runId: "run.spawn-claims", runsRoot: "/runs", runDirectory: "/runs/run.spawn-claims" } as unknown as SessionRunBinding;
const rosterId = (slot: number): AgentId => parseAgentId(`pi-spawn-claims-${slot}`)!;
const rosterItem = (slot: number) =>
  legacyReservationItem({ rosterId: rosterId(slot), emissionLaunch: null, kind: "implementation" }, "code-implementer-agent", `T${slot + 1}`);
const debtContext = {
  sessionId,
  needsTaskGraphLifecycle: true,
  graphActiveAtSpawn: true,
  orchestrationRunBinding: null,
} as const;

const value = <T>(result: Readonly<{ ok: true; value: T }> | Readonly<{ ok: false; error: string }>): T => {
  if (!result.ok) throw new Error(result.error);
  return result.value;
};

/** A two-slot batch that claimed everything: roster, pointer, a standalone
 *  witness run, both grants (slot 0 injected), and staged launches. */
const fullClaims = (): SpawnClaims => {
  let claims = claimRosterEntry(NO_SPAWN_CLAIMS, rosterItem(0));
  claims = claimRosterEntry(claims, rosterItem(1));
  claims = claimPointerLease(claims, pointer);
  claims = claimWitnessRun(claims, witnessRun);
  claims = value(claimWriteGrant(claims, { slot: 0, token: "token-0" }));
  claims = value(claimWriteGrant(claims, { slot: 1, token: "token-1" }));
  claims = value(claimGrantInjection(claims, { slot: 0, originalTask: "Task ID: T1" }));
  return claimEmissionLaunches(claims);
};

type Port = keyof SpawnClaimReleasePorts;
const PORTS = [
  "removeEmissionLaunches", "revokeGrant", "restorePrompt", "retractWitnessRun", "removeRosterEntry", "releasePointer",
] as const satisfies readonly Port[];

/** In-memory release ports recording every call; the named ports throw. */
const fakePorts = (failing: ReadonlySet<Port> = new Set(), pointerResult = "rolled-back") => {
  const calls: string[] = [];
  const fail = (port: Port): void => {
    if (failing.has(port)) throw new Error(`${port} unavailable`);
  };
  const ports: SpawnClaimReleasePorts = {
    removeEmissionLaunches: () => { calls.push("removeEmissionLaunches"); fail("removeEmissionLaunches"); },
    revokeGrant: (token) => { calls.push(`revokeGrant:${token}`); fail("revokeGrant"); },
    restorePrompt: (slot, task) => { calls.push(`restorePrompt:${slot}:${task}`); fail("restorePrompt"); },
    retractWitnessRun: (binding) => { calls.push(`retractWitnessRun:${binding.runId}`); fail("retractWitnessRun"); },
    removeRosterEntry: async (agentId) => { calls.push(`removeRosterEntry:${agentId}`); fail("removeRosterEntry"); },
    releasePointer: async () => { calls.push("releasePointer"); fail("releasePointer"); return pointerResult; },
  };
  return { ports, calls };
};

const admissionLabel = (step: Parameters<typeof spawnRollbackStepLabel>[0]) => spawnRollbackStepLabel(step, "call-1");

describe("planSpawnRollback", () => {
  it("releases capabilities first, then the witness run, roster entries newest-first, and the pointer lease last", () => {
    expect(planSpawnRollback(fullClaims()).map(admissionLabel)).toEqual([
      "remove emission launch capabilities for call-1",
      "revoke write grant for spawn item 1",
      "restore child prompt for spawn item 1",
      "revoke write grant for spawn item 2",
      "retract unwitnessed review run run.spawn-claims",
      `remove active roster entry ${rosterId(1)}`,
      `remove active roster entry ${rosterId(0)}`,
      "roll back task-graph pointer",
    ]);
  });

  it("plans nothing for a batch that claimed nothing", () => {
    expect(planSpawnRollback(NO_SPAWN_CLAIMS)).toEqual([]);
  });

  it("restores a prompt exactly when its grant was injected, and records claims immutably", () => {
    const before = value(claimWriteGrant(NO_SPAWN_CLAIMS, { slot: 2, token: "t" }));
    const after = value(claimGrantInjection(before, { slot: 2, originalTask: "orig" }));
    expect(before.promptRewrites).toEqual([]);
    expect(after.promptRewrites).toEqual([{ slot: 2, originalTask: "orig" }]);
    expect(planSpawnRollback(before).map(({ kind }) => kind)).toEqual(["revoke-grant"]);
    expect(planSpawnRollback(after).map(({ kind }) => kind)).toEqual(["revoke-grant", "restore-prompt"]);
    expect(Object.isFrozen(after) && Object.isFrozen(after.grants) && Object.isFrozen(after.promptRewrites)).toBe(true);
  });
});

describe("the ledger is total", () => {
  it("refuses a second grant for a slot, so it can never owe one of two tokens", () => {
    const claims = value(claimWriteGrant(NO_SPAWN_CLAIMS, { slot: 0, token: "first" }));
    expect(claimWriteGrant(claims, { slot: 0, token: "second" })).toEqual({
      ok: false,
      error: "spawn item 1 already holds a claimed write grant",
    });
  });

  it("refuses an injection for a slot with no claimed grant, or one already injected", () => {
    expect(claimGrantInjection(NO_SPAWN_CLAIMS, { slot: 3, originalTask: "orig" })).toEqual({
      ok: false,
      error: "spawn item 4 has no claimed write grant to inject",
    });
    const injected = value(claimGrantInjection(
      value(claimWriteGrant(NO_SPAWN_CLAIMS, { slot: 3, token: "t" })),
      { slot: 3, originalTask: "orig" },
    ));
    expect(claimGrantInjection(injected, { slot: 3, originalTask: "orig" })).toEqual({
      ok: false,
      error: "spawn item 4 already carries its injected write grant",
    });
  });

  it("plans one restore per injected grant, for any order of grant and injection claims", () => {
    fc.assert(fc.property(
      fc.uniqueArray(fc.nat({ max: 7 }), { maxLength: 6 }),
      fc.array(fc.nat({ max: 7 }), { maxLength: 10 }),
      (grantSlots, injectionSlots) => {
        let claims = NO_SPAWN_CLAIMS;
        for (const slot of grantSlots) claims = value(claimWriteGrant(claims, { slot, token: `t${slot}` }));
        const injected = new Set<number>();
        for (const slot of injectionSlots) {
          const claimed = claimGrantInjection(claims, { slot, originalTask: `orig ${slot}` });
          expect(claimed.ok).toBe(grantSlots.includes(slot) && !injected.has(slot));
          if (claimed.ok) {
            claims = claimed.value;
            injected.add(slot);
          }
        }
        const restores = planSpawnRollback(claims).flatMap((step) => step.kind === "restore-prompt" ? [step.slot] : []);
        expect(restores.sort()).toEqual([...injected].sort());
      },
    ));
  });
});

describe("releaseSpawnClaims and remainingSpawnDebt", () => {
  it("releases everything and owes nothing when every port succeeds", async () => {
    const claims = fullClaims();
    const { ports, calls } = fakePorts();
    const { errors, releases } = await releaseSpawnClaims(claims, admissionLabel, ports);
    expect(errors).toEqual([]);
    expect(calls).toEqual([
      "removeEmissionLaunches",
      "revokeGrant:token-0",
      "restorePrompt:0:Task ID: T1",
      "revokeGrant:token-1",
      "retractWitnessRun:run.spawn-claims",
      `removeRosterEntry:${rosterId(1)}`,
      `removeRosterEntry:${rosterId(0)}`,
      "releasePointer",
    ]);
    expect(remainingSpawnClaims(claims, releases)).toEqual(NO_SPAWN_CLAIMS);
    const debt = remainingSpawnDebt(claims, releases, debtContext);
    expect(debt.grants).toEqual([]);
    expect(debt.reservation).toEqual({ ...debtContext, pointerBinding: null, items: [] });
  });

  it("attempts every step after a failure and retains exactly what was not released", async () => {
    const claims = fullClaims();
    const { ports, calls } = fakePorts(new Set<Port>(["removeEmissionLaunches", "revokeGrant", "removeRosterEntry"]));
    const { errors, releases } = await releaseSpawnClaims(claims, admissionLabel, ports);
    expect(calls).toHaveLength(8);
    expect(errors).toEqual([
      "remove emission launch capabilities for call-1: removeEmissionLaunches unavailable",
      "revoke write grant for spawn item 1: revokeGrant unavailable",
      "revoke write grant for spawn item 2: revokeGrant unavailable",
      `remove active roster entry ${rosterId(1)}: removeRosterEntry unavailable`,
      `remove active roster entry ${rosterId(0)}: removeRosterEntry unavailable`,
    ]);
    const debt = remainingSpawnDebt(claims, releases, debtContext);
    expect(debt.grants).toEqual([{ slot: 0, token: "token-0" }, { slot: 1, token: "token-1" }]);
    expect(debt.reservation.items).toEqual([rosterItem(0), rosterItem(1)]);
    expect(debt.reservation.pointerBinding).toBeNull();
  });

  it("keeps the pointer lease as debt when its exact ownership was lost", async () => {
    const claims = claimPointerLease(NO_SPAWN_CLAIMS, pointer);
    const { ports } = fakePorts(new Set(), "not-owned");
    const { errors, releases } = await releaseSpawnClaims(claims, admissionLabel, ports);
    expect(errors).toEqual(["roll back task-graph pointer: exact pointer ownership lost (not-owned)"]);
    expect(remainingSpawnDebt(claims, releases, debtContext).reservation.pointerBinding).toBe(pointer);
  });

  it("owes exactly the claims whose release failed, for any failure pattern", async () => {
    await fc.assert(fc.asyncProperty(
      fc.subarray([...PORTS]),
      async (failingPorts) => {
        const failing = new Set<Port>(failingPorts);
        const claims = fullClaims();
        const { releases } = await releaseSpawnClaims(claims, admissionLabel, fakePorts(failing).ports);
        const owed = remainingSpawnClaims(claims, releases);
        expect(owed.emissionLaunchesStaged).toBe(failing.has("removeEmissionLaunches"));
        expect(owed.grants.map(({ token }) => token)).toEqual(failing.has("revokeGrant") ? ["token-0", "token-1"] : []);
        expect(owed.promptRewrites.map(({ slot }) => slot)).toEqual(failing.has("restorePrompt") ? [0] : []);
        expect(owed.witnessRun).toBe(failing.has("retractWitnessRun") ? witnessRun : null);
        expect(owed.roster).toEqual(failing.has("removeRosterEntry") ? [rosterItem(0), rosterItem(1)] : []);
        expect(owed.pointer).toBe(failing.has("releasePointer") ? pointer : null);
        // A second release of what is still owed, with every port healthy,
        // owes nothing: the debt names exactly what remains to release.
        const retried = await releaseSpawnClaims(owed, admissionLabel, fakePorts().ports);
        expect(remainingSpawnClaims(owed, retried.releases)).toEqual(NO_SPAWN_CLAIMS);
      },
    ));
  });
});

describe("settlement through the same ledger", () => {
  const reservation: PiSpawnReservation = Object.freeze({
    ...debtContext,
    pointerBinding: pointer,
    items: Object.freeze([rosterItem(0), rosterItem(1)]),
  });
  const grants = Object.freeze([{ slot: 1, token: "token-1" }]);
  const owner = { sessionId, toolCallId: "call-1" } as const;
  const settlementLabel = (step: Parameters<typeof spawnRollbackStepLabel>[0]) => spawnSettlementStepLabel(step, owner);

  it("holds a dispatched batch's committed grants, roster entries and pointer lease, and nothing process-local", () => {
    expect(settledSpawnClaims(grants, reservation)).toEqual({
      ...NO_SPAWN_CLAIMS,
      grants,
      roster: reservation.items,
      pointer,
    });
    expect(settledSpawnClaims([], undefined)).toEqual(NO_SPAWN_CLAIMS);
  });

  it("releases capabilities before results and the pointer lease last, keeping the lease owed in between", async () => {
    const held = settledSpawnClaims(grants, reservation);
    const first = fakePorts();
    const capabilities = await releaseSpawnClaims(withoutPointerLease(held), settlementLabel, first.ports);
    expect(first.calls).toEqual([
      "revokeGrant:token-1",
      `removeRosterEntry:${rosterId(1)}`,
      `removeRosterEntry:${rosterId(0)}`,
    ]);
    const owedBetween = remainingSpawnClaims(held, capabilities.releases);
    expect(spawnDebtOf(owedBetween, reservation)).toEqual({
      grants: [],
      reservation: { ...debtContext, pointerBinding: pointer, items: [] },
    });
    const last = fakePorts();
    const lease = await releaseSpawnClaims(pointerLeaseOnly(owedBetween), settlementLabel, last.ports);
    expect(last.calls).toEqual(["releasePointer"]);
    expect(remainingSpawnClaims(owedBetween, lease.releases)).toEqual(NO_SPAWN_CLAIMS);
  });

  it("names settlement failures in the settlement vocabulary and retains them as debt", async () => {
    const held = settledSpawnClaims(grants, reservation);
    const { errors, releases } = await releaseSpawnClaims(
      held,
      settlementLabel,
      fakePorts(new Set<Port>(["revokeGrant", "removeRosterEntry", "releasePointer"])).ports,
    );
    expect(errors).toEqual([
      "revoke write grant for spawn item 2: revokeGrant unavailable",
      "remove reserved roster entry for code-implementer-agent: removeRosterEntry unavailable",
      "remove reserved roster entry for code-implementer-agent: removeRosterEntry unavailable",
      `release parent task-graph pointer lease for ${sessionId}: releasePointer unavailable`,
    ]);
    expect(spawnDebtOf(remainingSpawnClaims(held, releases), reservation)).toEqual({ grants, reservation });
  });
});
