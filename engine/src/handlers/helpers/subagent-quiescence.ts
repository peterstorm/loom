/**
 * The quiescence protocol of the operator helpers that rewrite the protected
 * TaskGraph in one StateManager update: refuse while a subagent is active for
 * the TaskGraph, then check again under the lock, so a subagent that starts
 * between the first check and the commit still refuses the write.
 */

/** Whether a subagent is active for this TaskGraph: the injected probe the
 *  evidence ledger (`anyActiveSubagent`) answers in production and a test fake
 *  answers in the helpers' tests. */
export type SubagentActivity = (statePath: string) => boolean;

/** The pre-lock refusal for `operation` (e.g. "Contract Revision"), or null
 *  when no subagent is active. */
export function subagentActiveRefusal(
  subagentActive: SubagentActivity,
  statePath: string,
  operation: string,
): string | null {
  if (!subagentActive(statePath)) return null;
  const subject = operation.charAt(0).toUpperCase() + operation.slice(1);
  return `${subject} refused while a subagent is active for this TaskGraph; wait for it to settle and retry`;
}

/** The in-lock re-check: throws, aborting the locked update, when a subagent
 *  became active after the pre-lock check. */
export function assertQuiescentUnderLock(subagentActive: SubagentActivity, statePath: string, operation: string): void {
  if (subagentActive(statePath)) throw new Error(`A subagent became active before the ${operation} could commit`);
}
