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
 * stopped. Exact Run Directory authority plus Claude's `agent_id` native
 * correlator locate the pre-spawn reservation; the reservation names the
 * request, and the request names the run, slot, attempt, model, and context
 * digest. With request-bound
 * Run authority, a stop that matches no reservation is audited and rejected:
 * silently treating it as unrelated would strand the reserved slot.
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
import type { AgentRequestAuthority } from "../../core/orchestration-contract";
import { parseSubagentStopStdin } from "../../parsers/parse-subagent-stop-input";
import type { FinalPayloadCandidate } from "../../core/harness-capture";
import {
  captureAuditLine,
  captureHarnessResult,
  readCorrelatorIdentity,
  readIssuedRequests,
  RUN_DIR_ENV,
  RUNS_ROOT_ENV,
  type CaptureOutcome,
} from "../../orchestration/harness-capture-runtime";
import { openRunDirectory } from "../../orchestration/run-directory-handle";

export type { CaptureOutcome };

/**
 * Inspect the final non-empty Claude transcript line as the sole final-payload
 * candidate, accepting it only when it is an assistant message with exactly one
 * text block.
 *
 * Claude's transcript is JSONL with one message per line. Unlike Pi, where a
 * result carries a list of blocks, no earlier line is searched as a fallback.
 * A syntactically malformed final line is reported as transcript corruption
 * with its line number. A well-formed non-assistant or ambiguous message yields
 * no candidate, so the payload rules still reject instead of accepting salvage.
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
      return readFileSync(transcriptPath, "utf-8").split("\n");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return Object.freeze([]);
      throw new Error(
        `cannot read Claude transcript ${transcriptPath}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  })();

  const finalIndex = lines.findLastIndex((line) => line.trim().length > 0);
  if (finalIndex < 0) return Object.freeze([]);
  const text = assistantTextOf(lines[finalIndex], finalIndex);
  return text === null
    ? Object.freeze([])
    : Object.freeze([{ origin: `transcript.line[${finalIndex}]`, text }]);
}

function assistantTextOf(line: string | undefined, zeroBasedLine: number): string | null {
  if (line === undefined) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(line) as unknown;
  } catch (error) {
    throw new Error(
      `invalid final Claude transcript JSON at line ${zeroBasedLine + 1}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const message = (parsed as Record<string, unknown>)["message"];
  if (typeof message !== "object" || message === null) return null;
  const record = message as Record<string, unknown>;
  if (record["role"] !== "assistant" || !Array.isArray(record["content"])) return null;

  // Concatenating text blocks would be normalization the payload rules forbid:
  // return the sole text block and reject messages with zero or multiple blocks.
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
  alreadyCapturedAttempts,
  readCorrelatorIdentity,
  readIssuedRequests,
} from "../../orchestration/harness-capture-runtime";

/** Resolve the exact issued request bound to this Claude SubagentStop correlator. */
export function resolveClaudeRequestAuthority(
  input: SubagentStopInput,
  runsRoot: string | undefined,
  runDirectory: string | undefined,
): AgentRequestAuthority | null {
  if (runsRoot === undefined && runDirectory === undefined) return null;
  if (runsRoot === undefined || runDirectory === undefined) {
    throw new Error("Claude request authority requires both run root and run directory");
  }
  const opened = openRunDirectory(runsRoot, runDirectory);
  if (!opened.ok) throw new Error(opened.error.message);
  const identity = readCorrelatorIdentity(opened.value, "claude", input.agent_id ?? "");
  if (identity === null) return null;
  return readIssuedRequests(opened.value).find(({ requestId }) => requestId === identity.requestId) ?? null;
}

/**
 * Capture one finished Claude agent. Pure with respect to decisions: every
 * refusal is returned as a typed outcome the caller audits. Accepted captures
 * write transcript evidence; refusals that reached a reservation may durably
 * record a rejection marker and journal event.
 */
export async function captureClaudeResult(
  input: SubagentStopInput,
  runsRoot: string | undefined,
  runDirectory: string | undefined,
): Promise<CaptureOutcome> {
  let candidates: readonly FinalPayloadCandidate[];
  try {
    candidates = claudeFinalPayloadCandidates(input.agent_transcript_path ?? "");
  } catch (error) {
    return {
      kind: "rejected",
      reason: "transcript-json",
      message: error instanceof Error ? error.message : String(error),
    };
  }
  return captureHarnessResult({
    harness: "claude",
    runsRoot,
    runDirectory,
    // Claude's native correlator is the agent id its SubagentStop payload
    // carries; the spawn side recorded it beside the reservation.
    nativeId: typeof input.agent_id === "string" ? input.agent_id : "",
    candidates,
  });
}

const handler: HookHandler = async (stdin): Promise<HookResult> => {
  const parsedInput = parseSubagentStopStdin(stdin);
  const hasAnyRunAuthority = process.env[RUNS_ROOT_ENV] !== undefined || process.env[RUN_DIR_ENV] !== undefined;
  if (!parsedInput.ok) {
    return hasAnyRunAuthority
      ? {
          kind: "error",
          message: `request-bound capture rejected: malformed SubagentStop JSON or domain shape: ${parsedInput.error}`,
        }
      : { kind: "passthrough" };
  }

  const outcome = await captureClaudeResult(
    parsedInput.value,
    process.env[RUNS_ROOT_ENV],
    process.env[RUN_DIR_ENV],
  );

  // Every non-capture is audited. A rejection must be visible: silence here
  // would look exactly like a run that had nothing to capture.
  const audit = captureAuditLine("capture-orchestration-result", outcome);
  if (audit !== null) process.stderr.write(audit);
  if (hasAnyRunAuthority && outcome.kind === "no-reservation") {
    return {
      kind: "error",
      message: `request-bound capture found no reservation for ${outcome.agentId}`,
    };
  }
  if (hasAnyRunAuthority && outcome.kind === "rejected") {
    return {
      kind: "error",
      message: `request-bound capture rejected (${outcome.reason}): ${outcome.message}`,
    };
  }
  return { kind: "passthrough" };
};

export default handler;
