/**
 * Shell: establish a Claude implementation Agent's exact Implementation
 * Attempt binding — the one operation SubagentStart (opportunistically),
 * PreToolUse (before every write decision, and on every tool call), and
 * SubagentStop (a last attempt before settlement) all share.
 *
 * The persisted state is the implementation-attempt SIDECAR itself: a rostered
 * implementation Agent with a sidecar is `bound`; without one it is `pending`.
 * There is no separate pending marker to drift out of step with the sidecar.
 *
 * Idempotent and race-safe: an observed sidecar is returned as-is, and two
 * concurrent first tool calls from one child derive identical bytes from the
 * same prompt and TaskGraph, so publication's no-replace link answers the
 * loser `already-owned` instead of publishing twice or conflicting.
 */

import { match } from "ts-pattern";
import { isImplementationAgent } from "../core/model-profiles";
import {
  identifyImplementationAttempt,
  type FirstPromptObservation,
  type ImplementationBinding,
} from "../core/implementation-binding";
import type { ImplementationAttemptAuthority } from "../core/implementation-completion";
import type { ActiveAgent, AgentId, SessionId } from "../machine";
import { readRunBytesNoFollow } from "../orchestration/no-follow-fs";
import { parseFirstUserPrompt } from "../parsers/parse-transcript";
import { StateManager } from "../state-manager";
import { resolveAgentTranscriptPath } from "../utils/agent-transcript-path";
import {
  publishImplementationAttemptSidecar,
  snapshotImplementationAttemptSidecar,
} from "../implementation-attempt-sidecar";

/**
 * One binding attempt's outcome. Assignable to the core `ImplementationBinding`;
 * the extra fields carry what SubagentStart's rollback needs: whether THIS
 * attempt created the sidecar, and which registration it identified before a
 * refusal.
 */
type ImplementationBindingOutcome =
  | Readonly<{ kind: "pending"; reason: string }>
  | Readonly<{
      kind: "bound";
      authority: ImplementationAttemptAuthority;
      publication: "observed" | "published" | "already-owned";
    }>
  | Readonly<{ kind: "refused"; reason: string; identified: ImplementationAttemptAuthority | null }>;

const message = (error: unknown): string => error instanceof Error ? error.message : String(error);

const refused = (reason: string, identified: ImplementationAttemptAuthority | null = null): ImplementationBindingOutcome =>
  Object.freeze({ kind: "refused", reason, identified });

/** True when the session roster records `agentId` serving an implementation role. */
function rosteredImplementationAgent(roster: readonly ActiveAgent[] | null, agentId: AgentId): boolean {
  return roster?.some((entry) =>
    entry.agentId === agentId && entry.agentType !== null && isImplementationAgent(entry.agentType)) ?? false;
}

/** The child's first prompt as the transcript shows it right now. */
function observeFirstPrompt(sessionId: SessionId, agentId: AgentId, suppliedTranscriptPath?: string): FirstPromptObservation {
  const unwritten = Object.freeze({ kind: "unwritten" as const, reason: "child transcript could not be resolved yet" });
  let content: string;
  try {
    const path = resolveAgentTranscriptPath({
      session_id: sessionId,
      agent_id: agentId,
      ...(suppliedTranscriptPath === undefined ? {} : { agent_transcript_path: suppliedTranscriptPath }),
    });
    if (path === null) return unwritten;
    content = readRunBytesNoFollow(path).toString("utf8");
  } catch (error) {
    // Creation can race the probe; only absence is "not yet", every other
    // filesystem failure is a refusal to trust these bytes.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return unwritten;
    return Object.freeze({ kind: "untrusted", reason: `child transcript is unreadable: ${message(error)}` });
  }
  if (content.trim() === "") return unwritten;
  const prompt = parseFirstUserPrompt(content);
  return prompt.ok
    ? Object.freeze({ kind: "prompt", text: prompt.prompt })
    : Object.freeze({ kind: "untrusted", reason: prompt.error });
}

/**
 * How a sidecar already live under this Agent's key is treated.
 *  - `trust`: the Agent is running, so a live sidecar was published by an
 *    earlier binding from this same Agent's prompt (the key is session+agent);
 *    it is returned as-is without re-reading the transcript.
 *  - `reprove`: SubagentStart, the Agent's first lifecycle event — nothing of
 *    its own can be live yet, so authority is always re-derived and published;
 *    identical bytes (duplicate delivery) are idempotent, different bytes are
 *    a conflict.
 */
type ExistingSidecarPolicy = "trust" | "reprove";

/**
 * Bind `agentId` to the exact attempt its own first prompt names in `graph`,
 * or report why it cannot be bound (yet). Never throws: every failure is an
 * outcome.
 */
export function ensureImplementationBinding(request: Readonly<{
  sessionId: SessionId;
  agentId: AgentId;
  graph: StateManager;
  existingSidecar: ExistingSidecarPolicy;
  suppliedTranscriptPath?: string;
}>): ImplementationBindingOutcome {
  const { sessionId, agentId, graph } = request;
  try {
    if (request.existingSidecar === "trust") {
      const existing = snapshotImplementationAttemptSidecar(sessionId, agentId);
      if (existing.kind === "authority-observed") {
        return Object.freeze({ kind: "bound", authority: existing.sidecar.authority, publication: "observed" });
      }
      if (existing.failure.kind !== "missing-sidecar") return refused(existing.failure.message);
    }

    const prompt = observeFirstPrompt(sessionId, agentId, request.suppliedTranscriptPath);
    return match(identifyImplementationAttempt(prompt, graph.load()))
      .with({ kind: "unavailable" }, ({ reason }): ImplementationBindingOutcome =>
        Object.freeze({ kind: "pending", reason }))
      .with({ kind: "refused" }, ({ reason }) => refused(reason))
      .with({ kind: "identified" }, ({ authority }) => publish(sessionId, agentId, graph, authority))
      .exhaustive();
  } catch (error) {
    return refused(message(error));
  }
}

function publish(
  sessionId: SessionId,
  agentId: AgentId,
  graph: StateManager,
  authority: ImplementationAttemptAuthority,
): ImplementationBindingOutcome {
  try {
    const sidecar = publishImplementationAttemptSidecar({
      sessionId,
      agentId,
      taskGraphPath: graph.getPath(),
      authority,
    });
    if (sidecar.cleanupFailure !== null) {
      const cleanup = sidecar.cleanupFailure;
      process.stderr.write(
        `implementation-binding: sidecar is live but staged cleanup failed for ${agentId}/${sessionId}: ${cleanup.message}` +
          (cleanup.code === undefined ? "" : ` (errno ${cleanup.code})`) + "\n",
      );
    }
    return Object.freeze({ kind: "bound", authority, publication: sidecar.disposition });
  } catch (error) {
    return refused(message(error), authority);
  }
}

type SessionTaskGraph =
  | Readonly<{ ok: true; graph: StateManager }>
  | Readonly<{ ok: false; reason: string }>;

/** The session's TaskGraph, as SubagentStart recorded it for this session. */
function sessionTaskGraph(sessionId: SessionId): SessionTaskGraph {
  try {
    const graph = StateManager.fromSession(sessionId);
    return graph === null
      ? { ok: false, reason: `no TaskGraph authority is resolvable for session ${sessionId}` }
      : { ok: true, graph };
  } catch (error) {
    return { ok: false, reason: `TaskGraph authority for session ${sessionId} is unavailable: ${message(error)}` };
  }
}

/**
 * `ensureImplementationBinding` for an Agent the roster says is an
 * implementation Agent, against the session's recorded TaskGraph. `null` when
 * the roster says it is not one — there is nothing to bind.
 */
export function ensureRosteredImplementationBinding(request: Readonly<{
  sessionId: SessionId;
  agentId: AgentId;
  roster: readonly ActiveAgent[] | null;
  suppliedTranscriptPath?: string;
}>): ImplementationBindingOutcome | null {
  if (!rosteredImplementationAgent(request.roster, request.agentId)) return null;
  const resolved = sessionTaskGraph(request.sessionId);
  return resolved.ok
    ? ensureImplementationBinding({
        sessionId: request.sessionId,
        agentId: request.agentId,
        graph: resolved.graph,
        existingSidecar: "trust",
        ...(request.suppliedTranscriptPath === undefined ? {} : { suppliedTranscriptPath: request.suppliedTranscriptPath }),
      })
    : refused(resolved.reason);
}

/** The observed (never published) binding of a rostered Agent. */
export function observeImplementationBinding(sessionId: SessionId, agentId: AgentId): ImplementationBinding {
  try {
    const existing = snapshotImplementationAttemptSidecar(sessionId, agentId);
    if (existing.kind === "authority-observed") {
      return Object.freeze({ kind: "bound", authority: existing.sidecar.authority });
    }
    return existing.failure.kind === "missing-sidecar"
      ? Object.freeze({ kind: "pending", reason: "exact implementation attempt not bound yet" })
      : Object.freeze({ kind: "refused", reason: existing.failure.message });
  } catch (error) {
    return Object.freeze({ kind: "refused", reason: message(error) });
  }
}
