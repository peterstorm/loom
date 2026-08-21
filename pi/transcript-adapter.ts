/** Pi subagent messages adapted to the Claude-compatible JSONL parsers. */

import { attributeExit, classifyTestCommandDetailed, type ClassifiedTestCommand } from "../engine/src/machine";
import { splitCommandSegmentsWithOps, stripComment, stripEnvPrefix } from "../engine/src/core/shell-command";
import { extractTestEvidence } from "../engine/src/core/test-evidence";

const TOOL_NAME_MAP: Readonly<Record<string, string>> = Object.freeze({
  bash: "Bash",
  write: "Write",
  edit: "Edit",
  read: "Read",
  find: "Find",
  grep: "Grep",
  ls: "Ls",
});

export type PiContentBlock =
  | Readonly<{ type: "text"; text: string }>
  | Readonly<{
      type: "toolCall";
      id: string;
      name: string;
      arguments: Readonly<Record<string, unknown>>;
    }>
  | Readonly<{ type: "opaque"; originalType: string }>;

export interface PiMessage {
  readonly role: string;
  readonly content: readonly PiContentBlock[];
  readonly toolCallId?: string;
  readonly toolName?: string;
  readonly isError?: boolean;
}

export type PiTranscriptResult<T> =
  | Readonly<{ ok: true; value: T }>
  | Readonly<{ ok: false; errors: readonly string[] }>;

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parsePiContentBlock(
  block: unknown,
  label: string,
  errors: string[],
): PiContentBlock | null {
  if (!isRecord(block) || typeof block.type !== "string" || block.type.trim() === "") {
    errors.push(`${label} must be a typed content block`);
    return null;
  }
  if (block.type === "text") {
    if (typeof block.text !== "string") {
      errors.push(`${label}.text must be a string`);
      return null;
    }
    return Object.freeze({ type: "text", text: block.text });
  }
  if (block.type === "toolCall") {
    const id = typeof block.id === "string" && block.id.trim() !== "" ? block.id : null;
    const name = typeof block.name === "string" && block.name.trim() !== "" ? block.name : null;
    const argumentsValue = isRecord(block.arguments) ? block.arguments : null;
    if (id === null) errors.push(`${label}.id must be non-empty`);
    if (name === null) errors.push(`${label}.name must be non-empty`);
    if (argumentsValue === null) errors.push(`${label}.arguments must be an object`);
    if (name?.toLowerCase() === "bash" &&
        (argumentsValue === null || typeof argumentsValue.command !== "string")) {
      errors.push(`${label}.arguments.command must be a string for Bash`);
    }
    if (id === null || name === null || argumentsValue === null) return null;
    return Object.freeze({
      type: "toolCall",
      id,
      name,
      arguments: Object.freeze({ ...argumentsValue }),
    });
  }
  return Object.freeze({ type: "opaque", originalType: block.type });
}

/** Parse the untrusted harness payload once so every consumer receives fresh,
 * immutable messages whose complete trusted shape has already been proven. */
export function parsePiMessages(messages: unknown): PiTranscriptResult<readonly PiMessage[]> {
  if (!Array.isArray(messages)) return { ok: false, errors: ["messages must be an array"] };
  const errors: string[] = [];
  const parsedMessages: PiMessage[] = [];
  messages.forEach((message, messageIndex) => {
    const messageLabel = `messages[${messageIndex}]`;
    if (!isRecord(message)) {
      errors.push(`${messageLabel} must be an object`);
      return;
    }
    const role = typeof message.role === "string" && message.role.trim() !== ""
      ? message.role
      : null;
    if (role === null) errors.push(`${messageLabel}.role must be a non-empty string`);

    const contentValue = message.content;
    const isStringContent = role !== null && typeof contentValue === "string";
    const isArrayContent = Array.isArray(contentValue);
    const isSingletonContentBlock = isRecord(contentValue);
    let contentBlocks: readonly (readonly [unknown, string])[];
    if (isArrayContent) {
      contentBlocks = contentValue.map(
        (block, blockIndex) => [block, `${messageLabel}.content[${blockIndex}]`] as const,
      );
    } else if (isSingletonContentBlock) {
      contentBlocks = [[contentValue, `${messageLabel}.content`] as const];
    } else {
      contentBlocks = [];
    }
    if (!isStringContent && !isArrayContent && !isSingletonContentBlock) {
      errors.push(`${messageLabel}.content must be an array, string, or typed content block`);
      return;
    }

    const blockErrorsBefore = errors.length;
    const content: PiContentBlock[] = isStringContent
      ? [Object.freeze({ type: "text", text: contentValue })]
      : [];
    for (const [block, label] of contentBlocks) {
      const parsedBlock = parsePiContentBlock(block, label, errors);
      if (parsedBlock !== null) content.push(parsedBlock);
    }

    const toolCallId = typeof message.toolCallId === "string" && message.toolCallId.trim() !== ""
      ? message.toolCallId
      : null;
    const toolName = typeof message.toolName === "string" && message.toolName.trim() !== ""
      ? message.toolName
      : null;
    if (message.toolCallId !== undefined && toolCallId === null) {
      errors.push(`${messageLabel}.toolCallId must be non-empty when present`);
    }
    if (message.toolName !== undefined && toolName === null) {
      errors.push(`${messageLabel}.toolName must be non-empty when present`);
    }
    if (message.role === "toolResult") {
      if (toolCallId === null) errors.push(`${messageLabel}.toolCallId must be non-empty`);
      if (toolName === null) errors.push(`${messageLabel}.toolName must be non-empty`);
    }
    if (message.isError !== undefined && typeof message.isError !== "boolean") {
      errors.push(`${messageLabel}.isError must be a boolean when present`);
    }

    if (role !== null && errors.length === blockErrorsBefore) {
      parsedMessages.push(Object.freeze({
        role,
        content: Object.freeze(content),
        ...(toolCallId === null ? {} : { toolCallId }),
        ...(toolName === null ? {} : { toolName }),
        ...(typeof message.isError === "boolean" ? { isError: message.isError } : {}),
      }));
    }
  });
  return errors.length > 0
    ? { ok: false, errors: Object.freeze(errors) }
    : { ok: true, value: Object.freeze(parsedMessages) };
}

/** An explicit zero-failure marker from the common runner summaries. The
 *  anti-stripping guard for relaxed (non-attributable) compositions: a green
 *  verdict may only be minted when the paired output itself still contains
 *  the runner's zero-failure line, so laundering pipelines that STRIP the
 *  failure counter (`bun test 2>&1 | grep -v fail`) stay fail-closed.
 *  Deliberately NARROW: it matches only runners whose GREEN summary prints
 *  a zero counter (`0 fail` — bun/cargo; `Failures: 0`/`Errors: 0` —
 *  surefire). vitest/pytest/jest green output has no such token, so the
 *  relax is inert for them — the standard attribution path (sole/last
 *  `&&`-attributable segment) still covers the canonical `cd x && runner`
 *  shape there, and anything the relax refuses fails closed (the extension
 *  logs a diagnostic naming exactly why). */
const ZERO_FAILURE_MARKER = /\b0 fail(?:ed|ing)?\b|\bFailures: 0\b|\bErrors: 0\b/;

/** May a non-attributable composition be relaxed — i.e. is the paired output
 *  provably the test runner's OWN, uncontaminated by any other command's
 *  stdout? Two conditions, both structural:
 *
 *  - every segment BEFORE the test is a `cd` preamble (`cd X && bun test` is
 *    the canonical shape). A successful paired result plus the strict runner
 *    summary can keep stdout attributable across that preamble; this does not
 *    claim that `cd` is outcome-neutral or leaves test selection unchanged.
 *    Any other prior (`false && bun test`, `git stash && bun test`) means the
 *    test may never have run.
 *  - every segment AFTER the test is a proven stdin-only PIPE stage. The narrow
 *    grammar admits `tail` without file operands and `tee` with inert path
 *    operands; an arbitrary pipe command can ignore stdin and fabricate a green
 *    summary just as easily as a sequenced trailer. A `;`/`&&`/`||`/`&` command
 *    after the test is also refused because its stdout is concatenated into the
 *    paired output and would be read as the verdict.
 *
 *  A segment that cannot be located or proven stdin-derived fails closed. */
function isStdinDerivedPipeStage(stage: string): boolean {
  if (/^tail(?:\s+-n\s+[1-9][0-9]*)?$/.test(stage)) return true;
  const [command, ...rawArguments] = stage.split(/\s+/);
  if (command !== "tee") return false;
  const withoutAppend = rawArguments[0] === "-a" ? rawArguments.slice(1) : rawArguments;
  const paths = withoutAppend[0] === "--" ? withoutAppend.slice(1) : withoutAppend;
  return paths.every((path) => !path.startsWith("-") && /^[A-Za-z0-9_./-]+$/.test(path));
}

function relaxableComposition(command: string, classified: ClassifiedTestCommand): boolean {
  const segments = splitCommandSegmentsWithOps(command)
    .map((s) => ({ text: stripEnvPrefix(stripComment(s.text).trim()), opBefore: s.opBefore }))
    .filter((s) => s.text !== "");
  const ownIndex = segments.findIndex((s) => s.text === classified.segment);
  if (ownIndex === -1) return false;
  const priorsAreCd = segments.slice(0, ownIndex).every((s) => {
    const head = s.text.split(/\s+/, 1)[0] ?? "";
    return head === "cd" || /^cd\//.test(head);
  });
  if (!priorsAreCd) return false;
  return segments.slice(ownIndex + 1)
    .every((segment) => segment.opBefore === "|" && isStdinDerivedPipeStage(segment.text));
}

/**
 * PI-path exit attribution: the standard rule first (a test segment can own
 * the line's exit only in provable compositions); when it refuses, a relax
 * only for the structured path — where the paired OUTPUT is present and its
 * own summary is the verdict — not for the Claude/ledger paths. The relax
 * requires: the line was not backgrounded, the Bash result was not an error,
 * and the composition is relaxable (see relaxableComposition — the test is
 * headed only by `cd` and trailed only by parser-proven stdin-derived stages,
 * so the paired output is the runner's own). The verdict is then governed by
 * the output summary, and the strict zero-failure marker (caller side) closes
 * line-stripping laundering.
 */
function attributeExitForStructuredEvidence(
  exit: number | null,
  classified: ClassifiedTestCommand,
  command: string,
): { attributed: number | null; relaxed: boolean } {
  const standard = attributeExit(exit, classified);
  if (standard !== null) return { attributed: standard, relaxed: false };
  if (exit !== 0) return { attributed: null, relaxed: false };
  if (classified.isBackgrounded) return { attributed: null, relaxed: false };
  if (!relaxableComposition(command, classified)) return { attributed: null, relaxed: false };
  return { attributed: 0, relaxed: true };
}

/**
 * Diagnosable structured-capture trace: what the pairing saw, and why the
 * last classified test pair did not mint structured evidence. Logged by the
 * extension whenever the transcript fallback is used, so a future "why is
 * the wave gate blocked" stops being a forensic mystery.
 */
export interface PiStructuredTestDiagnostics {
  readonly classifiedCommands: readonly string[];
  readonly attributedPairs: number;
  readonly verdict: "structured" | "relaxed" | "no-test-command" | "exit-not-attributable" | "strict-summary-refused" | "no-paired-result";
}

/**
 * One walk over Pi's messages that pairs each classified test toolCall with
 * its toolResult and attributes an exit code to it.
 *
 * `piStructuredTestDiagnostics` and `piStructuredTestResult` each carried a
 * private copy of this walk — the same toolCall map keyed by tool-call id, the
 * same `attributeExitForStructuredEvidence` pairing, the same text join. They
 * are supposed to explain the SAME evidence, one as a verdict and one as a
 * diagnosis, so a divergence between the copies would make the diagnosis
 * describe a run the verdict never saw.
 *
 * Emitted as events rather than a return value because the two consumers
 * accumulate different things: the diagnostic counts classifications and
 * refusals, the verdict only cares about paired results.
 */
type TestPairEvent =
  | Readonly<{ kind: "classified"; command: string }>
  | Readonly<{ kind: "attribution-refused" }>
  | Readonly<{
      kind: "paired";
      attributed: ReturnType<typeof attributeExitForStructuredEvidence>;
      text: string;
    }>;

/** Pair only parser-proven test commands with their exact Pi tool result.
 * Standard pairs require the test segment to own the Bash exit status; the
 * narrow structured-output relaxation instead derives the verdict from the
 * runner's uncontaminated summary and explicit zero-failure marker. */
function* structuredTestPairs(messages: readonly PiMessage[]): Generator<TestPairEvent> {
  const testCalls = new Map<string, Readonly<{ command: string; classified: ClassifiedTestCommand }>>();
  for (const message of messages) {
    if (message.role === "assistant") {
      for (const block of message.content ?? []) {
        if (block.type !== "toolCall" || block.name?.toLowerCase() !== "bash" || !block.id) continue;
        const command = typeof block.arguments?.command === "string" ? block.arguments.command : "";
        const classified = classifyTestCommandDetailed(command);
        if (classified === null) continue;
        testCalls.set(block.id, { command, classified });
        yield { kind: "classified", command };
      }
      continue;
    }
    if (message.role !== "toolResult" || !message.toolCallId) continue;
    const entry = testCalls.get(message.toolCallId);
    if (entry === undefined) continue;
    const attributed = attributeExitForStructuredEvidence(
      message.isError === true ? 1 : 0,
      entry.classified,
      entry.command,
    );
    if (attributed.attributed === null) {
      yield { kind: "attribution-refused" };
      continue;
    }
    const text = (message.content ?? [])
      .filter((block) => block.type === "text")
      .map((block) => block.text ?? "")
      .join("\n");
    yield { kind: "paired", attributed, text };
  }
}

export function piStructuredTestDiagnostics(
  input: unknown,
): PiTranscriptResult<PiStructuredTestDiagnostics> {
  const parsed = parsePiMessages(input);
  if (!parsed.ok) return parsed;
  const classifiedCommands: string[] = [];
  let attributedPairs = 0;
  let verdict: PiStructuredTestDiagnostics["verdict"] = "no-test-command";
  let sawClassified = false;
  let sawAttributionRefusal = false;
  for (const event of structuredTestPairs(parsed.value)) {
    if (event.kind === "classified") {
      sawClassified = true;
      if (!classifiedCommands.includes(event.command)) classifiedCommands.push(event.command);
      continue;
    }
    if (event.kind === "attribution-refused") {
      sawAttributionRefusal = true;
      continue;
    }
    attributedPairs++;
    const evidence = extractTestEvidence(event.text);
    if (!evidence.passed) {
      verdict = "structured"; // a genuine structured FAIL also resolves the trace
      continue;
    }
    if (event.attributed.relaxed && !ZERO_FAILURE_MARKER.test(event.text)) {
      verdict = "strict-summary-refused";
      continue;
    }
    verdict = event.attributed.relaxed ? "relaxed" : "structured";
  }
  let finalVerdict: PiStructuredTestDiagnostics["verdict"];
  if (attributedPairs > 0) {
    finalVerdict = verdict;
  } else if (!sawClassified) {
    finalVerdict = "no-test-command";
  } else if (sawAttributionRefusal) {
    finalVerdict = "exit-not-attributable";
  } else {
    finalVerdict = "no-paired-result";
  }
  return {
    ok: true,
    value: Object.freeze({
      classifiedCommands: Object.freeze(classifiedCommands),
      attributedPairs,
      verdict: finalVerdict,
    }),
  };
}

export function piStructuredTestResult(
  input: unknown,
): PiTranscriptResult<{ passed: boolean; evidence: string } | null> {
  const parsed = parsePiMessages(input);
  if (!parsed.ok) return parsed;
  let latest: { passed: boolean; evidence: string } | null = null;
  for (const event of structuredTestPairs(parsed.value)) {
    if (event.kind !== "paired") continue;
    const parsedEvidence = extractTestEvidence(event.text);
    // A relaxed (non-attributable) composition may only mint a GREEN verdict
    // when the output still carries the runner's explicit zero-failure line;
    // a structured FAIL is always taken (the gate rejects it either way).
    if (parsedEvidence.passed && event.attributed.relaxed && !ZERO_FAILURE_MARKER.test(event.text)) continue;
    latest = {
      passed: event.attributed.attributed === 0 && parsedEvidence.passed,
      evidence: parsedEvidence.evidence,
    };
  }
  return { ok: true, value: latest };
}

/**
 * Convert Pi's toolCall/toolResult message shape into the JSONL shape consumed
 * by Loom's transcript parsers. Tool-call IDs are preserved so anti-spoofing
 * parsers can pair a real command with its exact result.
 */
/** Text blocks normalised to a defined `text`; every other block passes through
 *  untouched. The toolResult and user branches below mapped identical closures. */
function normalizedTextBlocks(content: readonly PiContentBlock[]): readonly unknown[] {
  return content.map((block) => block.type === "text" ? { type: "text", text: block.text ?? "" } : block);
}

export function messagesToClaudeJsonl(input: unknown): PiTranscriptResult<string> {
  const parsed = parsePiMessages(input);
  if (!parsed.ok) return parsed;
  const lines: string[] = [];

  for (const msg of parsed.value) {
    if (msg.role === "assistant") {
      const content = msg.content.map((block) => {
        if (block.type === "toolCall") {
          if (!block.name || !block.id) throw new Error("validated Pi tool call lost its identity");
          return {
            type: "tool_use",
            name: TOOL_NAME_MAP[block.name] ?? block.name,
            id: block.id,
            input: block.arguments ?? {},
          };
        }
        if (block.type === "text") return { type: "text", text: block.text ?? "" };
        return block;
      });
      lines.push(JSON.stringify({ message: { role: "assistant", content } }));
      continue;
    }

    if (msg.role === "toolResult") {
      if (!msg.toolCallId) throw new Error("validated Pi tool result lost its call identity");
      const resultContent = normalizedTextBlocks(msg.content);
      lines.push(JSON.stringify({
        message: {
          role: "user",
          content: [{
            type: "tool_result",
            tool_use_id: msg.toolCallId,
            content: resultContent,
          }],
        },
      }));
      continue;
    }

    if (msg.role === "user") {
      lines.push(JSON.stringify({ message: { role: "user", content: normalizedTextBlocks(msg.content) } }));
    }
  }

  return { ok: true, value: lines.length === 0 ? "" : `${lines.join("\n")}\n` };
}

/**
 * Collect every candidate final text payload from a Pi subagent result.
 *
 * Deliberately COLLECTS rather than selects. A Pi result is a list of content
 * blocks, and more than one text block means the engine genuinely cannot tell
 * which is the Agent's final answer. Returning them all lets
 * `parseFinalPayload` refuse the ambiguity; picking the last one here would
 * bury that decision in an adapter and hash whichever block happened to come
 * last as if it were the result.
 *
 * Text is passed through verbatim — no trim, no join, no normalisation — so
 * the bytes hashed on the Pi side are byte-identical to Claude's for the same
 * Agent output.
 */
export function piFinalPayloadCandidates(
  content: unknown,
): PiTranscriptResult<readonly Readonly<{ origin: string; text: string }>[]> {
  if (!Array.isArray(content)) {
    return { ok: false, errors: ["pi result content must be an array of blocks"] };
  }
  const candidates: Readonly<{ origin: string; text: string }>[] = [];
  for (const [index, block] of content.entries()) {
    if (!isRecord(block) || block["type"] !== "text") continue;
    const text = block["text"];
    if (typeof text !== "string") {
      return { ok: false, errors: [`pi text block at index ${index} carries no string text`] };
    }
    candidates.push({ origin: `content[${index}].text`, text });
  }
  return { ok: true, value: Object.freeze(candidates) };
}

/**
 * Every candidate final payload from a whole Pi subagent RESULT.
 *
 * Claude's transcript makes "the final assistant text" unambiguous by
 * construction — one message per JSONL line, so the adapter reads the last
 * assistant line. Pi hands back a message list, so the equivalent is the LAST
 * assistant message's content blocks; anything earlier is mid-conversation, not
 * the Agent's answer.
 *
 * Ambiguity inside that message is still refused rather than resolved here:
 * `piFinalPayloadCandidates` collects every text block and `parseFinalPayload`
 * decides, so a two-text-block final message is a rejection on both harnesses
 * instead of a silent "pick the last one" in one of them.
 */
export function piResultFinalPayloadCandidates(
  messages: unknown,
): PiTranscriptResult<readonly Readonly<{ origin: string; text: string }>[]> {
  const parsed = parsePiMessages(messages);
  if (!parsed.ok) return parsed;
  for (let index = parsed.value.length - 1; index >= 0; index -= 1) {
    const message = parsed.value[index];
    if (message === undefined || message.role !== "assistant") continue;
    return piFinalPayloadCandidates(message.content);
  }
  return { ok: true, value: Object.freeze([]) };
}
