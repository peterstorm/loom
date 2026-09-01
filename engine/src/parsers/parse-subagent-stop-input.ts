import {
  parseSubagentLifecycleInput,
  parseSubagentLifecycleStdin,
  type ParsedSubagentLifecycleInput,
} from "./parse-subagent-lifecycle-input";

export type ParsedSubagentStopInput = ParsedSubagentLifecycleInput;

/** Parse the untrusted hook wire value before any caller can access identity fields. */
export function parseSubagentStopInput(raw: unknown): ParsedSubagentStopInput {
  return parseSubagentLifecycleInput("SubagentStop", raw);
}

/** Parse the raw stdin JSON and its SubagentStop domain shape in one boundary operation. */
export function parseSubagentStopStdin(stdin: string): ParsedSubagentStopInput {
  return parseSubagentLifecycleStdin("SubagentStop", stdin);
}
