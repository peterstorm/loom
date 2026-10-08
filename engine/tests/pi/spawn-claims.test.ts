/**
 * The spawn claims ledger: what an admission-time refusal and a `tool_result`
 * settlement must release, in which order, and exactly what stays as cleanup
 * debt when a release fails — all against plain in-memory release ports, no
 * session registry or pointer lease on disk. The shell's parent-session
 * orchestrators (`pi/spawn-claim-shell.ts`) run against the same fakes.
 */

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  claimEmissionLaunches,
  claimGrantInjection,
  claimOrCompensate,
  claimPointerLease,
  claimRosterEntry,
  claimWitnessRun,
  claimWriteGrant,
  grantsOnly,
  NO_DURABLE_SPAWN_CLAIMS,
  NO_SPAWN_CLAIMS,
  orphanedOnRelease,
  planSpawnRollback,
  pointerLeaseOnly,
  recordSpawnClaim,
  releaseDurableSpawnClaims,
  releaseSpawnClaims,
  remainingDurableClaims,
  remainingSpawnClaims,
  remainingSpawnDebt,
  settledSpawnClaims,
  spawnDebtOf,
  spawnRollbackStepLabel,
  settlementReleasePhrasing,
  shutdownReleasePhrasing,
  unownedOnRefusal,
  withoutGrants,
  withoutPointerLease,
  type DurableClaimReleasePorts,
  type DurableSpawnClaims,
  type OrphanedSpawnClaim,
  type SpawnClaim,
  type SpawnClaimReleasePorts,
  type SpawnClaims,
} from "../../../pi/spawn-claims";
import { releaseHeldSpawnClaims, releaseOrphanedSpawnClaims } from "../../../pi/spawn-claim-shell";
import { createPiParentSessions, legacyReservationItem, type PiSpawnReservation } from "../../../pi/spawn-reservation";
import { HELD_GRANT, parentSessionsHolding, reviewerReservationNaming } from "../fixtures/held-spawn-batch";
import { parseAgentId, parseSessionId, type SessionTaskGraphPointerBinding } from "../../src/machine";
import type { AgentId } from "../../src/machine/evidence";
import type { SessionRunBinding } from "../../src/orchestration/session-run-bindings";
import { value } from "../fixtures/parse-result";

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

/** A two-slot batch that claimed everything: roster, pointer, a standalone
 *  witness run, both grants (slot 0 injected), and staged launches. */
const fullClaims = (): SpawnClaims => {
  let claims = value(claimRosterEntry(NO_SPAWN_CLAIMS, rosterItem(0)));
  claims = value(claimRosterEntry(claims, rosterItem(1)));
  claims = value(claimPointerLease(claims, pointer));
  claims = value(claimWitnessRun(claims, witnessRun));
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

/** The durable subset of `fakePorts`: what settlement and shutdown cross. */
const durablePorts = (failing: ReadonlySet<Port> = new Set()) => {
  const { ports: { revokeGrant, removeRosterEntry, releasePointer }, calls } = fakePorts(failing);
  const ports: DurableClaimReleasePorts = { revokeGrant, removeRosterEntry, releasePointer };
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

  it("refuses a second witness run or pointer lease rather than overwriting the first", () => {
    const witnessed = value(claimWitnessRun(NO_SPAWN_CLAIMS, witnessRun));
    const laterRun = { ...witnessRun, runId: "run.later" } as unknown as SessionRunBinding;
    expect(claimWitnessRun(witnessed, laterRun)).toEqual({
      ok: false,
      error: "spawn batch already holds claimed review run run.spawn-claims",
    });
    const leased = value(claimPointerLease(NO_SPAWN_CLAIMS, pointer));
    expect(claimPointerLease(leased, pointer)).toEqual({
      ok: false,
      error: "spawn batch already holds a claimed task-graph pointer lease",
    });
    // The refused claim leaves the first binding the one a release retracts.
    expect(planSpawnRollback(witnessed)).toEqual([{ kind: "retract-witness-run", binding: witnessRun }]);
  });

  it("refuses a second claim of one roster entry, so one removal can never discharge two claims", () => {
    const claimed = value(claimRosterEntry(NO_SPAWN_CLAIMS, rosterItem(0)));
    expect(claimRosterEntry(claimed, rosterItem(0))).toEqual({
      ok: false,
      error: `spawn batch already holds claimed roster entry ${rosterId(0)}`,
    });
    expect(value(claimRosterEntry(claimed, rosterItem(1))).roster).toEqual([rosterItem(0), rosterItem(1)]);
  });

  it("never refuses staged launches: their one release owes every staging", () => {
    const staged = value(recordSpawnClaim(NO_SPAWN_CLAIMS, { kind: "emission-launches" }));
    const restaged = value(recordSpawnClaim(staged, { kind: "emission-launches" }));
    expect(restaged).toEqual(staged);
    expect(planSpawnRollback(restaged)).toEqual([{ kind: "remove-emission-launches" }]);
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

describe("claimOrCompensate", () => {
  /** Each claim taken before it is recorded, with a ledger already holding
   *  one like it, and the release port call that compensates its refusal. */
  const takenClaims: ReadonlyArray<Readonly<{
    claim: SpawnClaim;
    held: SpawnClaims;
    refusal: string;
    compensation: string;
    failingPort: Port;
    failedStep: string;
    /** Whether a failed compensation leaves the capability as durable debt. */
    durable: boolean;
  }>> = [
    {
      claim: { kind: "pointer-lease", pointer },
      held: value(claimPointerLease(NO_SPAWN_CLAIMS, pointer)),
      refusal: "spawn batch already holds a claimed task-graph pointer lease",
      compensation: "releasePointer",
      failingPort: "releasePointer",
      failedStep: "roll back task-graph pointer: releasePointer unavailable",
      durable: true,
    },
    {
      claim: { kind: "witness-run", binding: { ...witnessRun, runId: "run.later" } as unknown as SessionRunBinding },
      held: value(claimWitnessRun(NO_SPAWN_CLAIMS, witnessRun)),
      refusal: "spawn batch already holds claimed review run run.spawn-claims",
      compensation: "retractWitnessRun:run.later",
      failingPort: "retractWitnessRun",
      failedStep: "retract unwitnessed review run run.later: retractWitnessRun unavailable",
      durable: false,
    },
    {
      claim: { kind: "write-grant", grant: { slot: 0, token: "second" } },
      held: value(claimWriteGrant(NO_SPAWN_CLAIMS, { slot: 0, token: "first" })),
      refusal: "spawn item 1 already holds a claimed write grant",
      compensation: "revokeGrant:second",
      failingPort: "revokeGrant",
      failedStep: "revoke write grant for spawn item 1: revokeGrant unavailable",
      durable: true,
    },
  ];
  const refused = (reason: string, orphaned: SpawnClaim | null = null) =>
    ({ ok: false, error: { reason, orphaned } });

  it("records an accepted claim and releases nothing", async () => {
    const { ports, calls } = fakePorts();
    const claimed = await claimOrCompensate(NO_SPAWN_CLAIMS, { kind: "pointer-lease", pointer }, admissionLabel, ports);
    expect(claimed).toEqual({ ok: true, value: value(claimPointerLease(NO_SPAWN_CLAIMS, pointer)) });
    expect(calls).toEqual([]);
  });

  it.each(takenClaims)("refuses a held $claim.kind and releases exactly the one it just took", async (taken) => {
    const { ports, calls } = fakePorts();
    expect(await claimOrCompensate(taken.held, taken.claim, admissionLabel, ports)).toEqual(refused(taken.refusal));
    expect(calls).toEqual([taken.compensation]);
  });

  it.each(takenClaims)("carries a failed compensation of a refused $claim.kind in its refusal", async (taken) => {
    const { ports, calls } = fakePorts(new Set([taken.failingPort]));
    expect(await claimOrCompensate(taken.held, taken.claim, admissionLabel, ports)).toEqual(refused(
      `${taken.refusal} Cleanup failures: ${taken.failedStep}`,
      // Only a durable capability is orphaned: a failed witness retraction is
      // process-local and discharged by shutdown's witness forget.
      taken.durable ? taken.claim : null,
    ));
    expect(calls).toEqual([taken.compensation]);
  });

  it("names a refused pointer lease whose exact ownership was already lost, and orphans it", async () => {
    const { ports } = fakePorts(new Set(), "not-owned");
    const claim: SpawnClaim = { kind: "pointer-lease", pointer };
    expect(await claimOrCompensate(takenClaims[0]!.held, claim, admissionLabel, ports)).toEqual(refused(
      "spawn batch already holds a claimed task-graph pointer lease " +
        "Cleanup failures: roll back task-graph pointer: exact pointer ownership lost (not-owned)",
      claim,
    ));
  });

  it("releases nothing for a refused claim recorded before its capability is taken", async () => {
    const { ports, calls } = fakePorts();
    const rostered = value(claimRosterEntry(NO_SPAWN_CLAIMS, rosterItem(0)));
    expect(await claimOrCompensate(rostered, { kind: "roster-entry", item: rosterItem(0) }, admissionLabel, ports))
      .toEqual(refused(`spawn batch already holds claimed roster entry ${rosterId(0)}`));
    expect(await claimOrCompensate(NO_SPAWN_CLAIMS, { kind: "grant-injection", rewrite: { slot: 2, originalTask: "t" } }, admissionLabel, ports))
      .toEqual(refused("spawn item 3 has no claimed write grant to inject"));
    expect(calls).toEqual([]);
  });

  it("compensates any refusal with exactly the release its capability would owe in a rollback", () => {
    // The compensation is the ledger's own plan for the refused capability:
    // a claim recorded after taking plans its one release step, a claim
    // recorded before taking plans none.
    const planned = (claim: SpawnClaim) => planSpawnRollback(unownedOnRefusal(claim)).map(({ kind }) => kind);
    expect(takenClaims.map(({ claim }) => planned(claim))).toEqual([["release-pointer"], ["retract-witness-run"], ["revoke-grant"]]);
    expect(planned({ kind: "roster-entry", item: rosterItem(0) })).toEqual([]);
    expect(planned({ kind: "grant-injection", rewrite: { slot: 0, originalTask: "t" } })).toEqual([]);
    expect(planned({ kind: "emission-launches" })).toEqual(["remove-emission-launches"]);
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
    const claims = value(claimPointerLease(NO_SPAWN_CLAIMS, pointer));
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
  const owner = { sessionId } as const;
  const settlementPhrasing = settlementReleasePhrasing(owner);

  /** Settlement's release ports: the durable three, and nothing a dispatched
   *  batch cannot hold. */
  it("holds a dispatched batch's committed grants, roster entries and pointer lease, and nothing process-local", () => {
    expect(settledSpawnClaims(grants, reservation)).toEqual({
      grants,
      roster: reservation.items,
      pointer,
    });
    expect(settledSpawnClaims([], undefined)).toEqual(NO_DURABLE_SPAWN_CLAIMS);
  });

  it("releases capabilities before results and the pointer lease last, keeping the lease owed in between", async () => {
    const held = settledSpawnClaims(grants, reservation);
    const first = durablePorts();
    const capabilities = await releaseDurableSpawnClaims(withoutPointerLease(held), settlementPhrasing, first.ports);
    expect(first.calls).toEqual([
      "revokeGrant:token-1",
      `removeRosterEntry:${rosterId(1)}`,
      `removeRosterEntry:${rosterId(0)}`,
    ]);
    const owedBetween = remainingDurableClaims(held, capabilities.releases);
    expect(spawnDebtOf(owedBetween, reservation)).toEqual({
      grants: [],
      reservation: { ...debtContext, pointerBinding: pointer, items: [] },
    });
    const last = durablePorts();
    const lease = await releaseDurableSpawnClaims(pointerLeaseOnly(owedBetween), settlementPhrasing, last.ports);
    expect(last.calls).toEqual(["releasePointer"]);
    expect(remainingDurableClaims(owedBetween, lease.releases)).toEqual(NO_DURABLE_SPAWN_CLAIMS);
  });

  it("names settlement failures in the settlement vocabulary and retains them as debt", async () => {
    const held = settledSpawnClaims(grants, reservation);
    const { errors, releases } = await releaseDurableSpawnClaims(
      held,
      settlementPhrasing,
      durablePorts(new Set<Port>(["revokeGrant", "removeRosterEntry", "releasePointer"])).ports,
    );
    expect(errors).toEqual([
      "revoke write grant for spawn item 2: revokeGrant unavailable",
      "remove reserved roster entry for code-implementer-agent: removeRosterEntry unavailable",
      "remove reserved roster entry for code-implementer-agent: removeRosterEntry unavailable",
      `release parent task-graph pointer lease for ${sessionId}: releasePointer unavailable`,
    ]);
    expect(spawnDebtOf(remainingDurableClaims(held, releases), reservation)).toEqual({ grants, reservation });
  });

  it("releases a durable ledger in exactly the order and with exactly the debt an admission rollback would", async () => {
    await fc.assert(fc.asyncProperty(
      fc.uniqueArray(fc.nat({ max: 3 }), { maxLength: 3 }),
      fc.nat({ max: 3 }),
      fc.boolean(),
      fc.subarray<Port>(["revokeGrant", "removeRosterEntry", "releasePointer"]),
      async (grantSlots, rosterSize, leased, failingPorts) => {
        const durable = Object.freeze({
          grants: grantSlots.map((slot) => ({ slot, token: `token-${slot}` })),
          roster: Array.from({ length: rosterSize }, (_, slot) => rosterItem(slot)),
          pointer: leased ? pointer : null,
        });
        const failing = new Set<Port>(failingPorts);
        const settlement = durablePorts(failing);
        const settled = await releaseDurableSpawnClaims(durable, settlementPhrasing, settlement.ports);
        const admission = fakePorts(failing);
        const rolledBack = await releaseSpawnClaims({ ...NO_SPAWN_CLAIMS, ...durable }, admissionLabel, admission.ports);
        expect(settlement.calls).toEqual(admission.calls);
        expect(settled.errors).toHaveLength(rolledBack.errors.length);
        expect(remainingDurableClaims(durable, settled.releases))
          .toEqual(remainingDurableClaims(durable, rolledBack.releases));
      },
    ));
  });
});

describe("orphaned claims: a failed compensation's capability as session debt", () => {
  const grantOrphan: OrphanedSpawnClaim = Object.freeze({ kind: "write-grant", grant: { slot: 2, token: "orphan" } });
  const leaseOrphan: OrphanedSpawnClaim = Object.freeze({ kind: "pointer-lease", pointer });

  it("orphans exactly a durable capability its release did not release", () => {
    const released = { revokedTokens: new Set(["orphan"]), removedRosterIds: new Set<AgentId>(), pointerReleased: true };
    const unreleased = { revokedTokens: new Set<string>(), removedRosterIds: new Set<AgentId>(), pointerReleased: false };
    expect([grantOrphan, leaseOrphan].map((claim) => orphanedOnRelease(claim, released))).toEqual([null, null]);
    expect([grantOrphan, leaseOrphan].map((claim) => orphanedOnRelease(claim, unreleased))).toEqual([grantOrphan, leaseOrphan]);
    expect(orphanedOnRelease({ kind: "witness-run", binding: witnessRun }, unreleased)).toBeNull();
    expect(orphanedOnRelease({ kind: "emission-launches" }, unreleased)).toBeNull();
  });

  it("retries every orphan, revocations first, and discharges the session once each is released", async () => {
    const parentSessions = createPiParentSessions();
    parentSessions.addOrphanedClaim(sessionId, leaseOrphan);
    parentSessions.addOrphanedClaim(sessionId, grantOrphan);
    const { ports, calls } = durablePorts();
    expect(await releaseOrphanedSpawnClaims(sessionId, parentSessions, ports)).toEqual([]);
    expect(calls).toEqual(["revokeGrant:orphan", "releasePointer"]);
    expect(parentSessions.get(sessionId)).toBeUndefined();
  });

  it("keeps an orphan whose retry fails, and releases it on a later pass", async () => {
    const parentSessions = createPiParentSessions();
    parentSessions.addOrphanedClaim(sessionId, grantOrphan);
    parentSessions.addOrphanedClaim(sessionId, leaseOrphan);
    const failing = durablePorts(new Set<Port>(["releasePointer"]));
    expect(await releaseOrphanedSpawnClaims(sessionId, parentSessions, failing.ports))
      .toEqual(["release orphaned task-graph pointer lease: releasePointer unavailable"]);
    expect([...parentSessions.get(sessionId)?.orphanedClaims ?? []]).toEqual([leaseOrphan]);

    const healed = durablePorts();
    expect(await releaseOrphanedSpawnClaims(sessionId, parentSessions, healed.ports)).toEqual([]);
    expect(healed.calls).toEqual(["releasePointer"]);
    expect(parentSessions.get(sessionId)).toBeUndefined();
  });
});

describe("releaseHeldSpawnClaims: one tool call's held claims on its session", () => {
  const holder = Object.freeze({ sessionId, toolCallId: "call-held" });
  const reservationNaming = (owner: typeof sessionId): PiSpawnReservation =>
    reviewerReservationNaming(owner, [rosterId(0), rosterId(1)], pointer);
  const holding = (reservation: PiSpawnReservation) => parentSessionsHolding(sessionId, holder.toolCallId, reservation);
  const label = shutdownReleasePhrasing(holder);
  const everything = (held: DurableSpawnClaims) => held;

  it("releases an owned reservation's grants, roster newest-first, then its lease, owing nothing", async () => {
    const parentSessions = holding(reservationNaming(sessionId));
    const { ports, calls } = durablePorts();
    expect(await releaseHeldSpawnClaims(holder, parentSessions, everything, label, ports))
      .toEqual({ errors: [], foreignReservation: null });
    expect(calls).toEqual([
      `revokeGrant:${HELD_GRANT.token}`,
      `removeRosterEntry:${rosterId(1)}`,
      `removeRosterEntry:${rosterId(0)}`,
      "releasePointer",
    ]);
    expect(parentSessions.get(sessionId)).toBeUndefined();
  });

  it("revokes the grants of a reservation naming another session but leaves the reservation as debt", async () => {
    const other = parseSessionId("spawn-claims-other")!;
    const foreign = reservationNaming(other);
    const parentSessions = holding(foreign);
    const { ports, calls } = durablePorts();
    expect(await releaseHeldSpawnClaims(holder, parentSessions, everything, label, ports)).toEqual({
      errors: [],
      foreignReservation: `Pi spawn reservation names session ${other}, not its owner session ${sessionId}`,
    });
    expect(calls).toEqual([`revokeGrant:${HELD_GRANT.token}`]);
    expect(parentSessions.get(sessionId)?.spawnReservations.get(holder.toolCallId)).toBe(foreign);
    expect(parentSessions.get(sessionId)?.issuedWriteGrants.has(holder.toolCallId)).toBe(false);
  });

  it("releases only what `select` picks and keeps the rest owed for the next pass", async () => {
    const parentSessions = holding(reservationNaming(sessionId));
    const first = durablePorts();
    await releaseHeldSpawnClaims(holder, parentSessions, grantsOnly, label, first.ports);
    expect(first.calls).toEqual([`revokeGrant:${HELD_GRANT.token}`]);
    const rest = durablePorts();
    await releaseHeldSpawnClaims(holder, parentSessions, withoutGrants, label, rest.ports);
    expect(rest.calls).toEqual([`removeRosterEntry:${rosterId(1)}`, `removeRosterEntry:${rosterId(0)}`, "releasePointer"]);
    expect(parentSessions.get(sessionId)).toBeUndefined();
  });
});
