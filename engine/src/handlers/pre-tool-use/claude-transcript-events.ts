/**
 * Claude Code transcript JSONL → the rules gate's harness-neutral
 * `TranscriptEvent`s. The Claude half of the adapter pair (the Pi half is
 * `pi/rules-gate.ts`); the decision itself lives once, in `core/rules-gate`.
 *
 * Pure: text in, events out. Lines that are not JSON objects are dropped —
 * parse, don't validate.
 */

import { READ_TOOL_MAX_LINES, type TranscriptEvent } from "../../core/rules-gate";
import { isRecord } from "../../core/plain-record";
import { stripNamespace } from "../../utils/strip-namespace";

const asString = (value: unknown): string => (typeof value === "string" ? value : "");

const positiveInt = (value: unknown, fallback: number): number =>
  typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;


const COMMAND_NAME_RE = /<command-name>\/?([^<\s]+)<\/command-name>/;

const toolUseEvent = (block: Record<string, unknown>, messageId: string): TranscriptEvent => {
  const callId = asString(block["id"]);
  const input = isRecord(block["input"]) ? block["input"] : {};
  const path = asString(input["file_path"]);
  switch (block["name"]) {
    case "Read":
      return path === ""
        ? { kind: "other-call", callId, messageId }
        : {
            kind: "read", callId, messageId, path,
            offset: positiveInt(input["offset"], 1),
            limit: Math.min(READ_TOOL_MAX_LINES, positiveInt(input["limit"], READ_TOOL_MAX_LINES)),
          };
    case "Write":
      return path === "" ? { kind: "other-call", callId, messageId } : { kind: "write", callId, messageId, path };
    case "Skill":
      return asString(input["skill"]) === ""
        ? { kind: "other-call", callId, messageId }
        : { kind: "skill", callId, messageId, name: stripNamespace(asString(input["skill"])) };
    case "Bash":
      return asString(input["command"]) === ""
        ? { kind: "other-call", callId, messageId }
        : { kind: "command", callId, messageId, command: asString(input["command"]) };
    default:
      return { kind: "other-call", callId, messageId };
  }
};

const assistantEvents = (entry: Record<string, unknown>): readonly TranscriptEvent[] => {
  const message = isRecord(entry["message"]) ? entry["message"] : {};
  const content = Array.isArray(message["content"]) ? message["content"] : [];
  const messageId = asString(message["id"]) || asString(entry["uuid"]);
  return content.filter(isRecord).flatMap((block): readonly TranscriptEvent[] =>
    block["type"] === "tool_use"
      ? [toolUseEvent(block, messageId)]
      : block["type"] === "text" && typeof block["text"] === "string"
        ? [{ kind: "text", messageId, text: block["text"] }]
        : [],
  );
};

const userEvents = (entry: Record<string, unknown>): readonly TranscriptEvent[] => {
  const message = isRecord(entry["message"]) ? entry["message"] : {};
  const content = message["content"];
  if (typeof content === "string") {
    const command = COMMAND_NAME_RE.exec(content);
    return command?.[1] === undefined ? [] : [{ kind: "skill-command", name: stripNamespace(command[1]) }];
  }
  return (Array.isArray(content) ? content : []).filter(isRecord).flatMap((block): readonly TranscriptEvent[] =>
    block["type"] === "tool_result"
      ? [{ kind: "result", callId: asString(block["tool_use_id"]), ok: block["is_error"] !== true }]
      : [],
  );
};

const isCompactBoundary = (entry: Record<string, unknown>): boolean =>
  entry["type"] === "system" && entry["subtype"] === "compact_boundary";

const entryEvents = (entry: Record<string, unknown>): readonly TranscriptEvent[] =>
  entry["type"] === "assistant" ? assistantEvents(entry) : entry["type"] === "user" ? userEvents(entry) : [];

const parseLine = (line: string): Record<string, unknown> | undefined => {
  try {
    const parsed: unknown = JSON.parse(line);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    // A torn trailing line (transcript still being flushed) is not evidence.
    return undefined;
  }
};

/**
 * Events in the model's CURRENT context: everything after the last compaction
 * boundary. Lines that are not JSON objects are skipped — parse, don't validate.
 */
export function parseTranscriptEvents(jsonl: string): readonly TranscriptEvent[] {
  return jsonl
    .split("\n")
    .map(parseLine)
    .reduce<readonly TranscriptEvent[]>((events, entry) =>
      entry === undefined ? events : isCompactBoundary(entry) ? [] : [...events, ...entryEvents(entry)], []);
}
