/**
 * Validate review-invoker called /review-pr skill.
 * Warning only — actual validation done by store-reviewer-findings.
 */

import { existsSync, readFileSync } from "node:fs";
import type { HookHandler, SubagentStopInput } from "../../types";
import { parseTranscript } from "../../parsers/parse-transcript";

const handler: HookHandler = async (stdin) => {
  const input: SubagentStopInput = JSON.parse(stdin);

  const agentType = (input.agent_type ?? "").replace(/^[^:]+:/, "");
  if (agentType !== "review-invoker") return { kind: "passthrough" };

  const transcriptContent = input.agent_transcript_path && existsSync(input.agent_transcript_path)
    ? readFileSync(input.agent_transcript_path, "utf-8")
    : "";
  const transcript = parseTranscript(transcriptContent);

  if (/(review-pr|\/review-pr|Launching skill: review-pr)/i.test(transcript)) {
    process.stderr.write("review-invoker correctly invoked /review-pr\n");
  } else {
    process.stderr.write("WARNING: review-invoker may not have invoked /review-pr\n");
  }

  return { kind: "passthrough" };
};

export default handler;
