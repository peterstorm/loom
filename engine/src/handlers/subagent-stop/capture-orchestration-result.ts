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
 * into the run directory (or, for a foreground spawn whose stop precedes its
 * PostToolUse, the binding this stop records first from the agent's own spawn
 * prompt) reconstructs the request it belongs to; the request
 * names the run, slot, attempt, model, and context digest. `session_id` and
 * `agent_type` play no part in that identity. With request-bound Run authority,
 * a stop that matches no reservation is audited and rejected: silently treating
 * it as unrelated would strand the reserved slot.
 *
 * This handler NEVER resolves an unrelated State File. Orchestration authority
 * comes only from the Run Directory `claude-run-authority` resolves — the
 * explicit LOOM_ORCHESTRATION_* run when set, otherwise the session run binding
 * whose correlator records this agent; payload observation also reads the
 * external Claude transcript selected by the harness locator. A standalone
 * review beside an active wave therefore cannot capture into the wave's graph or
 * vice versa.
 *
 * Claude's transcript READ (bounded, typed read/corruption failures) and native
 * correlator live here; what the transcript says — final-payload candidates,
 * emission call frames, tool outputs, the spawn prompt — is the pure
 * core/claude-transcript-projection over ONE parse of the lines. Capture writes
 * and payload admission are shared with Pi through `harness-capture-runtime`.
 * This adapter also preserves the historical Claude observation-fault policy
 * from the bound packet/registration; current infrastructure unavailability
 * must not consume a reviewer semantic attempt.
 *
 * The default observation (T7) reads BOTH closed vocabularies from that one
 * parse: the final-payload candidates (handback-aware) plus the assistant
 * emission-tool-call frames — so the shared runtime's ONE canonical selection
 * serves Claude too, and a call to an emission tool this request never
 * advertised is REFUSED (extraction-only authority cannot be upgraded), never
 * absorbed as absence. A caller-supplied payload reader owns its whole
 * observation, candidates only.
 */

import { readRunBytesNoFollow } from "../../orchestration/no-follow-fs";
import type { HookHandler, HookResult, SubagentStopInput } from "../../types";
import type { AgentRequestAuthority } from "../../core/orchestration-contract";
import type { EmissionSchemaVersion } from "../../core/emission-tool";
import { isReviewAgent } from "../../config";
import { parseRegisteredFacadeProgram } from "../helpers/programs";
import { parseSubagentStopStdin } from "../../parsers/parse-subagent-stop-input";
import type { FinalPayloadCandidate } from "../../core/harness-capture";
import {
  claudeEmissionScan,
  claudeToolOutputs,
  claudeTranscriptCandidates,
  claudeTranscriptSpawnPrompt,
  parseClaudeTranscript,
  type ClaudeEmissionAttribution,
  type ClaudeTranscript,
} from "../../core/claude-transcript-projection";
import { resolveAgentTranscriptPath, resolveAgentType } from "../../utils/agent-transcript-path";
import { stripNamespace } from "../../utils/strip-namespace";
import type { BindingResult } from "../../orchestration/session-run-bindings";
import {
  claudeRunContext,
  recordClaudeSpawnCorrelator,
  resolveClaudeStopRun,
  type ClaudeRun,
  type ClaudeRunAuthority,
  type ClaudeRunContext,
} from "../../orchestration/claude-run-authority";
import {
  captureAuditLine,
  captureCandidates,
  captureEmissionObservation,
  captureUnavailable,
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

/** The capture bound every Claude transcript read observes before decoding. */
const CLAUDE_TRANSCRIPT_MAX_BYTES = 16_777_216;

class ClaudeTranscriptReadError extends Error {}
class ClaudeTranscriptJsonError extends Error {}

export type ClaudePayloadReader = (transcriptPath: string) => readonly FinalPayloadCandidate[];

/** The one bounded transcript read behind every Claude transcript projection,
 *  parsed once. No pre-check: `existsSync` returns false for ELOOP/ENOTDIR too,
 *  which would turn an unreadable transcript into a silent "no candidates"
 *  before the read could surface the cause. Once the locator selected this
 *  path, EVERY read failure — including ENOENT when the file disappeared and an
 *  oversize file — is filesystem evidence the operator must see, never a
 *  missing-payload claim. */
function readClaudeTranscript(transcriptPath: string, maximumBytes: number): ClaudeTranscript {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(readRunBytesNoFollow(transcriptPath, maximumBytes));
  } catch (error) {
    throw new ClaudeTranscriptReadError(
      `cannot read Claude transcript ${transcriptPath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return parseClaudeTranscript(text.split("\n"));
}

/** The final-turn candidates of a transcript; a corrupt final turn is thrown as its typed refusal. */
function candidatesOf(transcript: ClaudeTranscript): readonly FinalPayloadCandidate[] {
  const candidates = claudeTranscriptCandidates(transcript);
  if (!candidates.ok) throw new ClaudeTranscriptJsonError(candidates.error);
  return candidates.value;
}

/**
 * The FINAL TURN payload candidates of a Claude transcript (see
 * `claudeTranscriptCandidates` for the rule): the default `ClaudePayloadReader`.
 * An unreadable transcript throws its read error; a malformed line the final
 * turn reaches throws transcript corruption with its line number.
 */
export function claudeFinalPayloadCandidates(
  transcriptPath: string,
  maximumBytes = CLAUDE_TRANSCRIPT_MAX_BYTES,
): readonly FinalPayloadCandidate[] {
  return candidatesOf(readClaudeTranscript(transcriptPath, maximumBytes));
}

/**
 * The prompt a Claude subagent was spawned with: its transcript's opening user
 * message, written by the harness from the Agent call's prompt. `null` when the
 * opening line is not such a message (it then carries no request marker).
 */
export function claudeSpawnPrompt(transcriptPath: string, maximumBytes = CLAUDE_TRANSCRIPT_MAX_BYTES): BindingResult<string | null> {
  try {
    const prompt = claudeTranscriptSpawnPrompt(readClaudeTranscript(transcriptPath, maximumBytes));
    return prompt.ok ? { ok: true, value: prompt.value } : { ok: false, message: prompt.error };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Establish the run this Claude SubagentStop speaks for, ONCE, for every stop
 * consumer: capture below and `dispatch.ts` both act on the value returned here
 * rather than re-deriving it.
 *
 * When the stop names an issued request whose correlator is not yet recorded —
 * a foreground spawn, whose SubagentStop precedes its Agent call's PostToolUse —
 * the correlator is recorded here from the agent's own spawn prompt and role,
 * through the same write PostToolUse performs, and the stop is then bound.
 */
export async function establishClaudeStopRun(
  input: SubagentStopInput,
  context: ClaudeRunContext,
): Promise<BindingResult<ClaudeRunAuthority>> {
  const nativeId = typeof input.agent_id === "string" ? input.agent_id : "";
  const resolved = resolveClaudeStopRun(context, nativeId, () => {
    const transcriptPath = resolveAgentTranscriptPath(input);
    return transcriptPath === null
      ? { ok: false, message: `no transcript can be located for session ${JSON.stringify(input.session_id ?? "")} agent ${JSON.stringify(nativeId)}, so its spawn prompt cannot prove it is outside this session's bound runs` }
      : claudeSpawnPrompt(transcriptPath);
  });
  if (!resolved.ok) return resolved;
  const authority = resolved.value;
  if (authority.kind !== "uncorrelated") return { ok: true, value: authority };

  let role: string;
  try {
    role = stripNamespace(resolveAgentType(input));
  } catch (error) {
    return { ok: false, message: `cannot resolve the role of Claude agent ${nativeId}: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (role.length === 0) return { ok: false, message: `Claude agent ${nativeId} has no agent role to correlate` };
  const recorded = await recordClaudeSpawnCorrelator(authority.run, { requestId: authority.requestId, role, nativeId });
  return recorded.ok ? { ok: true, value: Object.freeze({ kind: "bound", run: authority.run }) } : recorded;
}


/** The registration's issued emission schema version, as the transcript scan
 *  attributes it — from the DURABLE registration, never from the transcript
 *  or the model (AD-7). Archived v1 and non-review programs bind no version. */
function issuedEmissionVersionOf(
  parsed: ReturnType<typeof parseRegisteredFacadeProgram> | null,
): EmissionSchemaVersion | null {
  if (parsed === null || parsed.kind !== "registered") return null;
  if (parsed.program.kind !== "standalone-review" && parsed.program.kind !== "wave-gate") return null;
  return parsed.program.schemaVersion === 2 ? "v2" : parsed.program.schemaVersion === 3 ? "v3" : null;
}

/**
 * What a Claude SubagentStop's request authority resolution concluded.
 *
 * `bound: null` means the stop is in nobody's orchestration run — the ordinary
 * ad-hoc agent, which the caller must leave alone. Otherwise it names the issued
 * request and the run that issued it. A `false` branch is a fault in the
 * authority itself (an unreadable run, a corrupt correlation) and must fail
 * closed: reading it as "unrelated" would settle a stop whose reserved slot is
 * still waiting.
 */
export type ClaudeRequestAuthority =
  | Readonly<{ ok: true; bound: Readonly<{ request: AgentRequestAuthority; run: ClaudeRun }> | null }>
  | Readonly<{ ok: false; message: string }>;

/**
 * Resolve the issued request this Claude SubagentStop correlator belongs to.
 *
 * `dispatch.ts` needs the request BEFORE it settles the rest of the stop: a
 * request-bound program that is not Wave Gate owns no TaskGraph, and settling it
 * as though it did would demand unrelated protected state after the Run
 * Directory had already accepted the evidence. It asks the SAME
 * `resolveCorrelatedRequest` the capture path below asks, against the SAME
 * established run, so the two can never disagree about which request a stop
 * answers — and it returns an Either rather than throwing, because a caller that
 * turns a refusal into a diagnostic should not have to catch it first.
 */
export function resolveClaudeRequestAuthority(
  input: SubagentStopInput,
  authority: ClaudeRunAuthority,
): ClaudeRequestAuthority {
  if (authority.kind === "unbound") return { ok: true, bound: null };
  const resolved = resolveCorrelatedRequest({
    harness: "claude",
    runsRoot: authority.run.runsRoot,
    runDirectory: authority.run.runDirectory,
    nativeId: typeof input.agent_id === "string" ? input.agent_id : "",
  });
  return resolved.ok
    ? { ok: true, bound: Object.freeze({ request: resolved.value.request, run: authority.run }) }
    : { ok: false, message: describeCaptureFailure(resolved.outcome) };
}

function claudeObservationUnavailable(
  input: SubagentStopInput,
  runsRoot: string | undefined,
  runDirectory: string | undefined,
  reason: string,
  message: string,
): CaptureObservation {
  const correlated = resolveCorrelatedRequest({ harness: "claude", runsRoot, runDirectory, nativeId: input.agent_id ?? "" });
  if (!correlated.ok) return captureUnavailable(reason, message);
  const { handle, request } = correlated.value;
  if (!isReviewAgent(request.role)) return terminalCaptureRefusal(reason, message);
  const packet = handle.readContext(request.contextDigest);
  const stored = handle.readProgramRegistration();
  const parsed = stored.ok && stored.value !== null ? parseRegisteredFacadeProgram(stored.value) : null;
  const historicalRegistration = stored.ok && (stored.value === null ||
    (parsed?.kind === "registered" && parsed.program.schemaVersion === 1));
  if (packet.ok && packet.value.schemaVersion === 1 && historicalRegistration) {
    return terminalCaptureRefusal(reason, message);
  }
  // Current or unavailable reviewer authority cannot spend a semantic attempt
  // on a missing locator/read. This explicit observation lets the shared
  // runtime report a retriable failure without a capture-rejection tombstone.
  return captureUnavailable(reason, message);
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
  // immutable reservation first. An unrelated stop remains `no-reservation`.
  // Actual final-payload refusals can be terminalised against that request;
  // current locator/read unavailability instead preserves its exact attempt.
  // The transcript the observation parsed, kept for the lazy read-coverage
  // tool-output projection (ADR-0022) so the file is read and parsed once.
  let observedTranscript: ClaudeTranscript | null = null;
  const observe = (): CaptureObservation => {
    const transcriptPath = resolveAgentTranscriptPath(input);
    if (transcriptPath === null) {
      return claudeObservationUnavailable(
        input, runsRoot, runDirectory, "transcript-locator",
        `no transcript can be located for session ${JSON.stringify(input.session_id ?? "")} agent ${JSON.stringify(input.agent_id ?? "")}: none was supplied and the derived path does not exist`,
      );
    }
    try {
      const correlated = resolveCorrelatedRequest({ harness: "claude", runsRoot, runDirectory, nativeId: input.agent_id ?? "" });
      const registration = correlated.ok ? correlated.value.handle.readProgramRegistration(16_777_216) : null;
      if (registration !== null && !registration.ok) {
        return captureUnavailable("program-registration", `program registration is unavailable: ${registration.error.message}`);
      }
      const raw = registration?.value ?? null;
      const parsedRegistration = raw === null ? null : parseRegisteredFacadeProgram(raw);
      if (parsedRegistration !== null && parsedRegistration.kind !== "registered") {
        const problem = parsedRegistration.kind === "invalid"
          ? parsedRegistration.message
          : "program registration does not name a registered orchestration program";
        return captureUnavailable("program-registration", `program registration is unavailable: ${problem}`);
      }
      // Every current capture is bounded before decoding. The old unbounded
      // readFileSync branch admitted the impossible foreign escape, because the
      // correlated request carries no schema version to compare against.
      //
      // The default observation reads BOTH closed vocabularies from one
      // bounded parse (T7): the handback-aware final-payload candidates AND the
      // emission-family tool-call frames — so the capture runtime's ONE
      // canonical selection serves Claude too, and a call to an emission tool
      // this request never advertised is refused, never absorbed as absence.
      // A caller-supplied reader owns its WHOLE observation (candidates only);
      // the frame scan is part of the default projection.
      if (readPayload !== claudeFinalPayloadCandidates) return captureCandidates(readPayload(transcriptPath));
      const attributed: ClaudeEmissionAttribution | null = correlated.ok
        ? { requestId: correlated.value.request.requestId, version: issuedEmissionVersionOf(parsedRegistration) }
        : null;
      const transcript = readClaudeTranscript(transcriptPath, CLAUDE_TRANSCRIPT_MAX_BYTES);
      observedTranscript = transcript;
      const candidates = candidatesOf(transcript);
      if (attributed === null) return captureCandidates(candidates);
      const scan = claudeEmissionScan(transcript, attributed);
      return captureEmissionObservation(scan.frames, candidates, scan.walkIncompleteness);
    } catch (error) {
      if (error instanceof ClaudeTranscriptReadError) {
        return claudeObservationUnavailable(input, runsRoot, runDirectory, "transcript-read", error.message);
      }
      if (error instanceof ClaudeTranscriptJsonError) return terminalCaptureRefusal("transcript-json", error.message);
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
    // Only the default projection reads the transcript lines; a caller-supplied
    // payload reader owns its whole observation and supplies no tool outputs.
    ...(readPayload === claudeFinalPayloadCandidates
      ? { observeToolOutputs: () => observedTranscript === null ? Object.freeze([]) : claudeToolOutputs(observedTranscript) }
      : {}),
  });
}

/**
 * Capture one Claude SubagentStop against the run `establishClaudeStopRun`
 * established, and say what the hook must report.
 *
 * A capture, a refusal, and a stop that matched no reservation are all audited;
 * only `not-an-orchestration-run` — an agent in nobody's run — stays silent. A
 * missing rejection would look exactly like a run with nothing to capture. For a
 * bound stop every refusal is a hook error: the run's reserved slot is waiting.
 */
export async function captureClaudeStop(
  input: SubagentStopInput,
  authority: ClaudeRunAuthority,
): Promise<HookResult> {
  const run = authority.kind === "bound" ? authority.run : undefined;
  const outcome = await captureClaudeResult(input, run?.runsRoot, run?.runDirectory);
  const audit = captureAuditLine("capture-orchestration-result", outcome);
  if (audit !== null) process.stderr.write(audit);
  if (authority.kind === "bound" && outcome.kind === "no-reservation") {
    return {
      kind: "error",
      message: `request-bound capture found no reservation for ${outcome.agentId}`,
    };
  }
  if (authority.kind === "bound" &&
      (outcome.kind === "terminal-rejection" || outcome.kind === "retriable-failure")) {
    return {
      kind: "error",
      message: `request-bound capture rejected (${outcome.reason}): ${outcome.message}`,
    };
  }
  return { kind: "passthrough" };
}

const handler: HookHandler = async (stdin): Promise<HookResult> => {
  const parsedInput = parseSubagentStopStdin(stdin);
  if (!parsedInput.ok) {
    // Without a parsed payload there is no session to resolve bindings for, so
    // only an explicit environment authority makes the malformed stop a fault.
    const hasExplicitAuthority = process.env[RUNS_ROOT_ENV] !== undefined || process.env[RUN_DIR_ENV] !== undefined;
    return hasExplicitAuthority
      ? {
          kind: "error",
          message: `request-bound capture rejected: malformed SubagentStop JSON or domain shape: ${parsedInput.error}`,
        }
      : { kind: "passthrough" };
  }

  const authority = await establishClaudeStopRun(parsedInput.value, claudeRunContext(parsedInput.value.session_id));
  if (!authority.ok) return { kind: "error", message: `request-bound capture rejected: ${authority.message}` };
  return captureClaudeStop(parsedInput.value, authority.value);
};

export default handler;
