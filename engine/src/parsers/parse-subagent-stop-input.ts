import type { SubagentStopInput } from "../types";
import {
  parseSubagentLifecycleInput,
  parseSubagentLifecycleStdin,
} from "./parse-subagent-lifecycle-input";

export type ParsedSubagentStopInput =
  | Readonly<{ ok: true; value: Readonly<SubagentStopInput> }>
  | Readonly<{ ok: false; error: string }>;

/** Parse the untrusted hook wire value before any caller can access identity fields. */
export function parseSubagentStopInput(raw: unknown): ParsedSubagentStopInput {
  return parseSubagentLifecycleInput("SubagentStop", raw);
}

/** Parse the raw stdin JSON and its SubagentStop domain shape in one boundary operation. */
export function parseSubagentStopStdin(stdin: string): ParsedSubagentStopInput {
  return parseSubagentLifecycleStdin("SubagentStop", stdin);
}
