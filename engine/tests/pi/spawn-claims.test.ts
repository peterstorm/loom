/**
 * The spawn claims ledger: what an admission-time refusal must release, in
 * which order, and exactly what stays as cleanup debt when a release fails —
 * all against plain in-memory release ports, no session registry or pointer
 * lease on disk.
 */

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  claimEmissionLaunches,
  claimGrantInjection,
  claimPointerLease,
  claimRosterEntry,
  claimWriteGrant,
  NO_SPAWN_CLAIMS,
  planSpawnRollback,
  releaseSpawnClaims,
  remainingSpawnDebt,
  spawnRollbackStepLabel,
  type SpawnClaimReleasePorts,
  type SpawnClaims,
} from "../../../pi/spawn-claims";
import { legacyReservationItem } from "../../../pi/spawn-reservation";
import { parseAgentId, parseSessionId, type SessionTaskGraphPointerBinding } from "../../src/machine";
import type { AgentId } from "../../src/machine/evidence";

const sessionId = parseSessionId("spawn-claims-session")!;
const pointer = { directory: "/state", pointerName: "p", registryName: "r", target: "/graph.json" } as unknown as SessionTaskGraphPointerBinding;
const rosterId = (slot: number): AgentId => parseAgentId(`pi-spawn-claims-${slot}`)!;
const rosterItem = (slot: number) =>
  legacyReservationItem({ rosterId: rosterId(slot), emissionLaunch: null, kind: "implementation" }, "code-implementer-agent", `T${slot + 1}`);
const debtContext = {
  sessionId,
  needsTaskGraphLifecycle: true,
  graphActiveAtSpawn: true,
  orchestrationRunBinding: null,
} as const;

/** A two-slot batch that claimed everything: roster, pointer, both grants
 *  (slot 0 injected), and staged launches. */
const fullClaims = (): SpawnClaims => {
  let claims = claimRosterEntry(NO_SPAWN_CLAIMS, rosterItem(0));
  claims = claimRosterEntry(claims, rosterItem(1));
  claims = claimPointerLease(claims, pointer);
  claims = claimWriteGrant(claims, { slot: 0, token: "token-0", originalTask: "Task ID: T1" });
  claims = claimWriteGrant(claims, { slot: 1, token: "token-1", originalTask: "Task ID: T2" });
  claims = claimGrantInjection(claims, 0);
  return claimEmissionLaunches(claims);
};

type Port = keyof SpawnClaimReleasePorts;

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
    removeRosterEntry: async (agentId) => { calls.push(`removeRosterEntry:${agentId}`); fail("removeRosterEntry"); },
    releasePointer: async () => { calls.push("releasePointer"); fail("releasePointer"); return pointerResult; },
  };
  return { ports, calls };
};

describe("planSpawnRollback", () => {
  it("releases capabilities first, roster entries newest-first, and the pointer lease last", () => {
    expect(planSpawnRollback(fullClaims()).map((step) => spawnRollbackStepLabel(step, "call-1"))).toEqual([
      "remove emission launch capabilities for call-1",
      "revoke write grant for spawn item 1",
      "restore child prompt for spawn item 1",
      "revoke write grant for spawn item 2",
      `remove active roster entry ${rosterId(1)}`,
      `remove active roster entry ${rosterId(0)}`,
      "roll back task-graph pointer",
    ]);
  });

  it("plans nothing for a batch that claimed nothing", () => {
    expect(planSpawnRollback(NO_SPAWN_CLAIMS)).toEqual([]);
  });

  it("restores a prompt exactly when its grant was injected, and records claims immutably", () => {
    const before = claimWriteGrant(NO_SPAWN_CLAIMS, { slot: 2, token: "t", originalTask: "orig" });
    const after = claimGrantInjection(before, 2);
    expect(before.grants[0]?.injected).toBe(false);
    expect(after.grants[0]?.injected).toBe(true);
    expect(planSpawnRollback(before).map(({ kind }) => kind)).toEqual(["revoke-grant"]);
    expect(planSpawnRollback(after).map(({ kind }) => kind)).toEqual(["revoke-grant", "restore-prompt"]);
    expect(Object.isFrozen(after) && Object.isFrozen(after.grants)).toBe(true);
  });
});

describe("releaseSpawnClaims and remainingSpawnDebt", () => {
  it("releases everything and owes nothing when every port succeeds", async () => {
    const claims = fullClaims();
    const { ports, calls } = fakePorts();
    const { errors, releases } = await releaseSpawnClaims(claims, "call-1", ports);
    expect(errors).toEqual([]);
    expect(calls).toEqual([
      "removeEmissionLaunches",
      "revokeGrant:token-0",
      "restorePrompt:0:Task ID: T1",
      "revokeGrant:token-1",
      `removeRosterEntry:${rosterId(1)}`,
      `removeRosterEntry:${rosterId(0)}`,
      "releasePointer",
    ]);
    const debt = remainingSpawnDebt(claims, releases, debtContext);
    expect(debt.grantTokens).toEqual([]);
    expect(debt.reservation).toEqual({ ...debtContext, pointerBinding: null, items: [] });
  });

  it("attempts every step after a failure and retains exactly what was not released", async () => {
    const claims = fullClaims();
    const { ports, calls } = fakePorts(new Set<Port>(["removeEmissionLaunches", "revokeGrant", "removeRosterEntry"]));
    const { errors, releases } = await releaseSpawnClaims(claims, "call-1", ports);
    expect(calls).toHaveLength(7);
    expect(errors).toEqual([
      "remove emission launch capabilities for call-1: removeEmissionLaunches unavailable",
      "revoke write grant for spawn item 1: revokeGrant unavailable",
      "revoke write grant for spawn item 2: revokeGrant unavailable",
      `remove active roster entry ${rosterId(1)}: removeRosterEntry unavailable`,
      `remove active roster entry ${rosterId(0)}: removeRosterEntry unavailable`,
    ]);
    const debt = remainingSpawnDebt(claims, releases, debtContext);
    expect(debt.grantTokens).toEqual(["token-0", "token-1"]);
    expect(debt.reservation.items).toEqual([rosterItem(0), rosterItem(1)]);
    expect(debt.reservation.pointerBinding).toBeNull();
  });

  it("keeps the pointer lease as debt when its exact ownership was lost", async () => {
    const claims = claimPointerLease(NO_SPAWN_CLAIMS, pointer);
    const { ports } = fakePorts(new Set(), "not-owned");
    const { errors, releases } = await releaseSpawnClaims(claims, "call-1", ports);
    expect(errors).toEqual(["roll back task-graph pointer: exact pointer ownership lost (not-owned)"]);
    expect(remainingSpawnDebt(claims, releases, debtContext).reservation.pointerBinding).toBe(pointer);
  });

  it("owes exactly the claims whose release failed, for any failure pattern", async () => {
    await fc.assert(fc.asyncProperty(
      fc.subarray(["removeEmissionLaunches", "revokeGrant", "restorePrompt", "removeRosterEntry", "releasePointer"] as const),
      async (failingPorts) => {
        const failing = new Set<Port>(failingPorts);
        const claims = fullClaims();
        const { releases } = await releaseSpawnClaims(claims, "call-1", fakePorts(failing).ports);
        const debt = remainingSpawnDebt(claims, releases, debtContext);
        expect(debt.grantTokens).toEqual(failing.has("revokeGrant") ? ["token-0", "token-1"] : []);
        expect(debt.reservation.items).toEqual(failing.has("removeRosterEntry") ? [rosterItem(0), rosterItem(1)] : []);
        expect(debt.reservation.pointerBinding).toBe(failing.has("releasePointer") ? pointer : null);
      },
    ));
  });
});
