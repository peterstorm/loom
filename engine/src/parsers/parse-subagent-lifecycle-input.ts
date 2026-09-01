export type SubagentLifecycleEvent = "SubagentStart" | "SubagentStop";

export type SubagentLifecycleInput = Readonly<{
  session_id: string;
  agent_id?: string;
  agent_type?: string;
  agent_transcript_path?: string;
}>;

export type ParsedSubagentLifecycleInput =
  | Readonly<{ ok: true; value: SubagentLifecycleInput }>
  | Readonly<{ ok: false; error: string }>;

const OPTIONAL_STRING_FIELDS = ["agent_id", "agent_type", "agent_transcript_path"] as const;

/** Parse one untrusted subagent lifecycle wire value with event-specific diagnostics. */
export function parseSubagentLifecycleInput(
  event: SubagentLifecycleEvent,
  raw: unknown,
): ParsedSubagentLifecycleInput {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return Object.freeze({ ok: false, error: `${event} input must be a JSON object` });
  }
  const record = raw as Record<string, unknown>;
  if (typeof record.session_id !== "string") {
    return Object.freeze({
      ok: false,
      error: `${event} missing/invalid session id; session_id must be a string`,
    });
  }
  for (const field of OPTIONAL_STRING_FIELDS) {
    if (record[field] !== undefined && typeof record[field] !== "string") {
      return Object.freeze({ ok: false, error: `${event} ${field} must be a string when present` });
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

/** Parse raw stdin JSON and one subagent lifecycle domain shape. */
export function parseSubagentLifecycleStdin(
  event: SubagentLifecycleEvent,
  stdin: string,
): ParsedSubagentLifecycleInput {
  let raw: unknown;
  try {
    raw = JSON.parse(stdin) as unknown;
  } catch (error) {
    return Object.freeze({
      ok: false,
      error: `${event} input is malformed JSON: ${error instanceof Error ? error.message : String(error)}`,
    });
  }
  return parseSubagentLifecycleInput(event, raw);
}
