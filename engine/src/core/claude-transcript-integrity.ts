/**
 * Pure anti-corruption boundary for modern Claude Code JSONL transcripts.
 *
 * Every nonblank line and every message content block must parse before the
 * original bytes can become completion evidence authority. Supported block
 * arms accept surplus fields for forward compatibility; unknown discriminants
 * fail closed.
 */

const MAX_REASON_LENGTH = 4_096;
const MAX_CONTENT_DEPTH = 8;

export const CLAUDE_CONTENT_BLOCK_TYPES = Object.freeze([
  "text",
  "thinking",
  "tool_use",
  "server_tool_use",
  "tool_result",
  "fallback",
] as const);

export type ClaudeContentBlockType = typeof CLAUDE_CONTENT_BLOCK_TYPES[number];

type SurplusFields = Readonly<Record<string, unknown>>;

export type ClaudeTextBlock = SurplusFields & Readonly<{
  type: "text";
  text: string;
}>;

export type ClaudeThinkingBlock = SurplusFields & Readonly<{
  type: "thinking";
  thinking: string;
  signature?: string;
}>;

export type ClaudeToolUseBlock = SurplusFields & Readonly<{
  type: "tool_use" | "server_tool_use";
  id: string;
  name: string;
  input: Readonly<Record<string, unknown>>;
}>;

export type ClaudeToolResultBlock = SurplusFields & Readonly<{
  type: "tool_result";
  tool_use_id: string;
  content: ClaudeMessageContent;
  is_error?: boolean;
}>;

export type ClaudeFallbackBlock = SurplusFields & Readonly<{
  type: "fallback";
  from: Readonly<Record<string, unknown>> & Readonly<{ model: string }>;
  to: Readonly<Record<string, unknown>> & Readonly<{ model: string }>;
}>;

export type ClaudeContentBlock =
  | ClaudeTextBlock
  | ClaudeThinkingBlock
  | ClaudeToolUseBlock
  | ClaudeToolResultBlock
  | ClaudeFallbackBlock;

export type ClaudeMessageContent = string | readonly ClaudeContentBlock[];

export type ClaudeTranscriptMessage = SurplusFields & Readonly<{
  role: "user" | "assistant";
  content: ClaudeMessageContent;
}>;

export type ClaudeTranscriptRecord = SurplusFields & Readonly<{
  type: string;
  message?: ClaudeTranscriptMessage;
}>;

declare const COMPLETE_CLAUDE_JSONL: unique symbol;
export type CompleteClaudeJsonl = string & { readonly [COMPLETE_CLAUDE_JSONL]: true };

/** Malformed input carries no partial transcript value by construction. */
export type ClaudeJsonlIntegrity =
  | Readonly<{
      kind: "complete";
      transcript: CompleteClaudeJsonl;
      records: readonly ClaudeTranscriptRecord[];
    }>
  | Readonly<{
      kind: "malformed";
      line: number | null;
      reason: string;
    }>;

type UnknownRecord = Record<string, unknown>;

const freeze = <const T extends object>(value: T): Readonly<T> => Object.freeze(value);
const freezeArray = <T>(values: readonly T[]): readonly T[] => Object.freeze([...values]);

function isRecord(raw: unknown): raw is UnknownRecord {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return false;
  const prototype: unknown = Object.getPrototypeOf(raw);
  return prototype === null || prototype === Object.prototype;
}

function owns(record: UnknownRecord, field: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, field);
}

function nonEmptyStringField(record: UnknownRecord, field: string, path: string): string | null {
  const value = record[field];
  return typeof value === "string" && value.trim() !== ""
    ? null
    : `${path}.${field} must be a non-empty string`;
}

function optionalStringField(record: UnknownRecord, field: string, path: string): string | null {
  return !owns(record, field) || typeof record[field] === "string"
    ? null
    : `${path}.${field} must be a string when present`;
}

function modelEndpointError(raw: unknown, path: string): string | null {
  if (!isRecord(raw)) return `${path} must be a plain object`;
  return nonEmptyStringField(raw, "model", path);
}

function supportedBlockType(raw: unknown): raw is ClaudeContentBlockType {
  return typeof raw === "string" &&
    (CLAUDE_CONTENT_BLOCK_TYPES as readonly string[]).includes(raw);
}

function contentBlockError(block: UnknownRecord, path: string, depth: number): string | null {
  if (!supportedBlockType(block.type)) {
    return `${path}.type must be one of ${CLAUDE_CONTENT_BLOCK_TYPES.join(", ")}`;
  }
  switch (block.type) {
    case "text":
      return typeof block.text === "string" ? null : `${path}.text must be a string for a text block`;
    case "thinking": {
      if (typeof block.thinking !== "string") return `${path}.thinking must be a string for a thinking block`;
      return optionalStringField(block, "signature", path);
    }
    case "tool_use":
    case "server_tool_use": {
      const idError = nonEmptyStringField(block, "id", path);
      if (idError !== null) return idError;
      const nameError = nonEmptyStringField(block, "name", path);
      if (nameError !== null) return nameError;
      return isRecord(block.input) ? null : `${path}.input must be a plain object for a tool-use block`;
    }
    case "tool_result": {
      const idError = nonEmptyStringField(block, "tool_use_id", path);
      if (idError !== null) return idError;
      if (!owns(block, "content")) return `${path}.content is required for a tool-result block`;
      if (owns(block, "is_error") && typeof block.is_error !== "boolean") {
        return `${path}.is_error must be a boolean when present`;
      }
      return claudeContentError(block.content, `${path}.content`, depth + 1);
    }
    case "fallback": {
      const fromError = modelEndpointError(block.from, `${path}.from`);
      return fromError ?? modelEndpointError(block.to, `${path}.to`);
    }
  }
}

function claudeContentError(raw: unknown, path: string, depth: number): string | null {
  if (typeof raw === "string") return null;
  if (!Array.isArray(raw)) return `${path} must be a string or an array of content blocks`;
  if (depth > MAX_CONTENT_DEPTH) return `${path} exceeds the supported nested content depth`;
  for (let index = 0; index < raw.length; index += 1) {
    if (!Object.prototype.hasOwnProperty.call(raw, index)) return `${path}[${index}] must be present`;
    const block = raw[index];
    const blockPath = `${path}[${index}]`;
    if (!isRecord(block)) return `${blockPath} must be a plain object`;
    const error = contentBlockError(block, blockPath, depth);
    if (error !== null) return error;
  }
  return null;
}

function claudeRecordError(raw: unknown, path: string): string | null {
  if (!isRecord(raw)) return `${path} must be a plain object`;
  const typeError = nonEmptyStringField(raw, "type", path);
  if (typeError !== null) return typeError;
  if (!owns(raw, "message")) return null;
  if (!isRecord(raw.message)) return `${path}.message must be a plain object when present`;
  if (raw.message.role !== "user" && raw.message.role !== "assistant") {
    return `${path}.message.role must be user or assistant`;
  }
  if (!owns(raw.message, "content")) return `${path}.message.content is required when message is present`;
  return claudeContentError(raw.message.content, `${path}.message.content`, 0);
}

/**
 * Total strict JSONL parser. An empty transcript, malformed tail, unsupported
 * block, or malformed supported arm cannot expose completion authority.
 */
export function parseCompleteClaudeJsonl(raw: unknown): ClaudeJsonlIntegrity {
  if (typeof raw !== "string") {
    return freeze({ kind: "malformed", line: null, reason: "Claude JSONL transcript must be a string" });
  }
  const records: ClaudeTranscriptRecord[] = [];
  const lines = raw.split(/\r?\n/u);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (line.trim() === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line) as unknown;
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : String(cause);
      return freeze({
        kind: "malformed",
        line: index + 1,
        reason: `Claude JSONL transcript record ${index + 1} is malformed or truncated: ${detail}`.slice(0, MAX_REASON_LENGTH),
      });
    }
    const schemaError = claudeRecordError(parsed, `Claude JSONL transcript record ${index + 1}`);
    if (schemaError !== null || !isRecord(parsed)) {
      return freeze({
        kind: "malformed",
        line: index + 1,
        reason: (schemaError ?? `Claude JSONL transcript record ${index + 1} is invalid`).slice(0, MAX_REASON_LENGTH),
      });
    }
    records.push(Object.freeze(parsed) as ClaudeTranscriptRecord);
  }
  if (records.length === 0) {
    return freeze({
      kind: "malformed",
      line: null,
      reason: "Claude JSONL transcript must contain at least one supported record",
    });
  }
  return freeze({
    kind: "complete",
    transcript: raw as CompleteClaudeJsonl,
    records: freezeArray(records),
  });
}
