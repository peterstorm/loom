import {
  parseSubagentLifecycleStdin,
  type ParsedSubagentLifecycleInput,
} from "./parse-subagent-lifecycle-input";

export type ParsedSubagentStopInput = ParsedSubagentLifecycleInput;

/** Parse the raw stdin JSON and its SubagentStop domain shape in one boundary operation. */
export function parseSubagentStopStdin(stdin: string): ParsedSubagentStopInput {
  return parseSubagentLifecycleStdin("SubagentStop", stdin);
}
