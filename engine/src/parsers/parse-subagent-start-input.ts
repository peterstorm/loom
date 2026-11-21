import {
  parseSubagentLifecycleStdin,
  type ParsedSubagentLifecycleInput,
} from "./parse-subagent-lifecycle-input";

export type ParsedSubagentStartInput = ParsedSubagentLifecycleInput;

/** Parse raw stdin JSON and its SubagentStart domain shape in one boundary operation. */
export function parseSubagentStartStdin(stdin: string): ParsedSubagentStartInput {
  return parseSubagentLifecycleStdin("SubagentStart", stdin);
}
