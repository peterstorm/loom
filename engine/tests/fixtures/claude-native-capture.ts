/**
 * The one test adapter of Claude Code's native capture seam: what a Claude
 * subagent leaves behind when it stops — a transcript file (`<agentId>.jsonl`:
 * any tool-read lines, then the final assistant message) — and the
 * SubagentStop payload that names it by the harness's own `agent_id`.
 *
 * The entry point that consumes the stop is the caller's parameter: the
 * security verification harness hands it to `captureClaudeResult`, the
 * standalone native capturer to the SubagentStop dispatch handler. Both share
 * this record layout, so a change to the Claude transcript shape lands here
 * once.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** The SubagentStop payload Claude Code delivers for one stopped agent. */
export type ClaudeSubagentStop = Readonly<{
  session_id: string;
  agent_id: string;
  agent_type: string;
  agent_transcript_path: string;
}>;

export type ClaudeStoppedAgent = Readonly<{
  sessionId: string;
  /** The harness's own id for the spawn (`agent_id`): correlator and transcript name. */
  agentId: string;
  agentType: string;
  /** Where the agent's transcript is written. */
  transcriptDirectory: string;
  /** The final assistant message's text blocks. */
  finalTexts: readonly string[];
  /** Transcript records before the final message (the agent's tool reads). */
  leadingRecords?: readonly string[];
}>;

/** The final assistant message, as one Claude transcript record. */
const finalMessageRecord = (texts: readonly string[]): string =>
  JSON.stringify({ message: { role: "assistant", content: texts.map((text) => ({ type: "text", text })) } });

/** Write the stopped agent's transcript and hand its SubagentStop payload to `stop`. */
export async function deliverClaudeSubagentStop<T>(agent: ClaudeStoppedAgent, stop: (payload: ClaudeSubagentStop) => Promise<T>): Promise<T> {
  mkdirSync(agent.transcriptDirectory, { recursive: true });
  const transcript = join(agent.transcriptDirectory, `${agent.agentId}.jsonl`);
  writeFileSync(transcript, `${[...(agent.leadingRecords ?? []), finalMessageRecord(agent.finalTexts)].join("\n")}\n`);
  return stop({ session_id: agent.sessionId, agent_id: agent.agentId, agent_type: agent.agentType, agent_transcript_path: transcript });
}
