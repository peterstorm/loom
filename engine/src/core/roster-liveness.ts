/**
 * Which `.active` roster entries belong to an agent that never started
 * (loom#198, Cause 5).
 *
 * SubagentStart writes an agent onto its session's roster and SubagentStop
 * takes it off. When the harness refuses a spawn after SubagentStart has run,
 * the agent never runs and never stops, so its entry stays: it blocks every
 * quiescent operation (`reopen-task`, `rescope-task`, adoptions) and makes
 * sole-agent attribution refuse for every later agent, until it is removed by
 * hand.
 *
 * A Claude Code subagent writes its transcript as soon as it starts. So an
 * entry is never-started when all of these hold, and only then:
 * - the id has Claude Code's opaque agent-id shape (Pi and other harnesses
 *   keep transcripts elsewhere, so their entries are never judged here);
 * - the roster file is older than {@link NEVER_STARTED_GRACE_MS} (an agent
 *   that has only just started may not have written its transcript yet; the
 *   roster's mtime is its newest entry's, so this only ever errs young);
 * - no transcript for it exists under any project of the configuration
 *   directory (session ids are unique, so this is location-independent).
 * An unknown observation is never "absent": what cannot be proven dead stays.
 *
 * Pure.
 */

/** How long after the roster last changed an entry without a transcript is still given to start. */
export const NEVER_STARTED_GRACE_MS = 120_000;

/** Claude Code's opaque subagent id: `a` and sixteen lowercase hex digits. */
export const isClaudeCodeAgentId = (agentId: string): boolean => /^a[0-9a-f]{16}$/u.test(agentId);

/** What the shell observed of one agent's transcript. */
export type TranscriptPresence = "present" | "absent" | "unknown";

/** Whether the roster entry `agentId` is an agent that never started. */
export function isNeverStarted(agentId: string, rosterAgeMs: number, transcript: TranscriptPresence): boolean {
  return rosterAgeMs >= NEVER_STARTED_GRACE_MS && isClaudeCodeAgentId(agentId) && transcript === "absent";
}
