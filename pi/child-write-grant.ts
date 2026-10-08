/**
 * Child write grants: the Pi child side of a scoped write capability.
 *
 * Each Pi subagent is a separate `pi --no-session` process. Parent-session
 * roster entries therefore cannot authorize child Edit/Write calls. A child
 * consumes the one-time capability injected into its own task and binds its
 * own session before the first model turn; a child whose grant was rejected
 * keeps direct edits blocked for the rest of its session. This module owns
 * that per-process registry, the activation, and both halves of the binding's
 * cleanup-authority lifecycle as pure decisions: what a rejected activation's
 * partial binding still owes (`rejectedChildWriteGrantDebt`), and a bound
 * binding's authority as a durable claims ledger (`childBindingClaims`) whose
 * release shutdown maps back to what the binding still owes
 * (`retainedChildWriteGrant`). The activation reaches the session registry,
 * the pointer lease and stderr only through `PiChildWriteGrantPorts`, so both
 * halves run against in-memory fakes.
 */

import type { BeforeAgentStartEventResult } from "@earendil-works/pi-coding-agent";
import {
  bindSessionTaskGraphPointer,
  fsSessionRegistry,
  parseAgentId,
  parseSessionId,
  type SessionId,
  type SessionTaskGraphPointerBinding,
} from "../engine/src/machine";
import type { AgentId } from "../engine/src/machine/evidence";
import { consumePiWriteGrant } from "./write-grant";
import { cleanupFailureSuffix, runPiCleanupActions } from "./cleanup-actions";
import type { DurableSpawnClaims, RosterClaim } from "./spawn-claims";

type ActiveChildWriteGrantScope = Readonly<{
  scopeDirs?: readonly string[];
  grantCwd?: string;
}>;

/** Scoped write policy plus exact outstanding child cleanup authority. */
export type ActiveChildWriteGrant = ActiveChildWriteGrantScope & (
  | Readonly<{ kind: "active"; agentId: AgentId; pointerBinding: SessionTaskGraphPointerBinding }>
  | Readonly<{ kind: "roster-cleanup-pending"; agentId: AgentId; pointerBinding: null }>
  | Readonly<{ kind: "pointer-cleanup-pending"; agentId: null; pointerBinding: SessionTaskGraphPointerBinding }>
);

/** The child grants one Pi process holds, keyed by raw session id. */
export type PiChildWriteGrants = Readonly<{
  active: Map<string, ActiveChildWriteGrant>;
  /** Sessions whose grant was rejected: their direct edits stay blocked. */
  rejectedSessions: Set<string>;
}>;

export const createPiChildWriteGrants = (): PiChildWriteGrants => Object.freeze({
  active: new Map<string, ActiveChildWriteGrant>(),
  rejectedSessions: new Set<string>(),
});

const PI_AGENT_ID_MARKER = /<!-- LOOM_PI_AGENT_ID:([a-z0-9-]+) -->/g;
const PI_WRITE_GRANT_MARKER = /<!-- LOOM_PI_WRITE_GRANT:[0-9a-f]{64} -->/;

export function rejectedChildWriteGrantBlock(rejected: boolean): Readonly<{ block: true; reason: string }> | null {
  return rejected
    ? { block: true, reason: "Loom Pi write grant was rejected for this session; direct edits remain blocked." }
    : null;
}

function piSystemAgentIdentity(systemPrompt: string): string {
  PI_AGENT_ID_MARKER.lastIndex = 0;
  const matches = [...systemPrompt.matchAll(PI_AGENT_ID_MARKER)];
  if (matches.length !== 1) throw new Error("child system prompt must contain exactly one Loom Pi agent identity");
  return matches[0]![1]!;
}

/** The I/O one child activation performs, injectable so the rollback and
 *  cleanup-pending lifecycle runs against in-memory fakes. */
export type PiChildWriteGrantPorts = Readonly<{
  markActive: (sessionId: SessionId, agentId: AgentId) => Promise<void>;
  removeActive: (sessionId: SessionId, agentId: AgentId) => Promise<void>;
  bindPointer: (sessionId: SessionId, taskGraphPath: string) => Promise<SessionTaskGraphPointerBinding>;
  writeStderr: (line: string) => void;
}>;

const productionPiChildWriteGrantPorts: PiChildWriteGrantPorts = Object.freeze({
  markActive: (sessionId: SessionId, agentId: AgentId) => fsSessionRegistry.markActive(sessionId, agentId),
  removeActive: (sessionId: SessionId, agentId: AgentId) => fsSessionRegistry.removeActive(sessionId, agentId),
  bindPointer: (sessionId: SessionId, taskGraphPath: string) => bindSessionTaskGraphPointer(sessionId, taskGraphPath),
  writeStderr: (line: string): void => { process.stderr.write(line); },
});

/** The roster entry a failed activation had already written. */
type PartialChildBinding = Readonly<{ sessionId: SessionId; agentId: AgentId }>;

/** A rejected activation's outstanding cleanup authority, keyed by the child
 *  session the shell stores it under. */
export type RejectedChildWriteGrantDebt = Readonly<{
  sessionId: SessionId;
  grant: Extract<ActiveChildWriteGrant, { kind: "roster-cleanup-pending" }>;
}>;

/**
 * What a rejected activation still owes: when its partial roster entry could
 * not be removed, that entry stays as `roster-cleanup-pending` authority so
 * shutdown retries it; a clean (or never-made) partial binding owes nothing.
 * Pure; the shell stores the answer under the session it names. A failed bind
 * leaves no pointer lease, so the roster entry is the only debt this half of
 * the lifecycle can hold.
 */
export function rejectedChildWriteGrantDebt(
  partial: PartialChildBinding | null,
  cleanupErrors: readonly string[],
): RejectedChildWriteGrantDebt | null {
  return partial !== null && cleanupErrors.length > 0
    ? {
        sessionId: partial.sessionId,
        grant: { kind: "roster-cleanup-pending", agentId: partial.agentId, pointerBinding: null },
      }
    : null;
}

/**
 * Consume the write grant injected into this child's task and bind the child
 * session to it. A rejected grant marks the session rejected, removes any
 * roster entry the partial binding made (retaining it as cleanup debt when
 * that removal fails), and answers a hidden diagnostic message; a prompt
 * without a grant marker is untouched.
 */
export async function activatePiChildWriteGrant(
  event: Readonly<{ prompt: string; systemPrompt: string }>,
  ctx: Readonly<{ cwd: string; sessionManager: Readonly<{ getSessionId: () => string | undefined }> }>,
  grants: PiChildWriteGrants,
  ports: PiChildWriteGrantPorts = productionPiChildWriteGrantPorts,
): Promise<BeforeAgentStartEventResult | undefined> {
  // The one mutable cell: set between the roster write and the binding that
  // completes it, read only by the rejection arm below.
  let partialBinding: PartialChildBinding | null = null;
  try {
    if (!PI_WRITE_GRANT_MARKER.test(event.prompt)) return;
    const childAgent = piSystemAgentIdentity(event.systemPrompt);
    const grant = consumePiWriteGrant(event.prompt, ctx.cwd, childAgent);
    if (!grant) return;
    const sessionId = parseSessionId(ctx.sessionManager.getSessionId() ?? "");
    const agentId = parseAgentId(grant.agentId);
    if (!sessionId || !agentId) throw new Error("child session or grant agent identity is invalid");
    await ports.markActive(sessionId, agentId);
    partialBinding = { sessionId, agentId };
    const pointerBinding = await ports.bindPointer(sessionId, grant.taskGraphPath);
    grants.active.set(sessionId, {
      kind: "active",
      agentId,
      pointerBinding,
      scopeDirs: grant.scopeDirs,
      grantCwd: grant.cwd,
    });
    partialBinding = null;
    ports.writeStderr(`loom(pi): activated child write grant for ${grant.taskId}/${sessionId}\n`);
  } catch (error) {
    return rejectChildWriteGrant(error, partialBinding, ctx.sessionManager.getSessionId() ?? "", grants, ports);
  }
  return undefined;
}

async function rejectChildWriteGrant(
  error: unknown,
  partial: PartialChildBinding | null,
  rejectedSession: string,
  grants: PiChildWriteGrants,
  ports: PiChildWriteGrantPorts,
): Promise<BeforeAgentStartEventResult> {
  if (parseSessionId(rejectedSession)) grants.rejectedSessions.add(rejectedSession);
  const cleanupErrors: readonly string[] = partial === null
    ? Object.freeze([])
    : await runPiCleanupActions([{
        label: `remove partial child roster entry ${partial.agentId}`,
        run: () => ports.removeActive(partial.sessionId, partial.agentId),
      }]);
  for (const cleanupError of cleanupErrors) {
    ports.writeStderr(`loom(pi): child write-grant cleanup failed: ${cleanupError}\n`);
  }
  const debt = rejectedChildWriteGrantDebt(partial, cleanupErrors);
  if (debt !== null) grants.active.set(debt.sessionId, debt.grant);
  const message = `loom(pi): child write grant rejected — edits remain blocked: ${error instanceof Error ? error.message : String(error)}` +
    cleanupFailureSuffix(cleanupErrors);
  ports.writeStderr(message + "\n");
  return {
    message: { customType: "loom-write-grant-error", content: message, display: false },
  };
}

/**
 * The cleanup authority a child binding holds, as a durable claims ledger of
 * its own: its roster entry (by bare id) and its pointer lease. It holds no
 * grant — the child consumed its grant at activation, and the parent revokes
 * what it issued — so shutdown releases it by the ledger's one plan and ports.
 */
export function childBindingClaims(binding: ActiveChildWriteGrant): DurableSpawnClaims<RosterClaim> {
  return Object.freeze({
    grants: Object.freeze([]),
    roster: Object.freeze(binding.agentId === null ? [] : [Object.freeze({ rosterId: binding.agentId })]),
    pointer: binding.pointerBinding,
  });
}

/**
 * What a child binding still owes once shutdown released part of it, given
 * what the ledger's remaining-debt rule says its claims still owe
 * (`remainingDurableClaims` over `childBindingClaims`): the roster entry and
 * pointer lease still owed stay as cleanup authority, in the variant that
 * names exactly them, and a binding with nothing left is retired (`null`).
 * Pure; the shell stores the answer.
 */
export function retainedChildWriteGrant(
  binding: ActiveChildWriteGrant,
  owed: DurableSpawnClaims<RosterClaim>,
): ActiveChildWriteGrant | null {
  const agentId = binding.agentId !== null && owed.roster.some(({ rosterId }) => rosterId === binding.agentId)
    ? binding.agentId
    : null;
  const pointerBinding = binding.pointerBinding !== null && owed.pointer === binding.pointerBinding
    ? binding.pointerBinding
    : null;
  if (agentId !== null && pointerBinding !== null) {
    return { ...binding, kind: "active", agentId, pointerBinding };
  }
  if (agentId !== null) {
    return { ...binding, kind: "roster-cleanup-pending", agentId, pointerBinding: null };
  }
  if (pointerBinding !== null) {
    return { ...binding, kind: "pointer-cleanup-pending", agentId: null, pointerBinding };
  }
  return null;
}
