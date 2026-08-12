/**
 * Claude Code request-bound capture.
 *
 * Runs BEFORE legacy SubagentStop routing. That ordering matters twice over:
 * the legacy path resolves a task graph and returns early when there is none,
 * which would silently skip capture for every standalone run; and legacy
 * handlers mutate task state, so capturing afterwards would record evidence
 * for a decision already taken.
 *
 * Capture is bound to REQUEST authority, not to the agent that happens to have
 * stopped. Claude's `session_id` + `agent_id` + `agent_type` locate the
 * pre-spawn reservation; the reservation names the request, and the request
 * names the run, slot, attempt, model, and context digest. A stop that matches
 * no reservation is audited and ignored — it is someone else's agent, not
 * evidence for this run.
 *
 * This handler NEVER resolves an unrelated State File. It reads only the run
 * directory it was pointed at, so a standalone review running beside an active
 * wave cannot capture into the wave's graph or vice versa.
 *
 * Only the two genuinely harness-native facts live here — how to read Claude's
 * final payload, and what its native correlator is. Everything the run
 * directory is asked for is shared with Pi through
 * `orchestration/harness-capture-runtime`, so the two harnesses cannot drift
 * into admitting different results for the same run.
 */

import { readFileSync } from "node:fs";
import type { HookHandler, HookResult, SubagentStopInput } from "../../types";
import type { FinalPayloadCandidate } from "../../core/harness-capture";
import {
  captureAuditLine,
  captureHarnessResult,
  RUN_DIR_ENV,
  RUNS_ROOT_ENV,
  type CaptureOutcome,
} from "../../orchestration/harness-capture-runtime";

export type { CaptureOutcome };

/**
 * Read the last assistant message from a Claude agent transcript as the sole
 * final-payload candidate.
 *
 * Claude's transcript is JSONL with one message per line, so "the final
 * assistant text" is unambiguous by construction — unlike Pi, where a result
 * carries a list of blocks. Any parse failure yields NO candidate rather than
 * a guess, so the ambiguity rules reject instead of accepting salvage.
 */
export function claudeFinalPayloadCandidates(transcriptPath: string): readonly FinalPayloadCandidate[] {
  // One read, no pre-check: `existsSync` returns false for ELOOP/ENOTDIR too,
  // which would turn an unreadable transcript into a silent "no candidates"
  // before readFileSync could surface the cause. Absence (ENOENT) keeps the
  // documented "no transcript → no candidate" meaning; every other read
  // failure (EACCES, ELOOP, EISDIR, ENOTDIR, EIO, ...) is a real cause the
  // operator must see instead of a generic missing-payload rejection.
  const lines = ((): readonly string[] => {
    try {
      return readFileSync(transcriptPath, "utf-8").split("\n").filter((line) => line.trim().length > 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return Object.freeze([]);
      throw new Error(
        `cannot read Claude transcript ${transcriptPath}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  })();

  const finalIndex = lines.length - 1;
  if (finalIndex < 0) return Object.freeze([]);
  const text = assistantTextOf(lines[finalIndex]);
  return text === null
    ? Object.freeze([])
    : Object.freeze([{ origin: `transcript.line[${finalIndex}]`, text }]);
}

function assistantTextOf(line: string | undefined): string | null {
  if (line === undefined) return null;
  const parsed = ((): unknown => {
    try {
      return JSON.parse(line) as unknown;
    } catch {
      return null;
    }
  })();
  if (typeof parsed !== "object" || parsed === null) return null;
  const message = (parsed as Record<string, unknown>)["message"];
  if (typeof message !== "object" || message === null) return null;
  const record = message as Record<string, unknown>;
  if (record["role"] !== "assistant" || !Array.isArray(record["content"])) return null;

  // Concatenating text blocks here would be the same normalisation the payload
  // rules forbid, so a multi-block assistant message yields its blocks joined
  // by nothing only when there is exactly one.
  const texts = (record["content"] as readonly unknown[])
    .filter((block): block is Record<string, unknown> =>
      typeof block === "object" && block !== null && (block as Record<string, unknown>)["type"] === "text")
    .map((block) => block["text"])
    .filter((text): text is string => typeof text === "string");
  return texts.length === 1 ? texts[0] ?? null : null;
}

/**
 * Re-exported so the Claude-side tests and callers keep one import site while
 * the implementations stay shared with Pi.
 */
export {
  alreadyCapturedSlots,
  readCorrelatorIdentity,
  readIssuedRequests,
} from "../../orchestration/harness-capture-runtime";

/**
 * Capture one finished Claude agent. Pure with respect to decisions: every
 * refusal is returned as a typed outcome the caller audits, and only an
 * accepted capture writes anything.
 */
export async function captureClaudeResult(
  input: SubagentStopInput,
  runsRoot: string | undefined,
  runDirectory: string | undefined,
): Promise<CaptureOutcome> {
  return captureHarnessResult({
    harness: "claude",
    runsRoot,
    runDirectory,
    // Claude's native correlator is the agent id its SubagentStop payload
    // carries; the spawn side recorded it beside the reservation.
    nativeId: typeof input.agent_id === "string" ? input.agent_id : "",
    candidates: claudeFinalPayloadCandidates(input.agent_transcript_path ?? ""),
  });
}

const handler: HookHandler = async (stdin): Promise<HookResult> => {
  const input = ((): SubagentStopInput | null => {
    try {
      return JSON.parse(stdin) as SubagentStopInput;
    } catch {
      return null;
    }
  })();
  const hasAnyRunAuthority = process.env[RUNS_ROOT_ENV] !== undefined || process.env[RUN_DIR_ENV] !== undefined;
  if (input === null) {
    return hasAnyRunAuthority
      ? { kind: "error", message: "request-bound capture rejected: malformed SubagentStop JSON" }
      : { kind: "passthrough" };
  }

  const outcome = await captureClaudeResult(
    input,
    process.env[RUNS_ROOT_ENV],
    process.env[RUN_DIR_ENV],
  );

  // Every non-capture is audited. A rejection must be visible: silence here
  // would look exactly like a run that had nothing to capture.
  const audit = captureAuditLine("capture-orchestration-result", outcome);
  if (audit !== null) process.stderr.write(audit);
  if (outcome.kind === "rejected" && hasAnyRunAuthority) {
    return {
      kind: "error",
      message: `request-bound capture rejected (${outcome.reason}): ${outcome.message}`,
    };
  }
  return { kind: "passthrough" };
};

export default handler;
