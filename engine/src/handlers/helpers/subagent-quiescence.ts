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

/** The helpers that follow the protocol. */
export type QuiescentOperation = "Contract Revision" | "spec trace amendment" | "spec trace upgrade" | "task reopening";

/** What each operation tells the operator to wait for before retrying. */
const SETTLE: Readonly<Record<QuiescentOperation, string>> = Object.freeze({
  "Contract Revision": "wait for it to settle and retry",
  "spec trace amendment": "wait for it to settle and retry",
  "spec trace upgrade": "wait for the exact roster to settle and retry",
  "task reopening": "wait for it to settle and retry",
});

/** The pre-lock refusal for `operation`, or null when no subagent is active. */
export function subagentActiveRefusal(
  subagentActive: SubagentActivity,
  statePath: string,
  operation: QuiescentOperation,
): string | null {
  if (!subagentActive(statePath)) return null;
  const subject = operation.charAt(0).toUpperCase() + operation.slice(1);
  return `${subject} refused while a subagent is active for this TaskGraph; ${SETTLE[operation]}`;
}

/** The in-lock re-check: throws, aborting the locked update, when a subagent
 *  became active after the pre-lock check. */
export function assertQuiescentUnderLock(
  subagentActive: SubagentActivity,
  statePath: string,
  operation: QuiescentOperation,
): void {
  if (subagentActive(statePath)) throw new Error(`A subagent became active before the ${operation} could commit`);
}
