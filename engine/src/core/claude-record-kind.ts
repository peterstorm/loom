/**
 * The one classification of a Claude Code transcript record: is it the
 * subagent's conversation, or harness metadata written beside it?
 *
 * Claude Code writes more than the conversation into a subagent transcript:
 * `attachment`, `system`, and request telemetry (`api-request`,
 * `api-request-shape`, `api-request-blob`). An `api-request-blob` carries a
 * `message` that is a content-addressed COPY of a request body — earlier
 * turns replayed with roles `user`, `assistant` or `system`. Read as
 * conversation, those copies would duplicate tool calls, resurrect stale test
 * output after newer runs, and make strict schemas reject a healthy
 * transcript. Only `user` and `assistant` records are the conversation; every
 * other typed record is harness metadata and is never evidence.
 *
 * A record without a string `type` is classified as conversation: the legacy
 * untyped line shape the tolerant extractors have always read. The strict
 * integrity boundary separately requires every record to carry a type.
 */

export const CLAUDE_CONVERSATION_RECORD_TYPES = Object.freeze(["user", "assistant"] as const);

export type ClaudeConversationRecordType = typeof CLAUDE_CONVERSATION_RECORD_TYPES[number];

export type ClaudeRecordKind = "conversation" | "harness";

/** Classify one parsed JSONL value. Total over unknown input. */
export function claudeRecordKind(record: unknown): ClaudeRecordKind {
  if (typeof record !== "object" || record === null) return "conversation";
  const type = (record as Readonly<Record<string, unknown>>)["type"];
  return typeof type !== "string" || (CLAUDE_CONVERSATION_RECORD_TYPES as readonly string[]).includes(type)
    ? "conversation"
    : "harness";
}
