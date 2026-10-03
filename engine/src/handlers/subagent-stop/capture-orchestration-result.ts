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
 * Claude's payload reader and native correlator live here. Capture writes and
 * payload admission are shared with Pi through `harness-capture-runtime`.
 * This adapter also preserves the historical Claude observation-fault policy
 * from the bound packet/registration; current infrastructure unavailability
 * must not consume a reviewer semantic attempt.
 */

import { readFileSync } from "node:fs";
import { readRunBytesNoFollow } from "../../orchestration/no-follow-fs";
import type { HookHandler, HookResult, SubagentStopInput } from "../../types";
import type { AgentRequestAuthority } from "../../core/orchestration-contract";
import { isReviewAgent } from "../../config";
import { parseRegisteredFacadeProgram } from "../helpers/programs";
import { parseSubagentStopStdin } from "../../parsers/parse-subagent-stop-input";
import type { FinalPayloadCandidate } from "../../core/harness-capture";
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

/**
 * Inspect the FINAL TURN of a Claude transcript and hand over the final
 * payload it carries.
 *
 * Claude's transcript is JSONL with one entry per line. Only the final turn is
 * examined — no earlier turn is ever searched as a fallback. Lines that are not
 * conversation entries (`attachment`, `system`, …) carry no payload and are
 * skipped wherever they fall, so a harness bookkeeping line written after the
 * subagent stopped cannot hide its result.
 *
 * The final turn takes one of two shapes:
 *  - legacy: it ends with an assistant line; that line's text blocks are the
 *    candidates.
 *  - SubagentHandback: current Claude Code subagents deliver their report by
 *    calling the `SubagentHandback` tool. The turn then ends with the user
 *    tool_result lines answering the calls of ONE assistant message — which
 *    Claude writes as several assistant lines sharing a message id when the
 *    model made parallel calls. Each `SubagentHandback` call in that message
 *    whose tool_result is present and not an error contributes its string
 *    `input.message`. A failed or unanswered handback delivers nothing; the
 *    message's other blocks (prose, other tool calls) are never a result.
 *
 * A syntactically malformed line is reported as transcript corruption with its
 * line number. Any other final turn yields no candidate, so the payload rules
 * still reject instead of accepting salvage.
 *
 * Several candidates are reported as the ambiguity they are rather than being
 * collapsed here: choosing or joining them is the shared payload rule's
 * decision, and pre-selecting one would turn `ambiguous-final-payload` into an
 * unreachable refusal on this path.
 */
class ClaudeTranscriptReadError extends Error {}
class ClaudeTranscriptJsonError extends Error {}

export type ClaudePayloadReader = (transcriptPath: string) => readonly FinalPayloadCandidate[];

type Block = Readonly<Record<string, unknown>>;

/** One conversation line of the transcript, by role. */
type ConversationLine = Readonly<{ index: number; role: "assistant" | "user"; messageId: string | null; content: readonly Block[] }>;

function readTranscriptLines(transcriptPath: string, maximumBytes?: number): readonly string[] {
  // One read, no pre-check: `existsSync` returns false for ELOOP/ENOTDIR too,
  // which would turn an unreadable transcript into a silent "no candidates"
  // before readFileSync could surface the cause. Once the locator selected this
  // path, EVERY read failure — including ENOENT when the file disappeared — is
  // filesystem evidence the operator must see, never a missing-payload claim.
  try {
    return (maximumBytes === undefined ? readFileSync(transcriptPath, "utf-8")
      : new TextDecoder("utf-8", { fatal: true }).decode(readRunBytesNoFollow(transcriptPath, maximumBytes))).split("\n");
  } catch (error) {
    throw new ClaudeTranscriptReadError(
      `cannot read Claude transcript ${transcriptPath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

const isRecord = (raw: unknown): raw is Readonly<Record<string, unknown>> =>
  typeof raw === "object" && raw !== null && !Array.isArray(raw);

/** The `message` object of one transcript line; malformed JSON is corruption with its 1-based line number. */
function transcriptMessageOf(line: string, zeroBasedLine: number, position: string): Readonly<Record<string, unknown>> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line) as unknown;
  } catch (error) {
    throw new ClaudeTranscriptJsonError(
      `invalid ${position} Claude transcript JSON at line ${zeroBasedLine + 1}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!isRecord(parsed)) return null;
  const message = parsed["message"];
  return isRecord(message) ? message : null;
}

/** A line as a conversation entry, or `null` for anything else (attachments, system lines, …). */
function conversationLineOf(line: string, index: number): ConversationLine | null {
  const message = transcriptMessageOf(line, index, "final");
  if (message === null || !Array.isArray(message["content"])) return null;
  const role = message["role"];
  if (role !== "assistant" && role !== "user") return null;
  return Object.freeze({
    index,
    role,
    messageId: typeof message["id"] === "string" ? message["id"] : null,
    content: (message["content"] as readonly unknown[]).filter(isRecord),
  });
}

const isToolResultLine = (line: ConversationLine): boolean =>
  line.role === "user" && line.content.length > 0 && line.content.every((block) => block["type"] === "tool_result");

const textsOf = (line: ConversationLine): readonly string[] =>
  line.content
    .filter((block) => block["type"] === "text")
    .map((block) => block["text"])
    .filter((text): text is string => typeof text === "string");

/** Delivered handback payloads of one assistant message, given the results that answered it. */
function deliveredHandbacks(
  message: readonly ConversationLine[],
  results: ReadonlyMap<string, boolean>,
): readonly FinalPayloadCandidate[] {
  return message.flatMap((line) => line.content.flatMap((block): FinalPayloadCandidate[] => {
    if (block["type"] !== "tool_use" || block["name"] !== "SubagentHandback" || typeof block["id"] !== "string") return [];
    // Unanswered, or answered with an error: the handback delivered nothing.
    if (results.get(block["id"]) !== false) return [];
    const payload = isRecord(block["input"]) ? block["input"]["message"] : undefined;
    return typeof payload === "string" ? [Object.freeze({ origin: `transcript.line[${line.index}].handback`, text: payload })] : [];
  }));
}

export function claudeFinalPayloadCandidates(transcriptPath: string, maximumBytes?: number): readonly FinalPayloadCandidate[] {
  const lines = readTranscriptLines(transcriptPath, maximumBytes);
  // Walk backwards, parsing only as far as the final turn reaches: a torn or
  // malformed line in an EARLIER turn is not this capture's evidence.
  let cursor = lines.length;
  const previousConversationLine = (): ConversationLine | null => {
    while (--cursor >= 0) {
      if (lines[cursor]!.trim().length === 0) continue;
      const line = conversationLineOf(lines[cursor]!, cursor);
      if (line !== null) return line;
    }
    return null;
  };

  const results = new Map<string, boolean>();
  let caller = previousConversationLine();
  while (caller !== null && isToolResultLine(caller)) {
    for (const block of caller.content) {
      if (typeof block["tool_use_id"] === "string") results.set(block["tool_use_id"], block["is_error"] === true);
    }
    caller = previousConversationLine();
  }
  if (caller === null || caller.role !== "assistant") return Object.freeze([]);
  if (results.size === 0) {
    const last = caller;
    return Object.freeze(textsOf(last).map((text, blockIndex) => Object.freeze({
      origin: `transcript.line[${last.index}].block[${blockIndex}]`,
      text,
    })));
  }

  // The assistant message the results answer: Claude writes one line per block
  // of a multi-call message, all sharing its message id.
  const message: ConversationLine[] = [caller];
  if (caller.messageId !== null) {
    for (let line = previousConversationLine(); line?.role === "assistant" && line.messageId === caller.messageId;
      line = previousConversationLine()) {
      message.unshift(line);
    }
  }
  return Object.freeze(deliveredHandbacks(message, results));
}

/**
 * The prompt a Claude subagent was spawned with: its transcript's opening user
 * message, written by the harness from the Agent call's prompt. `null` when the
 * opening line is not such a message (it then carries no request marker).
 */
export function claudeSpawnPrompt(transcriptPath: string, maximumBytes = 16_777_216): BindingResult<string | null> {
  try {
    const lines = readTranscriptLines(transcriptPath, maximumBytes);
    const openingIndex = lines.findIndex((line) => line.trim().length > 0);
    if (openingIndex < 0) return { ok: true, value: null };
    const message = transcriptMessageOf(lines[openingIndex]!, openingIndex, "opening");
    if (message === null || message["role"] !== "user") return { ok: true, value: null };
    const content = message["content"];
    if (typeof content === "string") return { ok: true, value: content };
    if (!Array.isArray(content)) return { ok: true, value: null };
    const texts = (content as readonly unknown[])
      .filter((block): block is Readonly<Record<string, unknown>> => isRecord(block) && block["type"] === "text")
      .map((block) => block["text"])
      .filter((text): text is string => typeof text === "string");
    return { ok: true, value: texts.join("\n") };
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
      return captureCandidates(readPayload === claudeFinalPayloadCandidates
        ? claudeFinalPayloadCandidates(transcriptPath, 16_777_216) : readPayload(transcriptPath));
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
