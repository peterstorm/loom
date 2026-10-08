/**
 * A dispatched Pi spawn batch a parent session still holds, as the
 * settlement, shutdown, ledger-shell and lifecycle suites seed it: an ad-hoc
 * reviewer reservation, one committed (never issued) write grant, an inert
 * emission launch bridge, and the empty `tool_result` that settles the batch.
 */

import type { ToolResultEvent } from "@earendil-works/pi-coding-agent";
import { fsSessionRegistry, type SessionTaskGraphPointerBinding } from "../../src/machine";
import type { AgentId } from "../../src/machine/evidence";
import type { PiEmissionLaunchBridge } from "../../../pi/emission-launch-bridge";
import { dispatchPiSubagentStop, type PiSubagentStopPorts } from "../../../pi/subagent-stop";
import {
  createPiParentSessions,
  legacyReservationItem,
  type PiIssuedWriteGrant,
  type PiParentSessions,
  type PiSessionId,
  type PiSpawnReservation,
} from "../../../pi/spawn-reservation";

/** The one grant a held batch committed: never issued, so its revocation
 *  touches no grant record. */
export const HELD_GRANT: PiIssuedWriteGrant = Object.freeze({ slot: 0, token: "unissued-token" });

/**
 * An ad-hoc reservation naming `sessionId` — no task graph, no run binding —
 * of one Task-less `code-reviewer` slot per roster id, holding `pointer`.
 * Nothing in it is gate-owned, so settling it only releases.
 */
export const reviewerReservationNaming = (
  sessionId: PiSessionId,
  rosterIds: readonly AgentId[],
  pointer: SessionTaskGraphPointerBinding | null,
): PiSpawnReservation => Object.freeze({
  sessionId,
  needsTaskGraphLifecycle: false,
  graphActiveAtSpawn: false,
  orchestrationRunBinding: null,
  pointerBinding: pointer,
  items: Object.freeze(rosterIds.map((rosterId) =>
    legacyReservationItem({ rosterId, emissionLaunch: null, kind: "non-implementation" }, "code-reviewer", null))),
});

/** Parent sessions where `owner` holds `reservation` and `HELD_GRANT` for
 *  `toolCallId`, whatever session the reservation names. */
export function parentSessionsHolding(
  owner: PiSessionId,
  toolCallId: string,
  reservation: PiSpawnReservation,
): PiParentSessions {
  const parentSessions = createPiParentSessions();
  const runtime = parentSessions.runtimeFor(owner);
  runtime.spawnReservations.set(toolCallId, reservation);
  runtime.issuedWriteGrants.set(toolCallId, Object.freeze([HELD_GRANT]));
  return parentSessions;
}

/** `parentSessionsHolding`, with every reserved roster entry marked active
 *  under `owner` in the real session registry. */
export async function parentSessionsHoldingActive(
  owner: PiSessionId,
  toolCallId: string,
  reservation: PiSpawnReservation,
): Promise<PiParentSessions> {
  const parentSessions = parentSessionsHolding(owner, toolCallId, reservation);
  for (const { rosterId } of reservation.items) await fsSessionRegistry.markActive(owner, rosterId);
  return parentSessions;
}

/** A launcher that is always available, stages everything, and removes
 *  nothing observable. */
export const inertEmissionLaunchBridge: PiEmissionLaunchBridge = Object.freeze({
  probe: () => ({ kind: "available" as const }),
  stage: () => ({ ok: true as const }),
  removeToolCall: () => undefined,
  removeSession: () => undefined,
});

/** Settle `toolCallId`'s batch on `sessionId` with an empty, well-formed
 *  `tool_result`: only the batch's held claims are released. */
export const settleEmptyBatch = (sessionId: string, toolCallId: string, ports: PiSubagentStopPorts) =>
  dispatchPiSubagentStop(
    { toolName: "subagent", toolCallId, input: {}, content: [], details: { results: [] }, isError: false } as
      unknown as ToolResultEvent,
    { sessionManager: { getSessionId: () => sessionId } },
    ports,
  );
