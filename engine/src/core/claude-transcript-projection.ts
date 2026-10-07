/**
 * The Claude transcript projection: everything the engine reads out of one
 * Claude Code subagent transcript, as pure functions over its lines.
 *
 * `parseClaudeTranscript` parses every non-blank JSONL line ONCE and runs the
 * one forward walk over the parsed entries; every projection below reads that
 * value instead of re-parsing or re-walking the text:
 *
 *  - the final-payload candidates (`claudeTranscriptCandidates`, handback-aware,
 *    STRICT about malformed JSON on the lines the final turn reaches);
 *  - the opening spawn prompt (`claudeTranscriptSpawnPrompt`);
 *  - the emission-tool-call frames and the walk's own incompleteness
 *    (`claudeEmissionScan`, TOLERANT, counting what it cannot classify);
 *  - every successful tool result's text (`claudeToolOutputs`, the read-coverage
 *    observation's input, ADR-0022).
 *
 * The emission family is the frozen registry's ONE classification
 * (`emissionToolFamily`, core/emission-tool), the same the Pi adapter uses.
 * No I/O: the shell (handlers/subagent-stop) reads and bounds the bytes; a
 * malformed final turn is a typed failure here, never a throw.
 */
import { emissionToolFamily, type EmissionSchemaVersion } from "./emission-tool";
import type { FinalPayloadCandidate } from "./harness-capture";
import type { EmissionCallFrame } from "./emission-observation";
import type { PayloadProducerKindName } from "./agent-catalog-projections";
import { isRecord } from "./plain-record";

type Block = Readonly<Record<string, unknown>>;

/** One non-blank transcript line, parsed once: its JSON value, or the parse error message. */
type ParsedLine =
  | Readonly<{ index: number; kind: "json"; value: unknown }>
  | Readonly<{ index: number; kind: "json-error"; error: string }>;

interface ToolUseBlock {
  readonly origin: string;
  readonly id: string | null;
  readonly name: unknown;
  readonly input: unknown;
}

type ToolResultCount = Readonly<{ isError: unknown; count: number }>;

/** The forward walk's findings: tool calls, their results, the successful
 *  result texts, and the walk's own incompleteness evidence. */
type ToolWalk = Readonly<{
  toolUses: readonly ToolUseBlock[];
  resultsByCallId: ReadonlyMap<string, ToolResultCount>;
  toolOutputs: readonly string[];
  unclassifiableLineCount: number;
  firstUnclassifiableLineOrigin: string | null;
  orphanResultIds: readonly string[];
}>;

/** One transcript, parsed once and walked once. Opaque to callers: read it only through the projections. */
export type ClaudeTranscript = Readonly<{ lines: readonly ParsedLine[]; walk: ToolWalk }>;

/** What a final-turn read concluded: its candidates, or the 1-based line it found corrupt. */
export type ClaudeTranscriptRead<T> =
  | Readonly<{ ok: true; value: T }>
  | Readonly<{ ok: false; error: string }>;

function parseLine(line: string, index: number): ParsedLine {
  try {
    return Object.freeze({ index, kind: "json", value: JSON.parse(line) as unknown });
  } catch (error) {
    return Object.freeze({ index, kind: "json-error", error: error instanceof Error ? error.message : String(error) });
  }
}

/** The tolerant view of one parsed line: a message with a content array, a
 *  line that is not a JSON object at all, or neither (omitted). */
type TolerantLine =
  | Readonly<{ kind: "message"; index: number; role: unknown; content: readonly unknown[] }>
  | Readonly<{ kind: "unclassifiable"; index: number }>
  | null;

function tolerantLineOf(line: ParsedLine): TolerantLine {
  // Deliberately not `isRecord`: a top-level JSON array is a classifiable
  // (message-less) line, not an unclassifiable one, so it never marks the walk
  // incomplete.
  if (line.kind === "json-error" || typeof line.value !== "object" || line.value === null) {
    return { kind: "unclassifiable", index: line.index };
  }
  const message = (line.value as Record<string, unknown>)["message"];
  if (!isRecord(message)) return null;
  return Array.isArray(message["content"])
    ? { kind: "message", index: line.index, role: message["role"], content: message["content"] }
    : null;
}

/** The text of one successful tool result: one string, or its text blocks joined. */
function toolResultText(content: unknown): string | null {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return null;
  return content.flatMap((item: unknown) =>
    isRecord(item) && item["type"] === "text" && typeof item["text"] === "string" ? [item["text"]] : []).join("\n");
}

/**
 * The ONE forward walk. TOLERANT, like the Pi adapter's independent scan: an
 * unrelated malformed line cannot carry an emission call and is skipped for
 * the frames — but it is COUNTED (AD-8): an unclassifiable line could hide an
 * emission call, so the frame set cannot claim absence over it, and the count
 * plus the orphan tool results surface in the observation instead of being
 * absorbed as silence. Tool outputs skip unclassifiable lines: they can only
 * withhold read credit, never grant it, because each counted page is
 * re-verified against the frozen diff text. Orphan results are sound because
 * the shell rejects oversize transcripts outright — the walk always sees the
 * whole transcript, never a head-truncated window.
 */
function walkToolBlocks(lines: readonly ParsedLine[]): ToolWalk {
  const toolUses: ToolUseBlock[] = [];
  const resultCounts = new Map<string, ToolResultCount>();
  const toolOutputs: string[] = [];
  let unclassifiableLineCount = 0;
  let firstUnclassifiableLineOrigin: string | null = null;
  for (const parsed of lines) {
    const line = tolerantLineOf(parsed);
    if (line === null) continue;
    const origin = `transcript.line[${line.index}]`;
    if (line.kind === "unclassifiable") {
      unclassifiableLineCount += 1;
      firstUnclassifiableLineOrigin ??= origin;
      continue;
    }
    for (const record of line.content) {
      if (!isRecord(record)) continue;
      if (line.role === "assistant" && record["type"] === "tool_use") {
        const id = typeof record["id"] === "string" && record["id"].trim() !== "" ? record["id"] : null;
        toolUses.push({ origin, id, name: record["name"], input: record["input"] });
      } else if (line.role === "user" && record["type"] === "tool_result") {
        const toolUseId = record["tool_use_id"];
        if (typeof toolUseId === "string" && toolUseId !== "") {
          const seen = resultCounts.get(toolUseId);
          resultCounts.set(toolUseId, { isError: record["is_error"], count: (seen?.count ?? 0) + 1 });
        }
        if (record["is_error"] !== true) {
          const text = toolResultText(record["content"]);
          if (text !== null) toolOutputs.push(text);
        }
      }
    }
  }
  const observedCallIds = new Set(toolUses.flatMap(({ id }) => id === null ? [] : [id]));
  return Object.freeze({
    toolUses: Object.freeze(toolUses),
    resultsByCallId: resultCounts,
    toolOutputs: Object.freeze(toolOutputs),
    unclassifiableLineCount,
    firstUnclassifiableLineOrigin,
    orphanResultIds: Object.freeze([...resultCounts.keys()].filter((id) => !observedCallIds.has(id))),
  });
}

/** Parse every non-blank line once and run the one forward walk. */
export function parseClaudeTranscript(lines: readonly string[]): ClaudeTranscript {
  const parsed = Object.freeze(lines.flatMap((line, index) => line.trim().length === 0 ? [] : [parseLine(line, index)]));
  return Object.freeze({ lines: parsed, walk: walkToolBlocks(parsed) });
}

/** The `message` object of one parsed line (strict): a JSON error is corruption with its 1-based line number. */
function strictMessageOf(line: ParsedLine, position: string): ClaudeTranscriptRead<Readonly<Record<string, unknown>> | null> {
  if (line.kind === "json-error") {
    return { ok: false, error: `invalid ${position} Claude transcript JSON at line ${line.index + 1}: ${line.error}` };
  }
  if (!isRecord(line.value)) return { ok: true, value: null };
  const message = line.value["message"];
  return { ok: true, value: isRecord(message) ? message : null };
}

/** One conversation line of the transcript, by role. */
type ConversationLine = Readonly<{ index: number; role: "assistant" | "user"; messageId: string | null; content: readonly Block[] }>;

/** A line as a conversation entry, or `null` for anything else (attachments, system lines, …). */
function conversationLineOf(line: ParsedLine): ClaudeTranscriptRead<ConversationLine | null> {
  const message = strictMessageOf(line, "final");
  if (!message.ok) return message;
  if (message.value === null || !Array.isArray(message.value["content"])) return { ok: true, value: null };
  const role = message.value["role"];
  if (role !== "assistant" && role !== "user") return { ok: true, value: null };
  return {
    ok: true,
    value: Object.freeze({
      index: line.index,
      role,
      messageId: typeof message.value["id"] === "string" ? message.value["id"] : null,
      content: (message.value["content"] as readonly unknown[]).filter(isRecord),
    }),
  };
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

/**
 * The FINAL TURN of a Claude transcript and the final payload it carries.
 *
 * Only the final turn is examined — no earlier turn is ever searched as a
 * fallback. Lines that are not conversation entries (`attachment`, `system`,
 * …) carry no payload and are skipped wherever they fall, so a harness
 * bookkeeping line written after the subagent stopped cannot hide its result.
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
 * A syntactically malformed line the final turn reaches is reported as
 * transcript corruption with its line number; a torn or malformed line in an
 * EARLIER turn is not this read's evidence. Any other final turn yields no
 * candidate, so the payload rules still reject instead of accepting salvage.
 * Several candidates are reported as the ambiguity they are: choosing or
 * joining them is the shared payload rule's decision.
 */
export function claudeTranscriptCandidates(transcript: ClaudeTranscript): ClaudeTranscriptRead<readonly FinalPayloadCandidate[]> {
  const { lines } = transcript;
  // Walk backwards, parsing only as far as the final turn reaches.
  let cursor = lines.length;
  const previousConversationLine = (): ClaudeTranscriptRead<ConversationLine | null> => {
    while (--cursor >= 0) {
      const line = conversationLineOf(lines[cursor]!);
      if (!line.ok || line.value !== null) return line;
    }
    return { ok: true, value: null };
  };
  const results = new Map<string, boolean>();
  let caller = previousConversationLine();
  while (caller.ok && caller.value !== null && isToolResultLine(caller.value)) {
    for (const block of caller.value.content) {
      if (typeof block["tool_use_id"] === "string") results.set(block["tool_use_id"], block["is_error"] === true);
    }
    caller = previousConversationLine();
  }
  if (!caller.ok) return caller;
  const last = caller.value;
  if (last === null || last.role !== "assistant") return { ok: true, value: Object.freeze([]) };
  if (results.size === 0) {
    return {
      ok: true,
      value: Object.freeze(textsOf(last).map((text, blockIndex) => Object.freeze({
        origin: `transcript.line[${last.index}].block[${blockIndex}]`,
        text,
      }))),
    };
  }
  // The assistant message the results answer: Claude writes one line per
  // block of a multi-call message, all sharing its message id.
  const message: ConversationLine[] = [last];
  if (last.messageId !== null) {
    for (let line = previousConversationLine(); ; line = previousConversationLine()) {
      if (!line.ok) return line;
      if (line.value?.role !== "assistant" || line.value.messageId !== last.messageId) break;
      message.unshift(line.value);
    }
  }
  return { ok: true, value: Object.freeze(deliveredHandbacks(message, results)) };
}

/**
 * The prompt a Claude subagent was spawned with: its transcript's opening user
 * message, written by the harness from the Agent call's prompt. `null` when the
 * opening line is not such a message (it then carries no request marker).
 */
export function claudeTranscriptSpawnPrompt(transcript: ClaudeTranscript): ClaudeTranscriptRead<string | null> {
  const opening = transcript.lines[0];
  if (opening === undefined) return { ok: true, value: null };
  const message = strictMessageOf(opening, "opening");
  if (!message.ok) return message;
  if (message.value === null || message.value["role"] !== "user") return { ok: true, value: null };
  const content = message.value["content"];
  if (typeof content === "string") return { ok: true, value: content };
  if (!Array.isArray(content)) return { ok: true, value: null };
  const texts = (content as readonly unknown[])
    .filter((block): block is Readonly<Record<string, unknown>> => isRecord(block) && block["type"] === "text")
    .map((block) => block["text"])
    .filter((text): text is string => typeof text === "string");
  return { ok: true, value: texts.join("\n") };
}

/** Every successful tool result's text, in transcript order (ADR-0022). An
 *  `is_error` result delivered nothing the Agent can be credited with reading. */
export function claudeToolOutputs(transcript: ClaudeTranscript): readonly string[] {
  return transcript.walk.toolOutputs;
}

/** What the frame scan attributes to each observed call: the correlated
 *  request's id (verified, never trusted, by the selection's binding check)
 *  and the registration's issued schema version — version and digest come
 *  from the ISSUED registration, never from the model's arguments (AD-7). */
export type ClaudeEmissionAttribution = Readonly<{
  requestId: string;
  version: EmissionSchemaVersion | null;
}>;

/** The emission-call frame scan's result: the observed call frames, and BESIDE
 *  them (never as one of them) the walk's own incompleteness, or `null` when
 *  the walk classified every line and correlated every tool result. */
export type ClaudeEmissionScan = Readonly<{
  frames: readonly EmissionCallFrame[];
  walkIncompleteness: string | null;
}>;

const incomplete = (toolCallId: string | null, reason: string): EmissionCallFrame =>
  Object.freeze({ kind: "incomplete" as const, toolCallId, reason });

/** One observed emission-family call as its frame: the guards run in order and
 *  the first that fails names why the call is incomplete. */
function emissionCallFrame(
  toolUse: ToolUseBlock,
  producerKind: PayloadProducerKindName,
  resultsByCallId: ReadonlyMap<string, ToolResultCount>,
  attributed: ClaudeEmissionAttribution,
): EmissionCallFrame {
  const { id, origin } = toolUse;
  if (id === null) {
    return incomplete(null, `an emission tool call to ${JSON.stringify(toolUse.name)} was observed without a recoverable tool-call identity (${origin})`);
  }
  if (attributed.version === null) {
    return incomplete(id, `emission tool call ${id} carries no issued schema version to bind against (${origin})`);
  }
  if (!isRecord(toolUse.input)) {
    return incomplete(id, `emission tool call ${id} was observed with ${JSON.stringify(toolUse.input)} arguments, not an object (${origin})`);
  }
  const result = resultsByCallId.get(id);
  if (result === undefined) return incomplete(id, `emission tool call ${id} has no finalized tool result (${origin})`);
  if (result.count !== 1) {
    return incomplete(id, `emission tool call ${id} has ${result.count} finalized tool results; exactly one is required (${origin})`);
  }
  if (result.isError === true) return incomplete(id, `emission tool call ${id} failed (${origin})`);
  return Object.freeze({
    kind: "complete" as const,
    call: Object.freeze({
      requestId: attributed.requestId,
      toolCallId: id,
      kind: Object.freeze({ kind: producerKind }),
      version: attributed.version,
      arguments: Object.freeze({ ...toolUse.input }),
    }),
  });
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
 *
 * The walk's own incompleteness is returned BESIDE the call frames, not as
 * one of them: it is evidence about the transcript, and a refusal under
 * extraction-only authority must name the walk instead of counting it as an
 * observed emission call.
 */
export function claudeEmissionScan(transcript: ClaudeTranscript, attributed: ClaudeEmissionAttribution): ClaudeEmissionScan {
  const { walk } = transcript;
  const frames = walk.toolUses.flatMap((toolUse): EmissionCallFrame[] => {
    const family = emissionToolFamily(toolUse.name);
    if (family.kind === "unrelated") return [];
    return [family.kind === "unregistered-emission-name"
      ? incomplete(toolUse.id, `${toolUse.origin} names tool ${JSON.stringify(toolUse.name)}, which selects no frozen registry producer kind`)
      : emissionCallFrame(toolUse, family.producerKind, walk.resultsByCallId, attributed)];
  });
  // An incomplete walk is represented as itself, never reclassified as
  // absence (AD-8; the upheld capture-review critical): an unclassifiable
  // line could carry the emission call and an orphan tool result proves a
  // tool_use was lost, so "zero emission frames" would be a claim the walk
  // cannot prove. The capture runtime refuses it under every authority —
  // never absorbing the loss as silence.
  const complete = walk.unclassifiableLineCount === 0 && walk.orphanResultIds.length === 0;
  const orphanPart = walk.orphanResultIds.length === 0 ? "" :
    `; ${walk.orphanResultIds.length} orphan tool result(s) with call ids ${walk.orphanResultIds.slice(0, 5).join(", ")}${walk.orphanResultIds.length > 5 ? ", …" : ""} whose tool_use block was never observed`;
  return Object.freeze({
    frames: Object.freeze(frames),
    walkIncompleteness: complete ? null
      : `the transcript line walk is incomplete (${walk.unclassifiableLineCount} unclassifiable line(s)` +
        (walk.firstUnclassifiableLineOrigin === null ? "" : `, first at ${walk.firstUnclassifiableLineOrigin}`) +
        `${orphanPart}); an emission call could be hidden there, so the emission observation cannot claim absence (AD-8)`,
  });
}

/** The scan as ONE closed frame list, the walk's incompleteness as a trailing
 *  call-less incomplete frame — the shape an emission-authority fold sees. */
export function claudeEmissionFrames(transcript: ClaudeTranscript, attributed: ClaudeEmissionAttribution): readonly EmissionCallFrame[] {
  const scan = claudeEmissionScan(transcript, attributed);
  return scan.walkIncompleteness === null
    ? scan.frames
    : Object.freeze([...scan.frames, incomplete(null, scan.walkIncompleteness)]);
}
