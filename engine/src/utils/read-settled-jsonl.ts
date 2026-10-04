/**
 * Read a Claude JSONL transcript once its final record is fully written.
 *
 * Claude Code can fire SubagentStop while it is still appending the trailing
 * record (an `attachment` lands a few hundred milliseconds after a
 * SubagentHandback, for example). A single read then sees a torn last line,
 * and the strict integrity parser correctly refuses it — turning a finished
 * implementation into an infrastructure-blocked settlement.
 *
 * Every record the harness writes is newline-terminated, so a non-empty read
 * that ends in a newline holds only whole records. This reader re-reads, within
 * a bounded budget, only while that is not yet true. It never repairs or trims
 * bytes: when the budget is exhausted the last read is returned unchanged and
 * the strict parser stays the sole judge, so a genuinely corrupt transcript
 * still fails closed. Read failures propagate on the first attempt.
 */

export type ReadTranscript = () => string;
export type Sleep = (ms: number) => Promise<void>;

export type SettlePolicy = Readonly<{ attempts: number; delayMs: number }>;

/** About two seconds: far beyond the observed sub-second flush lag, well inside the hook timeout. */
export const DEFAULT_SETTLE_POLICY: SettlePolicy = Object.freeze({ attempts: 20, delayMs: 100 });

const realSleep: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** True when the bytes end on a record boundary, so no record can be torn. */
export function hasCompleteJsonlTail(raw: string): boolean {
  return raw.length > 0 && raw.endsWith("\n");
}

export async function readSettledJsonl(
  read: ReadTranscript,
  sleep: Sleep = realSleep,
  policy: SettlePolicy = DEFAULT_SETTLE_POLICY,
): Promise<string> {
  let raw = read();
  for (let attempt = 1; attempt < policy.attempts && !hasCompleteJsonlTail(raw); attempt += 1) {
    await sleep(policy.delayMs);
    raw = read();
  }
  return raw;
}
