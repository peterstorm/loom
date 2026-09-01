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
 * This handler NEVER resolves an unrelated State File. Orchestration authority
 * comes only from the Run Directory it was pointed at; payload observation also
 * reads the external Claude transcript selected by the harness locator. A
 * standalone review beside an active wave therefore cannot capture into the
 * wave's graph or vice versa.
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
import { resolveAgentTranscriptPath } from "../../utils/agent-transcript-path";
import {
  captureAuditLine,
  captureCandidates,
  captureHarnessResult,
  describeCaptureFailure,
  resolveCorrelatedRequest,
  RUN_DIR_ENV,
  RUNS_ROOT_ENV,
  terminalCaptureRefusal,
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
class ClaudeTranscriptReadError extends Error {}
class ClaudeTranscriptJsonError extends Error {}

export type ClaudePayloadReader = (transcriptPath: string) => readonly FinalPayloadCandidate[];

export function claudeFinalPayloadCandidates(transcriptPath: string): readonly FinalPayloadCandidate[] {
  // One read, no pre-check: `existsSync` returns false for ELOOP/ENOTDIR too,
  // which would turn an unreadable transcript into a silent "no candidates"
  // before readFileSync could surface the cause. Once the locator selected this
  // path, EVERY read failure — including ENOENT when the file disappeared — is
  // filesystem evidence the operator must see, never a missing-payload claim.
  const lines = ((): readonly string[] => {
    try {
      return readFileSync(transcriptPath, "utf-8").split("\n");
    } catch (error) {
      throw new ClaudeTranscriptReadError(
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
    throw new ClaudeTranscriptJsonError(
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
 * What a Claude SubagentStop's request authority resolution concluded.
 *
 * `request: null` means the stop is in nobody's orchestration run — the ordinary
 * ad-hoc agent, which the caller must leave alone. A `false` branch is a fault
 * in the authority itself (half a run authority, an unreadable run, a corrupt
 * correlation) and must fail closed: reading it as "unrelated" would settle a
 * stop whose reserved slot is still waiting.
 */
export type ClaudeRequestAuthority =
  | Readonly<{ ok: true; request: AgentRequestAuthority | null }>
  | Readonly<{ ok: false; message: string }>;

/**
 * Resolve the issued request this Claude SubagentStop correlator belongs to.
 *
 * `dispatch.ts` needs the request BEFORE it settles the rest of the stop: a
 * request-bound program that is not Wave Gate owns no TaskGraph, and settling it
 * as though it did would demand unrelated protected state after the Run
 * Directory had already accepted the evidence. It asks the SAME
 * `resolveCorrelatedRequest` the capture path below asks, so the two can never
 * disagree about which request a stop answers — and it returns an Either rather
 * than throwing, because a caller that turns a refusal into a diagnostic should
 * not have to catch it first.
 */
export function resolveClaudeRequestAuthority(
  input: SubagentStopInput,
  runsRoot: string | undefined,
  runDirectory: string | undefined,
): ClaudeRequestAuthority {
  const resolved = resolveCorrelatedRequest({
    harness: "claude",
    runsRoot,
    runDirectory,
    nativeId: typeof input.agent_id === "string" ? input.agent_id : "",
  });
  if (resolved.ok) return { ok: true, request: resolved.value.request };
  return resolved.outcome.kind === "not-an-orchestration-run"
    ? { ok: true, request: null }
    : { ok: false, message: describeCaptureFailure(resolved.outcome) };
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
  readPayload: ClaudePayloadReader = claudeFinalPayloadCandidates,
): Promise<CaptureOutcome> {
  // Observation stays lazy so the shared runtime resolves the correlator and
  // immutable reservation first. An unrelated stop therefore remains
  // `no-reservation`; a request-bound locator/read/JSON refusal can be durably
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
      return captureCandidates(readPayload(transcriptPath));
    } catch (error) {
      if (error instanceof ClaudeTranscriptReadError || error instanceof ClaudeTranscriptJsonError) {
        return terminalCaptureRefusal(
          error instanceof ClaudeTranscriptReadError ? "transcript-read" : "transcript-json",
          error.message,
        );
      }
      throw error;
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
