/**
 * PostToolUse handler: record-evidence
 *
 * Appends ground-truth evidence records (facts only, epoch-stamped) to the
 * session's ledger — the deterministic core observes what happened at
 * execution time, never the agent's narrative about it.
 *
 * Records ONLY when attribution is sound: exactly one machine binding and
 * no other active subagent (soleActiveBinding). Contended sessions record
 * nothing — commingled evidence is worse than no evidence, because the
 * SubagentStop resolver treats ledger data as high-trust.
 *
 * Never blocks: the PreToolUse gate fails closed on missing evidence, and
 * the SubagentStop resolver labels a bound-but-empty ledger as degraded —
 * so a broken recorder surfaces downstream instead of silently passing.
 */

import type { HookHandler } from "../../types";
import { passthroughResult } from "../../types";
import {
  appendEvidence,
  extractBashOutcome,
  extractEvidence,
  findReport,
  soleActiveBinding,
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

    const binding = soleActiveBinding(sessionId);
    if (binding === null) return passthroughResult();

    const toolInput = input.tool_input ?? {};
    const outcome = extractBashOutcome(input.tool_response);
    const cwd = input.cwd ?? process.cwd();

    const events = extractEvidence(toolName, toolInput, outcome, (segment, stdout) =>
      findReport(segment, cwd, stdout, Date.now()),
    );
    appendEvidence(sessionId, binding.epoch, events);

    return passthroughResult();
  } catch (e) {
    process.stderr.write(`record-evidence: ${(e as Error).message}\n`);
    return passthroughResult();
  }
};

export default handler;
