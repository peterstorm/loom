/**
 * A stop-check note the orchestrating session must see (#121).
 *
 * The acceptance and affected stop checks fail open, and on Pi they only
 * report. Either way the note that names the cause (a timeout, a held lock,
 * an exhausted budget, or Pi's report-only failure) is the only trace of a
 * check that did not decide. A SubagentStop `systemMessage` reaches the
 * operator's terminal but never the orchestrating model. So each note travels
 * as this value: Claude Code keeps it in a per-agent sidecar until the
 * orchestrator's next Task/Agent result, and Pi appends it to the subagent
 * tool result. Both render it with `renderStopCheckNotes`.
 *
 * Pure: the value, its parse from a sidecar's bytes, and the rendering.
 */

export type StopCheckNote = Readonly<{ taskId: string; message: string }>;

/** A sidecar's JSON as a note, or null when it is not one. */
export function parseStopCheckNote(raw: unknown): StopCheckNote | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const { taskId, message } = raw as Readonly<Record<string, unknown>>;
  return typeof taskId === "string" && taskId !== "" && typeof message === "string" && message.trim() !== ""
    ? Object.freeze({ taskId, message })
    : null;
}

export const STOP_CHECK_NOTES_HEADING =
  "Loom stop checks did not decide, or reported only, for these Tasks. Each stop proceeded; the Wave Gate still judges the Task:";

/** One block for the orchestrating model: the heading, then each note under
 *  its Task, continuation lines indented; null when there is no note to show. */
export function renderStopCheckNotes(notes: readonly StopCheckNote[]): string | null {
  if (notes.length === 0) return null;
  const items = notes.map(({ taskId, message }) =>
    `- ${taskId}: ${message.trim().split("\n").join("\n  ")}`);
  return [STOP_CHECK_NOTES_HEADING, ...items].join("\n");
}
