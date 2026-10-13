/**
 * The real recorded Pi `subagent` tool_result, parsed once into the fields the
 * capture tests read. A refreshed fixture that drifts from this shape fails
 * here with a named fixture-shape error, not as an undefined-property
 * TypeError deep inside a test.
 *
 * `results` stays raw: the production parsers under test own its shape.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const FIXTURE = fileURLToPath(new URL("./subagent-code-reviewer-result.json", import.meta.url));

export type RecordedContentBlock = Readonly<{ type: string; text?: string }>;
export type RecordedMessage = Readonly<{ role: string; content: readonly RecordedContentBlock[] }>;

export type RecordedSubagentEvent = Readonly<{
  /** The whole event, exactly as recorded, for handing to an event handler. */
  raw: Readonly<Record<string, unknown>>;
  toolName: string;
  toolCallId: string;
  input: Readonly<{ agent: string; task: string }>;
  results: readonly unknown[];
  /** The first result's transcript, as Pi recorded it. */
  messages: readonly RecordedMessage[];
  /** The reviewer's answer: the text block of the last message. */
  payload: string;
}>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function fixtureShape(problem: string): never {
  throw new Error(`recorded Pi fixture has an unexpected shape: ${problem}`);
}

function stringField(record: Record<string, unknown>, key: string, where: string): string {
  const value = record[key];
  return typeof value === "string" ? value : fixtureShape(`${where}.${key} is not a string`);
}

/** Real Pi messages carry either a block array or (the `custom` role) a bare
 *  string; a string reads as one text block, as `parsePiMessages` normalizes it. */
function parseMessage(value: unknown, index: number): RecordedMessage {
  const where = `messages[${index}]`;
  if (!isRecord(value)) return fixtureShape(`${where} is not an object`);
  const role = stringField(value, "role", where);
  if (typeof value.content === "string") return { role, content: [{ type: "text", text: value.content }] };
  if (!Array.isArray(value.content)) return fixtureShape(`${where}.content is neither a string nor an array`);
  const content = value.content.map((block, blockIndex): RecordedContentBlock => {
    if (!isRecord(block)) return fixtureShape(`${where}.content[${blockIndex}] is not an object`);
    const type = stringField(block, "type", `${where}.content[${blockIndex}]`);
    return typeof block.text === "string" ? { type, text: block.text } : { type };
  });
  return { role, content };
}

export function parseRecordedSubagentEvent(document: unknown): RecordedSubagentEvent {
  if (!isRecord(document) || !isRecord(document.event)) return fixtureShape("no `event` object");
  const event = document.event;
  if (!isRecord(event.input)) return fixtureShape("event.input is not an object");
  if (!isRecord(event.details) || !Array.isArray(event.details.results)) return fixtureShape("event.details.results is not an array");
  const results: readonly unknown[] = event.details.results;
  const first = results[0];
  if (!isRecord(first) || !Array.isArray(first.messages)) return fixtureShape("results[0].messages is not an array");
  const messages = first.messages.map(parseMessage);
  const payload = messages.at(-1)?.content.find(({ type }) => type === "text")?.text;
  if (payload === undefined) return fixtureShape("the last message has no text block");
  return {
    raw: event,
    toolName: stringField(event, "toolName", "event"),
    toolCallId: stringField(event, "toolCallId", "event"),
    input: { agent: stringField(event.input, "agent", "event.input"), task: stringField(event.input, "task", "event.input") },
    results,
    messages,
    payload,
  };
}

export const recordedSubagentEvent = (): RecordedSubagentEvent =>
  parseRecordedSubagentEvent(JSON.parse(readFileSync(FIXTURE, "utf8")));

/** The request identity a replay binds the recorded call to. */
export type ReplayIdentity = Readonly<{ requestId: string; contextDigest: string }>;

const rebindMarkers = (task: string, identity: ReplayIdentity): string => task
  .replace(/^LOOM_REQUEST_ID: .*$/m, `LOOM_REQUEST_ID: ${identity.requestId}`)
  .replace(/^LOOM_CONTEXT_DIGEST: .*$/m, `LOOM_CONTEXT_DIGEST: ${identity.contextDigest}`);

/**
 * The recorded event with its request identity markers — and nothing else —
 * rebound to a staged run. The recording names the request of the run it came
 * from, which the extension correctly refuses to capture into any other run.
 */
export function replayRecordedEvent(event: RecordedSubagentEvent, identity: ReplayIdentity): Readonly<Record<string, unknown>> {
  const [first, ...rest] = event.results as readonly Record<string, unknown>[];
  if (first === undefined || typeof first.task !== "string") return fixtureShape("results[0].task is not a string");
  return {
    ...event.raw,
    input: { ...(event.raw.input as Record<string, unknown>), task: rebindMarkers(event.input.task, identity) },
    details: { ...(event.raw.details as Record<string, unknown>), results: [{ ...first, task: rebindMarkers(first.task, identity) }, ...rest] },
  };
}
