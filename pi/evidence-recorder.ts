/**
 * The Pi child evidence recorder (AD-8, INV-4 sibling entry point).
 *
 * Each Pi subagent is its own `pi --no-session` process. A child that holds a
 * parent-issued write grant records ledger facts for its own tool calls into
 * the PARENT session's ledger, under `epochOf(grant agent id, agent type)`
 * (FR-031, FR-032). The parent names that ledger in the grant
 * (`evidenceLedger`, minted at spawn and bound by the grant MAC), so one child
 * process is one agent and attribution is exact by construction.
 *
 * Minting is not done here: `piToolCall` normalizes the `tool_result` event
 * (`engine/src/core/harness-tool-call.ts`, where the Pi 0.83 event shape is
 * pinned) and the shared shell `recordToolEvidence` mints and appends,
 * exactly as Claude Code's PostToolUse recorder does. The call-start stamp is
 * read from the child's own session, where its `tool_call` guard wrote it.
 *
 * The recorder's one decision on the child's grant state is the pure total
 * `piEvidenceTarget`. A child that may not record records nothing and says
 * why on stderr, once per session and reason (AS-039). Sessions that are not
 * Loom children (the parent, a plain Pi session) stay quiet.
 *
 * `piChildEvidence` is the parent side: it reads one child's epoch back from
 * its own ledger for settlement (I6) and the report-only stop check (I7).
 */

import { piToolCall, type PiToolResultEvent } from "../engine/src/core/harness-tool-call";
import type { LedgerObservation } from "../engine/src/core/red-then-green-types";
import type { Evidence } from "../engine/src/machine/types";
import {
  epochOf,
  eventsForEpoch,
  fsSessionRegistry,
  parseSessionId,
  recordToolEvidence,
  type AgentType,
  type PiEvidenceNoRecordReason,
  type PiEvidenceTargetDecision,
  type SessionId,
  type SessionRegistry,
  type ToolEvidencePorts,
} from "../engine/src/machine";
import { piChildAgentIdentity, type ActiveChildWriteGrant, type PiChildWriteGrants } from "./child-write-grant";
import { piGrantedAgentId } from "./write-grant";

/**
 * Where one child's tool-call facts go, decided from its grant state alone.
 * A rejected grant wins over any cleanup debt it left; a binding that
 * survives only as cleanup debt no longer authorizes evidence; an active
 * grant the parent issued without a ledger address holds no evidence
 * authority either, so it reads as no grant.
 */
export function piEvidenceTarget(
  grant: ActiveChildWriteGrant | undefined,
  rejected: boolean,
  childSession: SessionId,
): PiEvidenceTargetDecision {
  if (rejected) return { kind: "no-record", reason: "grant-rejected" };
  if (grant === undefined) return { kind: "no-record", reason: "no-grant" };
  if (grant.kind !== "active") return { kind: "no-record", reason: "cleanup-pending" };
  if (grant.evidenceLedger === undefined) return { kind: "no-record", reason: "no-grant" };
  return {
    kind: "record",
    ledger: grant.evidenceLedger.sessionId,
    epoch: epochOf(grant.agentId, grant.evidenceLedger.agentType),
    stamps: childSession,
  };
}

const NO_RECORD_EXPLANATION: Readonly<Record<PiEvidenceNoRecordReason, string>> = Object.freeze({
  "no-grant": "this child activated no parent-issued write grant",
  "grant-rejected": "this child's write grant was rejected at activation",
  "cleanup-pending": "this child's binding survives only as cleanup debt",
});

export type PiEvidenceRecorderPorts = ToolEvidencePorts & Readonly<{ writeStderr: (line: string) => void }>;

const productionPorts: PiEvidenceRecorderPorts = Object.freeze({
  registry: fsSessionRegistry,
  nowMs: () => Date.now(),
  writeStderr: (line: string): void => { process.stderr.write(line); },
});

type PiSessionContext = Readonly<{ cwd: string; sessionManager: Readonly<{ getSessionId: () => string | undefined }> }>;

export type PiEvidenceRecorder = Readonly<{
  /** Note whether this session is a Loom subagent child (`before_agent_start`). */
  observeAgentStart: (event: Readonly<{ systemPrompt: string }>, ctx: PiSessionContext) => void;
  /** Record one finished tool call (`tool_result`); returns the appended facts.
   *  Never throws: a failure is reported on stderr and records nothing. */
  recordToolResult: (event: PiToolResultEvent, ctx: PiSessionContext) => readonly Evidence[];
}>;

/**
 * The per-process recorder over this process's child write grants. It owns
 * only diagnostic bookkeeping: which sessions are Loom children, and which
 * (session, reason) pairs were already explained.
 */
export function createPiEvidenceRecorder(
  grants: PiChildWriteGrants,
  ports: PiEvidenceRecorderPorts = productionPorts,
): PiEvidenceRecorder {
  const childSessions = new Set<string>();
  const explained = new Set<string>();

  const explain = (session: string, reason: PiEvidenceNoRecordReason): void => {
    // A plain session with no grant is no Loom child: nothing was lost.
    if (reason === "no-grant" && !childSessions.has(session)) return;
    const key = `${session}\u0000${reason}`;
    if (explained.has(key)) return;
    explained.add(key);
    ports.writeStderr(
      `loom(pi): evidence recorder: nothing recorded for session ${session} (${reason}) — ${NO_RECORD_EXPLANATION[reason]}\n`,
    );
  };

  return Object.freeze({
    observeAgentStart: (event, ctx) => {
      const session = ctx.sessionManager.getSessionId();
      if (session !== undefined && piChildAgentIdentity(event.systemPrompt) !== null) childSessions.add(session);
    },
    recordToolResult: (event, ctx) => {
      const raw = ctx.sessionManager.getSessionId() ?? "";
      try {
        const session = parseSessionId(raw);
        // An unparseable session id can never have activated a grant.
        const decision: PiEvidenceTargetDecision = session === null
          ? { kind: "no-record", reason: "no-grant" }
          : piEvidenceTarget(grants.active.get(raw), grants.rejectedSessions.has(raw), session);
        if (decision.kind === "no-record") {
          explain(raw, decision.reason);
          return [];
        }
        return recordToolEvidence(decision, piToolCall(event, ctx.cwd), ports);
      } catch (error) {
        ports.writeStderr(
          `loom(pi): evidence recorder: UNEXPECTED failure — evidence for this call may be lost: ${error instanceof Error ? error.message : String(error)}\n`,
        );
        return [];
      }
    },
  });
}

/**
 * One child's epoch, read back from the parent's own ledger (FR-035). The
 * child's grant identity is recomputed from the slot's grant token by the
 * same derivation consumption used (`piGrantedAgentId`). A ledger that cannot
 * be read, or a token that names no identity, is `unreadable` — never an
 * empty epoch.
 */
export function piChildEvidence(
  parentSession: SessionId,
  slotToken: string,
  agentType: AgentType,
  registry: Pick<SessionRegistry, "readEvidence"> = fsSessionRegistry,
): LedgerObservation {
  const agentId = piGrantedAgentId(slotToken);
  if (agentId === null) return { kind: "unreadable", reason: "the slot's write-grant token names no grant identity" };
  try {
    return { kind: "read", events: eventsForEpoch(registry.readEvidence(parentSession), epochOf(agentId, agentType)) };
  } catch (error) {
    return { kind: "unreadable", reason: error instanceof Error ? error.message : String(error) };
  }
}
