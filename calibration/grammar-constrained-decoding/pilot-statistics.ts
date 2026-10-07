/**
 * The pilot's statistics — PURE and deterministic: the seeded PRNG the
 * schedule and every bootstrap draw from, nearest-rank quantiles over samples
 * that may be +∞ (terminal failures), the percentile bootstrap, and the
 * JSON-safe records of quantiles and intervals. No domain knowledge: the
 * guardrails decide what the numbers mean.
 */

/** Seeded PRNG (mulberry32): the schedule and the bootstrap are reproducible
 *  from the preregistered seeds. Its state is local to one returned closure. */
function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A seeded Fisher–Yates permutation; the input is never mutated. */
export function shuffled<T>(values: readonly T[], seed: number): readonly T[] {
  const random = seededRandom(seed);
  const copy = [...values];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(random() * (index + 1));
    [copy[index], copy[swap]] = [copy[swap] as T, copy[index] as T];
  }
  return Object.freeze(copy);
}

/** Nearest-rank quantile over values that may include +∞ (terminal failures). */
export function nearestRankQuantile(values: readonly number[], q: number): number {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((left, right) => left - right);
  const rank = Math.max(1, Math.ceil(q * sorted.length));
  return sorted[rank - 1] as number;
}

export type Interval = Readonly<{ lower: number; upper: number; level: number }>;

/** Percentile bootstrap interval of a statistic over paired items. NaN
 *  statistics (undefined resamples) rank as +∞, so they widen the upper bound
 *  conservatively instead of disappearing. */
export function bootstrapInterval<T>(
  items: readonly T[],
  statistic: (sample: readonly T[]) => number,
  resamples: number,
  seed: number,
  level: number,
): Interval {
  if (items.length === 0) return Object.freeze({ lower: Number.NaN, upper: Number.NaN, level });
  const random = seededRandom(seed);
  const estimates = Array.from({ length: resamples }, () => {
    const resample = Array.from({ length: items.length }, () => items[Math.floor(random() * items.length)] as T);
    const value = statistic(resample);
    return Number.isNaN(value) ? Number.POSITIVE_INFINITY : value;
  }).sort((left, right) => left - right);
  const tail = (1 - level) / 2;
  return Object.freeze({
    lower: nearestRankQuantile(estimates, tail),
    upper: nearestRankQuantile(estimates, 1 - tail),
    level,
  });
}

export const mean = (values: readonly number[]): number =>
  values.length === 0 ? Number.NaN : values.reduce((sum, value) => sum + value, 0) / values.length;

export const median = (values: readonly number[]): number => nearestRankQuantile(values, 0.5);

/** A latency quantile as JSON-safe data: +∞ is a terminal-failure-dominated quantile. */
export type LatencyQuantile =
  | Readonly<{ kind: "finite"; ms: number }>
  | Readonly<{ kind: "terminal-failure-dominated" }>
  | Readonly<{ kind: "no-samples" }>;

export function quantileRecord(value: number): LatencyQuantile {
  if (Number.isNaN(value)) return Object.freeze({ kind: "no-samples" as const });
  if (Number.isFinite(value)) return Object.freeze({ kind: "finite" as const, ms: value });
  return Object.freeze({ kind: "terminal-failure-dominated" as const });
}

/** JSON cannot carry ±∞/NaN; an interval bound that is not finite is recorded as null (unbounded/undefined). */
export type JsonInterval = Readonly<{ lower: number | null; upper: number | null; level: number }>;

export const finiteOrNull = (value: number): number | null => (Number.isFinite(value) ? value : null);

export const jsonInterval = (interval: Interval): JsonInterval => Object.freeze({
  lower: finiteOrNull(interval.lower),
  upper: finiteOrNull(interval.upper),
  level: interval.level,
});
