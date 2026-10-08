/**
 * `tool_result` settlement against a reservation held in memory, outside
 * orchestration (no task graph, no run directory), over a temporary roster
 * directory: the reservation is parsed against the session that owns the
 * batch before any stage reads it, so roster entries are removed under one
 * session — and a reservation naming another session is refused as a
 * processing error rather than released under the wrong one.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { join } from "node:path";
import { rmSync } from "node:fs";
import { canonicalTempDir } from "../fixtures/canonical-temp-dir";
import {
  inertEmissionLaunchBridge,
  parentSessionsHoldingActive,
  reviewerReservationNaming,
  settleEmptyBatch,
} from "../fixtures/held-spawn-batch";
import { fsSessionRegistry, parseAgentId, parseSessionId } from "../../src/machine";
import type { PiSubagentStopPorts } from "../../../pi/subagent-stop";
import type { PiSpawnReservation } from "../../../pi/spawn-reservation";
import { createTrustedReviewWitnesses } from "../../../pi/trusted-review-witness";
import { piDurableClaimReleasePorts } from "../../../pi/spawn-claim-shell";

const ENV_KEYS = ["LOOM_SUBAGENT_DIR", "LOOM_ORCHESTRATION_RUNS_ROOT", "LOOM_ORCHESTRATION_RUN_DIR"] as const;
let root: string;
let previous: ReadonlyArray<readonly [string, string | undefined]>;

beforeEach(() => {
  root = canonicalTempDir("loom-pi-subagent-stop-");
  previous = ENV_KEYS.map((key) => [key, process.env[key]] as const);
  process.env.LOOM_SUBAGENT_DIR = join(root, "subagents");
  delete process.env.LOOM_ORCHESTRATION_RUNS_ROOT;
  delete process.env.LOOM_ORCHESTRATION_RUN_DIR;
});

afterEach(() => {
  for (const [key, value] of previous) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(root, { recursive: true, force: true });
});

const owner = parseSessionId("subagent-stop-owner")!;
const otherSession = parseSessionId("subagent-stop-other")!;
const toolCallId = "call-stop-1";
const rosterId = parseAgentId("pi-subagent-stop-roster-0")!;

/** An ad-hoc reservation of one reviewer slot with no Task identity, naming
 *  `sessionId`: nothing in it is gate-owned, so settlement only releases. */
const reservationNaming = (sessionId: typeof owner): PiSpawnReservation =>
  reviewerReservationNaming(sessionId, [rosterId], null);

/** The owner session holding `reservation` (and one grant) for the tool
 *  call, with its roster entry marked active under the owner. */
const ownerHolding = async (reservation: PiSpawnReservation) => {
  const parentSessions = await parentSessionsHoldingActive(owner, toolCallId, reservation);
  const ports: PiSubagentStopPorts = {
    parentSessions,
    emissionLaunchBridge: inertEmissionLaunchBridge,
    reviewWitnesses: createTrustedReviewWitnesses(),
    durableClaimReleases: piDurableClaimReleasePorts,
  };
  return { parentSessions, ports };
};

const settle = (ports: PiSubagentStopPorts) => settleEmptyBatch(owner, toolCallId, ports);

describe("dispatchPiSubagentStop — the reservation is owned before it is settled", () => {
  it("settles a reservation naming its owner, removing its roster entry under the owner and owing nothing", async () => {
    const { parentSessions, ports } = await ownerHolding(reservationNaming(owner));
    expect(await settle(ports)).toBeUndefined();
    expect(fsSessionRegistry.readActiveRoster(owner)).toEqual([]);
    expect(parentSessions.get(owner)).toBeUndefined();
  });

  it("refuses a reservation naming another session, releasing only its grants and keeping it as session debt", async () => {
    const divergent = reservationNaming(otherSession);
    const { parentSessions, ports } = await ownerHolding(divergent);
    expect(await settle(ports)).toEqual({
      content: [{
        type: "text",
        text: "Loom Pi subagent evidence processing failed:\n" +
          `- Pi spawn reservation names session ${otherSession}, not its owner session ${owner}`,
      }],
      isError: true,
    });
    // Nothing of the divergent reservation was released under the owner: its
    // roster entry stays active, and the reservation stays for shutdown.
    expect(fsSessionRegistry.readActiveRoster(owner)).toEqual([rosterId]);
    expect(parentSessions.get(owner)?.spawnReservations.get(toolCallId)).toBe(divergent);
    // Revoking a grant is owed whatever the reservation says.
    expect(parentSessions.get(owner)?.issuedWriteGrants.has(toolCallId)).toBe(false);
  });
});
