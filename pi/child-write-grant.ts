/**
 * Child write grants: the Pi child side of a scoped write capability.
 *
 * Each Pi subagent is a separate `pi --no-session` process. Parent-session
 * roster entries therefore cannot authorize child Edit/Write calls. A child
 * consumes the one-time capability injected into its own task and binds its
 * own session before the first model turn; a child whose grant was rejected
 * keeps direct edits blocked for the rest of its session. This module owns
 * that per-process registry, the activation, and the pure decision of what a
 * binding still owes after shutdown released part of it.
 */

import type { BeforeAgentStartEventResult } from "@earendil-works/pi-coding-agent";
import {
  bindSessionTaskGraphPointer,
  fsSessionRegistry,
  parseAgentId,
  parseSessionId,
  type SessionTaskGraphPointerBinding,
} from "../engine/src/machine";
import type { AgentId } from "../engine/src/machine/evidence";
import { consumePiWriteGrant } from "./write-grant";
import { cleanupFailureSuffix, runPiCleanupActions } from "./cleanup-actions";

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

/**
 * Consume the write grant injected into this child's task and bind the child
 * session to it. A rejected grant marks the session rejected, removes any
 * roster entry the partial binding made, and answers a hidden diagnostic
 * message; a prompt without a grant marker is untouched.
 */
export async function activatePiChildWriteGrant(
  event: Readonly<{ prompt: string; systemPrompt: string }>,
  ctx: Readonly<{ cwd: string; sessionManager: Readonly<{ getSessionId: () => string | undefined }> }>,
  grants: PiChildWriteGrants,
): Promise<BeforeAgentStartEventResult | undefined> {
  let partialBinding: { sessionId: NonNullable<ReturnType<typeof parseSessionId>>; agentId: AgentId } | null = null;
  try {
    if (!PI_WRITE_GRANT_MARKER.test(event.prompt)) return;
    const childAgent = piSystemAgentIdentity(event.systemPrompt);
    const grant = consumePiWriteGrant(event.prompt, ctx.cwd, childAgent);
    if (!grant) return;
    const sessionId = parseSessionId(ctx.sessionManager.getSessionId() ?? "");
    const agentId = parseAgentId(grant.agentId);
    if (!sessionId || !agentId) throw new Error("child session or grant agent identity is invalid");
    await fsSessionRegistry.markActive(sessionId, agentId);
    partialBinding = { sessionId, agentId };
    const pointerBinding = await bindSessionTaskGraphPointer(sessionId, grant.taskGraphPath);
    grants.active.set(sessionId, {
      kind: "active",
      agentId,
      pointerBinding,
      scopeDirs: grant.scopeDirs,
      grantCwd: grant.cwd,
    });
    partialBinding = null;
    process.stderr.write(`loom(pi): activated child write grant for ${grant.taskId}/${sessionId}\n`);
  } catch (error) {
    const rejectedSession = ctx.sessionManager.getSessionId() ?? "";
    if (parseSessionId(rejectedSession)) grants.rejectedSessions.add(rejectedSession);
    // Bound to a const before the closure captures it: `partialBinding` is a
    // mutable outer `let`, so the narrowing from the `if` does not survive
    // into the deferred `run`, and the cleanup would dereference whatever the
    // variable held when it finally ran rather than what was checked.
    const orphanedBinding = partialBinding;
    const cleanupErrors: readonly string[] = orphanedBinding === null
      ? Object.freeze([])
      : await runPiCleanupActions([{
          label: `remove partial child roster entry ${orphanedBinding.agentId}`,
          run: () => fsSessionRegistry.removeActive(orphanedBinding.sessionId, orphanedBinding.agentId),
        }]);
    for (const cleanupError of cleanupErrors) {
      process.stderr.write(`loom(pi): child write-grant cleanup failed: ${cleanupError}\n`);
    }
    if (orphanedBinding !== null && cleanupErrors.length > 0) {
      grants.active.set(orphanedBinding.sessionId, {
        kind: "roster-cleanup-pending",
        agentId: orphanedBinding.agentId,
        pointerBinding: null,
      });
    }
    const message = `loom(pi): child write grant rejected — edits remain blocked: ${error instanceof Error ? error.message : String(error)}` +
      cleanupFailureSuffix(cleanupErrors);
    process.stderr.write(message + "\n");
    return {
      message: { customType: "loom-write-grant-error", content: message, display: false },
    };
  }
  return undefined;
}

/**
 * What a child binding still owes once shutdown released part of it: the
 * roster entry and pointer lease that were NOT released stay as cleanup
 * authority, in the variant that names exactly them, and a binding with
 * nothing left is retired (`null`). Pure; the shell stores the answer.
 */
export function retainedChildWriteGrant(
  binding: ActiveChildWriteGrant,
  removedRosterIds: ReadonlySet<AgentId>,
  releasedPointers: ReadonlySet<SessionTaskGraphPointerBinding>,
): ActiveChildWriteGrant | null {
  const agentId = binding.agentId !== null && removedRosterIds.has(binding.agentId) ? null : binding.agentId;
  const pointerBinding = binding.pointerBinding !== null && releasedPointers.has(binding.pointerBinding)
    ? null
    : binding.pointerBinding;
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
