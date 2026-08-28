import type { SubagentStopInput } from "../types";

export type ParsedSubagentStopInput =
  | Readonly<{ ok: true; value: Readonly<SubagentStopInput> }>
  | Readonly<{ ok: false; error: string }>;

const OPTIONAL_STRING_FIELDS = ["agent_id", "agent_type", "agent_transcript_path"] as const;

/** Parse the untrusted hook wire value before any caller can access identity fields. */
export function parseSubagentStopInput(raw: unknown): ParsedSubagentStopInput {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return Object.freeze({ ok: false, error: "SubagentStop input must be a JSON object" });
  }
  const record = raw as Record<string, unknown>;
  if (typeof record.session_id !== "string") {
    return Object.freeze({ ok: false, error: "SubagentStop missing/invalid session id; session_id must be a string" });
  }
  for (const field of OPTIONAL_STRING_FIELDS) {
    if (record[field] !== undefined && typeof record[field] !== "string") {
      return Object.freeze({ ok: false, error: `SubagentStop ${field} must be a string when present` });
    }
  }
  return Object.freeze({
    ok: true,
    value: Object.freeze({
      session_id: record.session_id,
      ...(typeof record.agent_id === "string" ? { agent_id: record.agent_id } : {}),
      ...(typeof record.agent_type === "string" ? { agent_type: record.agent_type } : {}),
      ...(typeof record.agent_transcript_path === "string"
        ? { agent_transcript_path: record.agent_transcript_path }
        : {}),
    }),
  });
}

/** Parse the raw stdin JSON and its SubagentStop domain shape in one boundary operation. */
export function parseSubagentStopStdin(stdin: string): ParsedSubagentStopInput {
  let raw: unknown;
  try {
    raw = JSON.parse(stdin) as unknown;
  } catch (error) {
    return Object.freeze({
      ok: false,
      error: `SubagentStop input is malformed JSON: ${error instanceof Error ? error.message : String(error)}`,
    });
  }
  return parseSubagentStopInput(raw);
}
