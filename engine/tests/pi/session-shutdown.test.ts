/**
 * Pi session shutdown releases every capability even when one release fails:
 * the staged-emission-launch removal is one labelled cleanup action among the
 * write-grant revocations, never a step whose throw skips them. Each tool
 * call's held claims are released through the settlement path — one order,
 * one set of durable ports, one remaining-debt rule — and a reservation
 * naming another session is left as reported debt, never released. The
 * session's child write-grant binding is released by the same ledger.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { canonicalTempDir } from "../fixtures/canonical-temp-dir";
import { recordingDurableReleases } from "../fixtures/recording-durable-releases";
import {
  HELD_GRANT,
  inertEmissionLaunchBridge,
  parentSessionsHoldingActive,
  reviewerReservationNaming,
  settleEmptyBatch,
} from "../fixtures/held-spawn-batch";
import { fsSessionRegistry, parseAgentId, parseSessionId, type SessionTaskGraphPointerBinding } from "../../src/machine";
import { shutdownPiSession, type PiSessionShutdownPorts } from "../../../pi/session-shutdown";
import { piDurableClaimReleasePorts } from "../../../pi/spawn-claim-shell";
import {
  createPiParentSessions,
  type PiParentSessions,
  type PiSessionId,
  type PiSpawnReservation,
} from "../../../pi/spawn-reservation";
import { createPiChildWriteGrants } from "../../../pi/child-write-grant";
import { issuePiWriteGrant } from "../../../pi/write-grant";
import type { PiEmissionLaunchBridge } from "../../../pi/emission-launch-bridge";
import { createTrustedReviewWitnesses } from "../../../pi/trusted-review-witness";

let root: string;
let priorSubagentDir: string | undefined;

beforeEach(() => {
  root = canonicalTempDir("loom-pi-session-shutdown-");
  priorSubagentDir = process.env.LOOM_SUBAGENT_DIR;
  process.env.LOOM_SUBAGENT_DIR = join(root, "subagents");
});

afterEach(() => {
  vi.restoreAllMocks();
  if (priorSubagentDir === undefined) delete process.env.LOOM_SUBAGENT_DIR;
  else process.env.LOOM_SUBAGENT_DIR = priorSubagentDir;
  rmSync(root, { recursive: true, force: true });
});

const unused = (port: string) => (): never => {
  throw new Error(`${port} is not part of session shutdown`);
};

/** A bridge whose session removal fails: the one capability release under test. */
const failingBridge = (removed: string[]): PiEmissionLaunchBridge => ({
  probe: unused("probe"),
  stage: unused("stage"),
  removeToolCall: unused("removeToolCall"),
  removeSession: (sessionId) => {
    removed.push(sessionId);
    throw new Error("launch bridge unavailable");
  },
});

const grantFiles = (): readonly string[] => {
  const directory = join(root, "subagents", "pi-write-grants");
  return existsSync(directory) ? readdirSync(directory) : [];
};

describe("shutdownPiSession", () => {
  it("still revokes every write grant when removing staged emission launches throws, and reports that failure", async () => {
    const cwd = join(root, "project");
    const graph = join(cwd, ".claude", "state", "active_task_graph.json");
    mkdirSync(join(cwd, ".claude", "state"), { recursive: true });
    writeFileSync(graph, "{}\n");
    const sessionId = parseSessionId("parent-session");
    if (sessionId === null) throw new Error("fixture session id must parse");

    const parentSessions = createPiParentSessions();
    const issue = (slot: number, taskId: string) => Object.freeze({
      slot,
      token: issuePiWriteGrant({ agent: "code-implementer-agent", taskId, cwd, taskGraphPath: graph }).token,
    });
    parentSessions.runtimeFor(sessionId).issuedWriteGrants.set("call-1", Object.freeze([issue(0, "T1"), issue(1, "T2")]));
    expect(grantFiles()).toHaveLength(2);

    const removed: string[] = [];
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const failure = "remove staged emission launches for parent-session: launch bridge unavailable";

    await expect(shutdownPiSession("parent-session", {
      parentSessions,
      childWriteGrants: createPiChildWriteGrants(),
      emissionLaunchBridge: failingBridge(removed),
      reviewWitnesses: createTrustedReviewWitnesses(),
      durableClaimReleases: piDurableClaimReleasePorts,
    })).rejects.toThrow(`Loom Pi session shutdown cleanup failed: ${failure}`);

    expect(removed).toEqual(["parent-session"]);
    // The later revocations ran: both grant files are gone, and the session
    // holds no remaining grant debt.
    expect(grantFiles()).toEqual([]);
    expect(parentSessions.get(sessionId)).toBeUndefined();
    expect(stderr).toHaveBeenCalledWith(`loom(pi): shutdown cleanup failed: ${failure}\n`);
  });

  it("prunes exactly this session from the injected review witness aggregate", async () => {
    const forgotten: string[] = [];
    const witnesses = { ...createTrustedReviewWitnesses(), forget: (session: string) => { forgotten.push(session); } };
    await shutdownPiSession("parent-session", {
      parentSessions: createPiParentSessions(),
      childWriteGrants: createPiChildWriteGrants(),
      emissionLaunchBridge: { ...failingBridge([]), removeSession: () => undefined },
      reviewWitnesses: witnesses,
      durableClaimReleases: piDurableClaimReleasePorts,
    });
    expect(forgotten).toEqual(["parent-session"]);
  });
});

describe("shutdownPiSession releases through the settlement path", () => {
  const owner = parseSessionId("shutdown-owner")!;
  const otherSession = parseSessionId("shutdown-other")!;
  const toolCallId = "call-shutdown-1";
  const rosterIds = [0, 1].map((slot) => parseAgentId(`pi-shutdown-roster-${slot}`)!);
  /** A lease never written to disk: its release resolves without I/O. */
  const LEASE = Object.freeze({
    directory: "/off-disk",
    pointerName: "off-disk.task_graph",
    registryName: "off-disk.registry",
    target: "/off-disk/graph.json",
    generationId: "off-disk-generation",
    leaseId: "off-disk-lease",
  }) as unknown as SessionTaskGraphPointerBinding;

  /** An ad-hoc two-reviewer reservation naming `sessionId`, holding `LEASE`. */
  const reservationNaming = (sessionId: PiSessionId): PiSpawnReservation =>
    reviewerReservationNaming(sessionId, rosterIds, LEASE);

  /** The owner session holding `reservation` and one grant for the tool call,
   *  with both roster entries marked active under the owner. */
  const ownerHolding = (reservation: PiSpawnReservation) => parentSessionsHoldingActive(owner, toolCallId, reservation);

  const shutdown = (
    parentSessions: PiParentSessions,
    durableClaimReleases: PiSessionShutdownPorts["durableClaimReleases"],
    childWriteGrants = createPiChildWriteGrants(),
  ) =>
    shutdownPiSession(owner, {
      parentSessions,
      childWriteGrants,
      emissionLaunchBridge: inertEmissionLaunchBridge,
      reviewWitnesses: createTrustedReviewWitnesses(),
      durableClaimReleases,
    });

  it("releases an owned reservation under the shutting-down session, owing nothing", async () => {
    const parentSessions = await ownerHolding(reservationNaming(owner));
    const releases = recordingDurableReleases(undefined, new Set([LEASE]));
    await shutdown(parentSessions, releases.durableClaimReleases);
    expect(releases.calls).toEqual([
      `revokeGrant:${HELD_GRANT.token}`,
      `removeRosterEntry:${rosterIds[1]}`,
      `removeRosterEntry:${rosterIds[0]}`,
      "releasePointer:off-disk-lease",
    ]);
    expect(fsSessionRegistry.readActiveRoster(owner)).toEqual([]);
    expect(parentSessions.get(owner)).toBeUndefined();
  });

  it("leaves a reservation naming another session as debt, releasing nothing of it under either session", async () => {
    const foreign = reservationNaming(otherSession);
    const parentSessions = await ownerHolding(foreign);
    await fsSessionRegistry.markActive(otherSession, rosterIds[0]!);
    const releases = recordingDurableReleases(undefined, new Set([LEASE]));
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const refusal = `leave spawn reservation ${toolCallId} as cleanup debt: ` +
      `Pi spawn reservation names session ${otherSession}, not its owner session ${owner}`;
    await expect(shutdown(parentSessions, releases.durableClaimReleases))
      .rejects.toThrow(`Loom Pi session shutdown cleanup failed: ${refusal}`);
    // Only the grant, which the session owns whatever the reservation says.
    expect(releases.calls).toEqual([`revokeGrant:${HELD_GRANT.token}`]);
    expect(fsSessionRegistry.readActiveRoster(owner)).toEqual(rosterIds);
    expect(fsSessionRegistry.readActiveRoster(otherSession)).toEqual([rosterIds[0]]);
    expect(parentSessions.get(owner)?.spawnReservations.get(toolCallId)).toBe(foreign);
    expect(parentSessions.get(owner)?.issuedWriteGrants.has(toolCallId)).toBe(false);
    expect(stderr).toHaveBeenCalledWith(`loom(pi): shutdown cleanup failed: ${refusal}\n`);
  });

  it("releases a held batch in exactly the order, through exactly the ports, settlement does", async () => {
    const settled = recordingDurableReleases(undefined, new Set([LEASE]));
    const settledSessions = await ownerHolding(reservationNaming(owner));
    expect(await settleEmptyBatch(owner, toolCallId, {
      parentSessions: settledSessions,
      emissionLaunchBridge: inertEmissionLaunchBridge,
      reviewWitnesses: createTrustedReviewWitnesses(),
      durableClaimReleases: settled.durableClaimReleases,
    })).toBeUndefined();

    const shut = recordingDurableReleases(undefined, new Set([LEASE]));
    await shutdown(await ownerHolding(reservationNaming(owner)), shut.durableClaimReleases);

    expect(shut.calls).toEqual(settled.calls);
    expect(shut.calls).toHaveLength(4);
  });

  it("keeps exactly the failed releases as debt and retries only those at the next shutdown", async () => {
    const parentSessions = await ownerHolding(reservationNaming(owner));
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const failing = recordingDurableReleases(
      (call) => call === `removeRosterEntry:${rosterIds[1]}` || call.startsWith("releasePointer:"),
      new Set([LEASE]),
    );
    await expect(shutdown(parentSessions, failing.durableClaimReleases)).rejects.toThrow(
      "Loom Pi session shutdown cleanup failed: remove shutdown roster entry for code-reviewer: removeRosterEntry unavailable; " +
        `release shutdown task-graph pointer lease for ${owner}: releasePointer unavailable`,
    );
    const owed = parentSessions.get(owner)?.spawnReservations.get(toolCallId);
    expect(owed?.items.map(({ rosterId }) => rosterId)).toEqual([rosterIds[1]]);
    expect(owed?.pointerBinding).toBe(LEASE);

    const healed = recordingDurableReleases(undefined, new Set([LEASE]));
    await shutdown(parentSessions, healed.durableClaimReleases);
    expect(healed.calls).toEqual([`removeRosterEntry:${rosterIds[1]}`, "releasePointer:off-disk-lease"]);
    expect(parentSessions.get(owner)).toBeUndefined();
  });

  describe("the session's child write-grant binding, released as a durable ledger", () => {
    const childId = parseAgentId("pi-shutdown-child")!;
    const boundChild = async () => {
      await fsSessionRegistry.markActive(owner, childId);
      const childWriteGrants = createPiChildWriteGrants();
      childWriteGrants.active.set(owner, { kind: "active", agentId: childId, pointerBinding: LEASE, scopeDirs: ["specs/"] });
      return childWriteGrants;
    };

    it("removes its roster entry, then releases its lease, and retires the binding", async () => {
      const childWriteGrants = await boundChild();
      const releases = recordingDurableReleases(undefined, new Set([LEASE]));
      await shutdown(createPiParentSessions(), releases.durableClaimReleases, childWriteGrants);
      expect(releases.calls).toEqual([`removeRosterEntry:${childId}`, "releasePointer:off-disk-lease"]);
      expect(fsSessionRegistry.readActiveRoster(owner)).toEqual([]);
      expect(childWriteGrants.active.has(owner)).toBe(false);
    });

    it("keeps exactly the failed release as the binding's pending authority and retries only it", async () => {
      const childWriteGrants = await boundChild();
      vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      const failing = recordingDurableReleases((call) => call.startsWith("releasePointer:"), new Set([LEASE]));
      await expect(shutdown(createPiParentSessions(), failing.durableClaimReleases, childWriteGrants)).rejects.toThrow(
        `Loom Pi session shutdown cleanup failed: roll back child task-graph pointer for ${owner}: releasePointer unavailable`,
      );
      expect(childWriteGrants.active.get(owner)).toEqual({
        kind: "pointer-cleanup-pending", agentId: null, pointerBinding: LEASE, scopeDirs: ["specs/"],
      });

      const healed = recordingDurableReleases(undefined, new Set([LEASE]));
      await shutdown(createPiParentSessions(), healed.durableClaimReleases, childWriteGrants);
      expect(healed.calls).toEqual(["releasePointer:off-disk-lease"]);
      expect(childWriteGrants.active.has(owner)).toBe(false);
    });
  });
});
