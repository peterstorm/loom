/**
 * PostToolUse handler: record-evidence
 *
 * Appends ground-truth evidence records (facts only, epoch-stamped) to the
 * session's ledger — the deterministic core observes what happened at
 * execution time, never the agent's narrative about it.
 *
 * Records ONLY when attribution is sound: exactly one machine binding and
 * the active roster is exactly the bound agent (soleActiveBinding).
 * Contended sessions record nothing, with a stderr note — commingled
 * evidence is worse than no evidence, because the SubagentStop resolver
 * treats ledger data as high-trust.
 *
 * Never blocks: the PreToolUse gate fails closed on missing evidence, and
 * the SubagentStop resolver labels a bound-but-empty ledger as degraded —
 * so a broken recorder surfaces downstream instead of silently passing.
 */

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { HookHandler } from "../../types";
import { passthroughResult } from "../../types";
import {
  appendEvidence,
  eventsForEpoch,
  extractEvidence,
  findReport,
  machineBindingPath,
  readEvidence,
  refreshBindingActivity,
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

    // Recorder activity keeps a live binding fresh (and reaps expired ones)
    // — no-op for ungated sessions (no binding file, no lock taken).
    await refreshBindingActivity(sessionId);

    const binding = soleActiveBinding(sessionId);
    if (binding === null) {
      // Bound-but-unattributable (contended session, leaked binding): say
      // so once, like the gate does — a silently-standing-down recorder is
      // indistinguishable from a broken one. Sessions with no binding file
      // at all are simply ungated; stay quiet for those.
      if (existsSync(machineBindingPath(sessionId))) {
        process.stderr.write(
          `record-evidence: standing down for ${sessionId} — binding exists but attribution is unsound (contended or leaked); nothing recorded\n`,
        );
      }
      return passthroughResult();
    }

    const toolInput = input.tool_input ?? {};
    const cwd = input.cwd ?? process.cwd();

    const events = extractEvidence(toolName, toolInput, input.tool_response, (segment, stdout) => {
      // Cheap hardening against agent-authored report artifacts: an explicit
      // --outputFile path the agent WROTE earlier this epoch (a FileWrite in
      // its own ledger) must not vouch as a report — findReport rejects it
      // loudly. Computed lazily here: this closure only runs for classified
      // test commands.
      const epochWrites = new Set(
        eventsForEpoch(readEvidence(sessionId), binding.epoch).flatMap((e) =>
          e.kind === "FileWrite" ? [resolve(cwd, e.path)] : [],
        ),
      );
      return findReport(segment, cwd, stdout, Date.now(), (absPath) => epochWrites.has(absPath));
    });
    appendEvidence(sessionId, binding.epoch, events);

    return passthroughResult();
  } catch (e) {
    process.stderr.write(`record-evidence: ${e instanceof Error ? e.message : String(e)}\n`);
    return passthroughResult();
  }
};

export default handler;
