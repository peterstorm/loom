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
 * stopped. Claude supplies exactly ONE native correlator — the `agent_id` its
 * SubagentStop payload carries — and the correlator binding the spawn side wrote
 * into the run directory reconstructs the request it belongs to; the request
 * names the run, slot, attempt, model, and context digest. `session_id` and
 * `agent_type` play no part in that identity. With request-bound Run authority,
 * a stop that matches no reservation is audited and rejected: silently treating
 * it as unrelated would strand the reserved slot.
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
import { resolveAgentTranscriptPath } from "../../utils/agent-transcript-path";
import {
  captureAuditLine,
  captureCandidates,
  captureHarnessResult,
  terminalCaptureRefusal,
  RUN_DIR_ENV,
  RUNS_ROOT_ENV,
  type CaptureObservation,
  type CaptureOutcome,
} from "../../orchestration/harness-capture-runtime";

export type { CaptureOutcome };

/**
 * Inspect the final non-empty Claude transcript line and hand over EVERY text
 * block of its assistant message as a separate candidate.
 *
 * Claude's transcript is JSONL with one message per line. Unlike Pi, where a
 * result carries a list of blocks, no earlier line is searched as a fallback.
 * A syntactically malformed final line is reported as transcript corruption
 * with its line number. A well-formed non-assistant message yields no candidate,
 * so the payload rules still reject instead of accepting salvage.
 *
 * Multi-block messages are reported as the ambiguity they are rather than being
 * collapsed here: choosing or joining blocks is the shared payload rule's
 * decision, and pre-selecting one would turn `ambiguous-final-payload` into an
 * unreachable refusal on this path.
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
  const blocks = assistantTextBlocksOf(lines[finalIndex], finalIndex);
  if (blocks === null) return Object.freeze([]);
  return Object.freeze(blocks.map((text, blockIndex) => Object.freeze({
    origin: `transcript.line[${finalIndex}].block[${blockIndex}]`,
    text,
  })));
}

function assistantTextBlocksOf(line: string | undefined, zeroBasedLine: number): readonly string[] | null {
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

  // Every text block is handed over as its own candidate. Concatenating them
  // here would be the normalisation the payload rules forbid, and keeping only
  // one would hide the ambiguity the engine is supposed to refuse.
  const texts = (record["content"] as readonly unknown[])
    .filter((block): block is Record<string, unknown> =>
      typeof block === "object" && block !== null && (block as Record<string, unknown>)["type"] === "text")
    .map((block) => block["text"])
    .filter((text): text is string => typeof text === "string");
  return Object.freeze(texts);
}

/**
 * Capture one finished Claude agent. Pure with respect to decisions: every
 * refusal is returned as a typed outcome the caller audits. Accepted captures
 * write transcript evidence; refusals that reached a reservation may durably
 * record a rejection marker and journal event.
 *
 * The transcript is located the way every sibling handler locates it —
 * `resolveAgentTranscriptPath`, because Claude Code stopped sending
 * `agent_transcript_path`. Nothing found is its own `transcript-locator`
 * refusal: an absent harness field must not be reported as an Agent that
 * produced no final payload, because the caller terminalises refusals and the
 * slot would be burned for a fault the Agent never committed.
 */
export async function captureClaudeResult(
  input: SubagentStopInput,
  runsRoot: string | undefined,
  runDirectory: string | undefined,
): Promise<CaptureOutcome> {
  // Observation stays lazy so the shared runtime resolves the correlator and
  // immutable reservation first. An unrelated stop therefore remains
  // `no-reservation`; a request-bound locator/JSON refusal can be durably
  // terminalised against the exact request it failed to observe.
  const observe = (): CaptureObservation => {
    const transcriptPath = resolveAgentTranscriptPath(input);
    if (transcriptPath === null) {
      return terminalCaptureRefusal(
        "transcript-locator",
        `no transcript can be located for session ${JSON.stringify(input.session_id ?? "")} agent ${JSON.stringify(input.agent_id ?? "")}: none was supplied and the derived path does not exist`,
      );
    }
    try {
      return captureCandidates(claudeFinalPayloadCandidates(transcriptPath));
    } catch (error) {
      return terminalCaptureRefusal(
        "transcript-json",
        error instanceof Error ? error.message : String(error),
      );
    }
  };
  return captureHarnessResult({
    harness: "claude",
    runsRoot,
    runDirectory,
    // Claude's native correlator is the agent id its SubagentStop payload
    // carries; the spawn side recorded it beside the reservation.
    nativeId: typeof input.agent_id === "string" ? input.agent_id : "",
    observe,
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

  // A capture, a refusal, and a stop that matched no reservation are all
  // audited; only `not-an-orchestration-run` — an agent in nobody's run — stays
  // silent. A missing rejection would look exactly like a run with nothing to
  // capture.
  const audit = captureAuditLine("capture-orchestration-result", outcome);
  if (audit !== null) process.stderr.write(audit);
  if (hasAnyRunAuthority && outcome.kind === "no-reservation") {
    return {
      kind: "error",
      message: `request-bound capture found no reservation for ${outcome.agentId}`,
    };
  }
  if (hasAnyRunAuthority &&
      (outcome.kind === "terminal-rejection" || outcome.kind === "retriable-failure")) {
    return {
      kind: "error",
      message: `request-bound capture rejected (${outcome.reason}): ${outcome.message}`,
    };
  }
  return { kind: "passthrough" };
};

export default handler;
