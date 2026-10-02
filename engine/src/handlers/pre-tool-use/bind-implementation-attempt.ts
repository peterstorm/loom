/**
 * PreToolUse (every tool): bind a Claude implementation Agent's exact
 * Implementation Attempt on its first tool call — whatever that call is.
 *
 * Claude Code writes the child transcript only after SubagentStart returns, so
 * mark-subagent-active usually leaves the binding pending. By the Agent's
 * first tool call the model has completed an API turn and its first prompt is
 * on disk. Binding here (not only on the first write) means an Agent that
 * reads, searches, or runs Bash before editing is already bound when it
 * writes, and still settles exactly at SubagentStop if it never edits at all.
 *
 * Never blocks. This hook does not decide writes: block-direct-edits attempts
 * the same binding itself before every Edit/Write/MultiEdit decision and
 * fails closed there, so a binding still pending or refused here costs a
 * read-only call nothing. Failures are surfaced, never swallowed.
 */

import { passthroughResult, type HookHandler, type HookResult } from "../../types";
import { readActiveAgentRoles } from "../../machine/ledger";
import { parseReportedAgentId, parseSessionId } from "../../machine/evidence";
import { passthroughDiagnostic } from "../../utils/hook-diagnostic";
import { parsePreToolUseInput } from "./pre-tool-use-input";
import { ensureRosteredImplementationBinding } from "../implementation-binding";

const handler: HookHandler = async (stdin): Promise<HookResult> => {
  const parsed = parsePreToolUseInput(stdin);
  if (parsed instanceof Error) {
    return passthroughDiagnostic(`bind-implementation-attempt: malformed hook input — binding not attempted: ${parsed.message}`);
  }
  // Only calls made inside a subagent carry agent_id; the main agent has
  // nothing to bind.
  if (parsed.agent_id === undefined) return passthroughResult();
  const sessionId = parseSessionId(parsed.session_id);
  const agentId = parseReportedAgentId(parsed.agent_id);
  if (sessionId === null || agentId === null) return passthroughResult();

  let roster;
  try {
    roster = readActiveAgentRoles(sessionId);
  } catch (error) {
    return passthroughDiagnostic(
      `bind-implementation-attempt: cannot read the ${sessionId} roster — binding deferred to the next call: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const outcome = ensureRosteredImplementationBinding({ sessionId, agentId, roster });
  if (outcome === null || outcome.kind === "bound") return passthroughResult();
  return passthroughDiagnostic(
    `bind-implementation-attempt: implementation authority for ${agentId} is ${outcome.kind} — ${outcome.reason}` +
      (outcome.kind === "pending" ? "; the next call retries" : "; its writes stay blocked"),
  );
};

export default handler;
