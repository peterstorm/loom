/**
 * Which `.active` roster entries belong to an agent that is not running
 * (loom#198, Cause 5).
 *
 * SubagentStart writes an agent onto its session's roster and SubagentStop
 * takes it off. Two ways leave an entry behind with no agent: the harness
 * refuses a spawn after SubagentStart has run, so the agent never runs; or
 * the agent dies on an API error (a usage limit, say), so it never stops.
 * Either entry blocks every quiescent operation (`reopen-task`,
 * `rescope-task`, adoptions) and makes sole-agent attribution refuse for
 * every later agent, until it is removed by hand.
 *
 * A Claude Code subagent writes its transcript as soon as it starts, and an
 * agent aborted by an API error ends it with that error's record. So an entry
 * is dead when the id has Claude Code's opaque agent-id shape (Pi and other
 * harnesses keep transcripts elsewhere, so their entries are never judged
 * here) and one of these holds:
 * - `never-started`: the roster file is older than {@link DEAD_ENTRY_GRACE_MS}
 *   (an agent that has only just started may not have written its transcript
 *   yet; the roster's mtime is its newest entry's, so this only ever errs
 *   young) and no transcript for it exists under any project of the
 *   configuration directory (session ids are unique, so this is
 *   location-independent);
 * - `aborted`: its transcript's last record is an API error and the
 *   transcript has not changed for {@link DEAD_ENTRY_GRACE_MS} (an agent the
 *   harness retries after an error writes again).
 * An unknown observation is never dead: what cannot be proven dead stays.
 *
 * Pure.
 */

/** How long an entry is given to start, or to resume after an API error, before it is judged dead. */
export const DEAD_ENTRY_GRACE_MS = 120_000;

/** Claude Code's opaque subagent id: `a` and sixteen lowercase hex digits. */
export const isClaudeCodeAgentId = (agentId: string): boolean => /^a[0-9a-f]{16}$/u.test(agentId);

/** What the shell observed of one agent's transcript. */
export type TranscriptObservation =
  | Readonly<{ kind: "absent" }>
  | Readonly<{ kind: "unknown" }>
  | Readonly<{ kind: "present"; lastRecord: "api-error" | "other"; idleMs: number }>;

/**
 * The kind of a transcript's last record, from whole lines at the end of the
 * transcript: `api-error` when the last non-empty line is a Claude Code API
 * error record (`isApiErrorMessage: true`), `other` for anything else, an
 * unparseable line or no line at all (what cannot be proven aborted is not).
 */
export function lastTranscriptRecord(wholeLines: string): "api-error" | "other" {
  const last = wholeLines.split("\n").map((line) => line.trim()).filter((line) => line !== "").at(-1);
  if (last === undefined) return "other";
  try {
    const record: unknown = JSON.parse(last);
    return typeof record === "object" && record !== null && (record as { isApiErrorMessage?: unknown }).isApiErrorMessage === true
      ? "api-error"
      : "other";
  } catch {
    return "other";
  }
}

/** Why a roster entry has no running agent behind it. */
export type DeadEntryReason = "never-started" | "aborted";

/** Why the roster entry `agentId` is dead, or null when it may be running. */
export function deadEntryReason(agentId: string, rosterAgeMs: number, transcript: TranscriptObservation): DeadEntryReason | null {
  if (!isClaudeCodeAgentId(agentId)) return null;
  switch (transcript.kind) {
    case "absent":
      return rosterAgeMs >= DEAD_ENTRY_GRACE_MS ? "never-started" : null;
    case "present":
      return transcript.lastRecord === "api-error" && transcript.idleMs >= DEAD_ENTRY_GRACE_MS ? "aborted" : null;
    case "unknown":
      return null;
    default: {
      const unreachable: never = transcript;
      return unreachable;
    }
  }
}
