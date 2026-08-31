import type { SubagentStartInput } from "../types";
import {
  parseSubagentLifecycleInput,
  parseSubagentLifecycleStdin,
} from "./parse-subagent-lifecycle-input";

export type ParsedSubagentStartInput =
  | Readonly<{ ok: true; value: Readonly<SubagentStartInput> }>
  | Readonly<{ ok: false; error: string }>;

/** Parse the untrusted hook wire value before any caller can access identity fields. */
export function parseSubagentStartInput(raw: unknown): ParsedSubagentStartInput {
  return parseSubagentLifecycleInput("SubagentStart", raw);
}

/** Parse raw stdin JSON and its SubagentStart domain shape in one boundary operation. */
export function parseSubagentStartStdin(stdin: string): ParsedSubagentStartInput {
  return parseSubagentLifecycleStdin("SubagentStart", stdin);
}
