/**
 * PostToolUse handler: record-evidence
 *
 * Appends ground-truth evidence events to the session's evidence ledger —
 * the deterministic core observes what happened at execution time, never
 * the agent's narrative about it.
 *
 * Records only while a machine-gated subagent is active (bound at
 * SubagentStart). Never blocks: evidence collection failing must not brick
 * a session — downstream gates fail closed on MISSING evidence instead.
 */

import type { HookHandler } from "../../types";
import { passthroughResult } from "../../types";
import {
  activeMachineAgents,
  appendEvidence,
  extractBashOutcome,
  extractEvidence,
  findReport,
} from "../../machine";

interface RecordEvidenceInput {
  session_id?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  tool_response?: unknown;
  cwd?: string;
}

const handler: HookHandler = async (stdin) => {
  try {
    if (!stdin || stdin.trim() === "") return passthroughResult();
    const input: RecordEvidenceInput = JSON.parse(stdin);

    const sessionId = input.session_id;
    const toolName = input.tool_name;
    if (!sessionId || !toolName) return passthroughResult();

    // Only machine-gated runs produce evidence; the binding also scopes
    // the ledger epoch to a single subagent run.
    if (activeMachineAgents(sessionId).length === 0) return passthroughResult();

    const toolInput = input.tool_input ?? {};
    const outcome = extractBashOutcome(input.tool_response);
    const cwd = input.cwd ?? process.cwd();

    const events = extractEvidence(toolName, toolInput, outcome, (command, stdout) =>
      findReport(command, cwd, stdout, Date.now()),
    );
    appendEvidence(sessionId, events);

    return passthroughResult();
  } catch (e) {
    process.stderr.write(`record-evidence: ${(e as Error).message}\n`);
    return passthroughResult();
  }
};

export default handler;
