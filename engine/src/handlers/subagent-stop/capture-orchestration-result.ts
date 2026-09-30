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
 * Claude's payload reader and native correlator live here. Capture writes and
 * payload admission are shared with Pi through `harness-capture-runtime`.
 * This adapter also preserves the historical Claude observation-fault policy
 * from the bound packet/registration; current infrastructure unavailability
 * must not consume a reviewer semantic attempt.
 *
 * The default transcript projection (T7) observes BOTH closed vocabularies
 * from one bounded line walk: the final-payload candidates exactly as before,
 * plus the assistant emission-tool-call frames — so the shared runtime's ONE
 * canonical selection serves Claude too, and a call to an emission tool this
 * request never advertised is REFUSED (extraction-only authority cannot be
 * upgraded), never absorbed as absence. A caller-supplied payload reader owns
 * its whole observation, candidates only.
 */

import { readFileSync } from "node:fs";
import { readRunBytesNoFollow } from "../../orchestration/no-follow-fs";
import type { HookHandler, HookResult, SubagentStopInput } from "../../types";
import type { AgentRequestAuthority } from "../../core/orchestration-contract";
import { EMISSION_TOOL_SPECS, type EmissionSchemaVersion } from "../../core/emission-tool";
import { isReviewAgent } from "../../config";
import { parseRegisteredFacadeProgram } from "../helpers/programs";
import { parseSubagentStopStdin } from "../../parsers/parse-subagent-stop-input";
import type { EmissionCallFrame, FinalPayloadCandidate } from "../../core/harness-capture";
import type { PayloadProducerKindName } from "../../core/model-profiles";
import { resolveAgentTranscriptPath } from "../../utils/agent-transcript-path";
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

/** The bounded transcript read behind BOTH transcript projections. One read,
 *  no pre-check: `existsSync` returns false for ELOOP/ENOTDIR too, which would
 *  turn an unreadable transcript into a silent "no candidates" before
 *  readFileSync could surface the cause. Once the locator selected this path,
 *  EVERY read failure — including ENOENT when the file disappeared — is
 *  filesystem evidence the operator must see, never a missing-payload claim. */
function claudeTranscriptLines(transcriptPath: string, maximumBytes?: number): readonly string[] {
  try {
    return (maximumBytes === undefined ? readFileSync(transcriptPath, "utf-8")
      : new TextDecoder("utf-8", { fatal: true }).decode(readRunBytesNoFollow(transcriptPath, maximumBytes))).split("\n");
  } catch (error) {
    throw new ClaudeTranscriptReadError(
      `cannot read Claude transcript ${transcriptPath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export function claudeFinalPayloadCandidates(transcriptPath: string, maximumBytes?: number): readonly FinalPayloadCandidate[] {
  return claudeCandidatesFromLines(claudeTranscriptLines(transcriptPath, maximumBytes));
}

function claudeCandidatesFromLines(lines: readonly string[]): readonly FinalPayloadCandidate[] {
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

// ---------------------------------------------------------------------------
// Emission-family transcript observation (T7; AD-8, FR-014)
// ---------------------------------------------------------------------------

/**
 * The engine-side projection of the closed emission-tool family — the same
 * frozen-registry classification `pi/emission-tool` projects on the Pi side,
 * derived here from the SAME registry source with the SAME duplicate-name
 * invariant guard, because the engine adapter cannot import the pi module
 * (pi → engine, never outward). A registered name carries its registry
 * producer kind; a PREFIX-reserved name the registry does not freeze is an
 * observed-but-unbindable emission call; everything else is unrelated.
 */
export type ClaudeEmissionToolFamily =
  | Readonly<{ kind: "unrelated" }>
  | Readonly<{ kind: "registered"; producerKind: PayloadProducerKindName }>
  | Readonly<{ kind: "unregistered-emission-name" }>;

const EMISSION_TOOL_NAME_PREFIX = "loom_emit_";

const producerKindsByToolName = (): ReadonlyMap<string, PayloadProducerKindName> => {
  const projection = new Map<string, PayloadProducerKindName>();
  for (const [kindName, spec] of Object.entries(EMISSION_TOOL_SPECS)) {
    if (projection.has(spec.toolName)) {
      throw new Error(`emission tool registry invariant failed: duplicate tool name ${spec.toolName}`);
    }
    projection.set(spec.toolName, kindName as PayloadProducerKindName);
  }
  return projection;
};

const claudeKindByToolName = producerKindsByToolName();

export function claudeEmissionToolFamily(toolName: unknown): ClaudeEmissionToolFamily {
  if (typeof toolName !== "string") return Object.freeze({ kind: "unrelated" as const });
  const registeredKind = claudeKindByToolName.get(toolName);
  if (registeredKind !== undefined) {
    return Object.freeze({ kind: "registered" as const, producerKind: registeredKind });
  }
  return toolName.startsWith(EMISSION_TOOL_NAME_PREFIX)
    ? Object.freeze({ kind: "unregistered-emission-name" as const })
    : Object.freeze({ kind: "unrelated" as const });
}

/** What the frame scan attributes to each observed call: the correlated
 *  request's id (verified, never trusted, by the selection's binding check)
 *  and the registration's issued schema version — version and digest come
 *  from the ISSUED registration, never from the model's arguments (AD-7). */
export type ClaudeEmissionAttribution = Readonly<{
  requestId: string;
  version: EmissionSchemaVersion | null;
}>;

interface ClaudeToolUseBlock {
  readonly origin: string;
  readonly id: string | null;
  readonly name: unknown;
  readonly input: unknown;
}

/** Collect the assistant `tool_use` blocks and the tool results (keyed by
 *  `tool_use_id`) from one bounded line walk. TOLERANT, like the Pi adapter's
 *  independent scan: an unrelated malformed line cannot carry an emission
 *  call and is skipped for the FRAMES only — the final-line candidates keep
 *  their strict malformed-JSON refusal through `assistantTextBlocksOf`. */
function collectClaudeToolBlocks(lines: readonly string[]): {
  readonly toolUses: readonly ClaudeToolUseBlock[];
  readonly resultsByCallId: ReadonlyMap<string, { readonly isError: unknown; readonly count: number }>;
} {
  const toolUses: ClaudeToolUseBlock[] = [];
  const resultCounts = new Map<string, { isError: unknown; count: number }>();
  for (const [lineIndex, line] of lines.entries()) {
    if (line.trim().length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line) as unknown;
    } catch {
      continue; // An unparseable unrelated line carries no emission call.
    }
    if (typeof parsed !== "object" || parsed === null) continue;
    const message = (parsed as Record<string, unknown>)["message"];
    if (typeof message !== "object" || message === null) continue;
    const record = message as Record<string, unknown>;
    if (!Array.isArray(record["content"])) continue;
    const origin = `transcript.line[${lineIndex}]`;
    if (record["role"] === "assistant") {
      for (const block of record["content"] as readonly unknown[]) {
        if (typeof block !== "object" || block === null) continue;
        const toolUse = block as Record<string, unknown>;
        if (toolUse["type"] !== "tool_use") continue;
        const id = typeof toolUse["id"] === "string" && toolUse["id"].trim() !== "" ? toolUse["id"] : null;
        toolUses.push({ origin, id, name: toolUse["name"], input: toolUse["input"] });
      }
      continue;
    }
    if (record["role"] === "user") {
      for (const block of record["content"] as readonly unknown[]) {
        if (typeof block !== "object" || block === null) continue;
        const toolResult = block as Record<string, unknown>;
        if (toolResult["type"] !== "tool_result") continue;
        const toolUseId = toolResult["tool_use_id"];
        if (typeof toolUseId !== "string" || toolUseId === "") continue;
        const seen = resultCounts.get(toolUseId);
        resultCounts.set(toolUseId, { isError: toolResult["is_error"], count: (seen?.count ?? 0) + 1 });
      }
    }
  }
  return { toolUses: Object.freeze(toolUses), resultsByCallId: resultCounts };
}

/**
 * The emission-tool-call frames observed in a Claude transcript — the same
 * closed vocabulary the Pi adapter projects, so the capture runtime's ONE
 * fold and selection serve both harnesses (FR-033's shared refusals).
 *
 * ASSISTANT TOOL CALLS ONLY (AD-8): JSON pasted into text is a
 * `FinalPayloadCandidate`, never an emission frame. FAMILY BY REGISTRY, NOT
 * BY SHAPE. Successful execution only (AS-021): a call becomes complete only
 * when its transcript also carries exactly one finalized, successful
 * `tool_result` — aborted, failed, missing, duplicate, or mismatched results
 * become incomplete frames, so a streamed-but-unexecuted call can never
 * become authoritative output. An incomplete observation is REPRESENTABLE as
 * itself and the runtime's fold refuses it — never reclassified as absence.
 */
export function claudeEmissionFramesFromLines(
  lines: readonly string[],
  attributed: ClaudeEmissionAttribution,
): readonly EmissionCallFrame[] {
  const { toolUses, resultsByCallId } = collectClaudeToolBlocks(lines);
  const frames: EmissionCallFrame[] = [];
  for (const toolUse of toolUses) {
    const family = claudeEmissionToolFamily(toolUse.name);
    if (family.kind === "unrelated") continue;
    if (family.kind === "unregistered-emission-name") {
      frames.push(Object.freeze({
        kind: "incomplete" as const,
        toolCallId: toolUse.id,
        reason: `${toolUse.origin} names tool ${JSON.stringify(toolUse.name)}, which selects no frozen registry producer kind`,
      }));
      continue;
    }
    if (toolUse.id === null) {
      frames.push(Object.freeze({
        kind: "incomplete" as const,
        toolCallId: null,
        reason: `an emission tool call to ${JSON.stringify(toolUse.name)} was observed without a recoverable tool-call identity (${toolUse.origin})`,
      }));
      continue;
    }
    if (attributed.version === null) {
      frames.push(Object.freeze({
        kind: "incomplete" as const,
        toolCallId: toolUse.id,
        reason: `emission tool call ${toolUse.id} carries no issued schema version to bind against (${toolUse.origin})`,
      }));
      continue;
    }
    if (typeof toolUse.input !== "object" || toolUse.input === null || Array.isArray(toolUse.input)) {
      frames.push(Object.freeze({
        kind: "incomplete" as const,
        toolCallId: toolUse.id,
        reason: `emission tool call ${toolUse.id} was observed with ${JSON.stringify(toolUse.input)} arguments, not an object (${toolUse.origin})`,
      }));
      continue;
    }
    const result = resultsByCallId.get(toolUse.id);
    if (result === undefined || result.count !== 1) {
      frames.push(Object.freeze({
        kind: "incomplete" as const,
        toolCallId: toolUse.id,
        reason: result === undefined
          ? `emission tool call ${toolUse.id} has no finalized tool result (${toolUse.origin})`
          : `emission tool call ${toolUse.id} has ${result.count} finalized tool results; exactly one is required (${toolUse.origin})`,
      }));
      continue;
    }
    if (result.isError === true) {
      frames.push(Object.freeze({
        kind: "incomplete" as const,
        toolCallId: toolUse.id,
        reason: `emission tool call ${toolUse.id} failed (${toolUse.origin})`,
      }));
      continue;
    }
    frames.push(Object.freeze({
      kind: "complete" as const,
      call: Object.freeze({
        requestId: attributed.requestId,
        toolCallId: toolUse.id,
        kind: Object.freeze({ kind: family.producerKind }),
        version: attributed.version,
        arguments: Object.freeze({ ...(toolUse.input as Record<string, unknown>) }),
      }),
    }));
  }
  return Object.freeze(frames);
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
      //
      // The default transcript projection observes BOTH closed vocabularies
      // from one bounded line walk (T7): the unchanged final-payload candidates
      // AND the emission-family tool-call frames — so the capture runtime's ONE
      // canonical selection serves Claude too, and a call to an emission tool
      // this request never advertised is refused, never absorbed as absence.
      // A caller-supplied reader owns its WHOLE observation (candidates only);
      // the frame scan is part of the default projection.
      if (readPayload !== claudeFinalPayloadCandidates) return captureCandidates(readPayload(transcriptPath));
      const attributed: ClaudeEmissionAttribution | null = correlated.ok
        ? { requestId: correlated.value.request.requestId, version: issuedEmissionVersionOf(parsedRegistration) }
        : null;
      const lines = claudeTranscriptLines(transcriptPath, 16_777_216);
      const candidates = claudeCandidatesFromLines(lines);
      return attributed === null
        ? captureCandidates(candidates)
        : captureEmissionObservation(claudeEmissionFramesFromLines(lines, attributed), candidates);
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
