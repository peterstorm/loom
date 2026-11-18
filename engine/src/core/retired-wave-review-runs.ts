/**
 * The retired Wave Gate runs a fresh start may succeed (ADR-0090): the one
 * invariant over `retired_wave_review_runs` (a run is retired once) and the one
 * append that keeps it. The State File parser and every retirement writer ask
 * here, so what is written and what loads cannot disagree.
 *
 * Pure: no I/O.
 */
import type { RetiredWaveReviewRun } from "../types";

/** The first run `runs` retires twice, or null when each run is retired once. */
export function repeatedRetiredRun(runs: readonly RetiredWaveReviewRun[]): RetiredWaveReviewRun | null {
  return runs.find((run, index) => runs.findIndex(({ runId }) => runId === run.runId) !== index) ?? null;
}

const sameRecord = (left: RetiredWaveReviewRun, right: RetiredWaveReviewRun): boolean =>
  left.runId === right.runId && left.wave === right.wave &&
  left.authorityDigest === right.authorityDigest && left.retirement === right.retirement;

/**
 * `runs` with `record` appended. Retiring a run already retired by the same
 * record changes nothing; retiring it differently is an invariant violation,
 * refused before a graph the State File would reject can be produced.
 */
export function appendRetiredWaveReviewRun(
  runs: readonly RetiredWaveReviewRun[] | undefined,
  record: RetiredWaveReviewRun,
): readonly RetiredWaveReviewRun[] {
  const existing = (runs ?? []).find(({ runId }) => runId === record.runId);
  if (existing === undefined) return Object.freeze([...(runs ?? []), record]);
  if (sameRecord(existing, record)) return runs ?? [];
  throw new Error(`Wave Gate run ${record.runId} is already retired as ${existing.retirement} of Wave ${existing.wave}`);
}
