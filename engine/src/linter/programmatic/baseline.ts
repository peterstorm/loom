/**
 * Grandfathered-violation baselines, owned in one place.
 *
 * A baseline is debt with a shape: a list of `path::key` entries where each
 * entry excuses exactly one violation of one rule. Two rules need it — the
 * switch form and the if-chain form of "branching on a union without a totality
 * proof" — and a baseline that only ever SUPPRESSES is a list nobody notices
 * decaying: a deleted switch, a renamed scrutinee, or a refactor that made the
 * branch total all leave an entry behind that protects nothing, hides that the
 * file improved, and tells the next reader the debt is still real.
 *
 * So the counter carries both projections:
 *   - `consume` — spend an entry when a live site matches it
 *   - `unused`  — report entries nothing consumed, given every site a rule saw
 *
 * `scripts/lint-project.ts` runs the staleness pass and each rule's test
 * asserts its own baseline against the live repository, so drift fails a test
 * rather than waiting for someone to remember to run the script.
 */

export type Baseline = readonly string[];

/** The key form every rule uses: the site's repo-relative path, then the thing
 *  the rule branched on (`x.kind`, `event.status`), so a second branch on the
 *  same tag in the same file is its own entry. */
export const baselineKey = (filePath: string, key: string): string =>
  `${filePath.replace(/\\/g, "/")}::${key}`;

export interface BaselineCounter {
  /** Spend one entry for `key`; false when the baseline has none left. */
  readonly consume: (key: string) => boolean;
  /** Entries no detected site consumed. */
  readonly unused: (detected: readonly string[]) => readonly string[];
}

export function baselineCounter(baseline: Baseline = []): BaselineCounter {
  const remaining = new Map<string, number>();
  for (const key of baseline) remaining.set(key, (remaining.get(key) ?? 0) + 1);

  const spendFrom = (counts: Map<string, number>, key: string): boolean => {
    const left = counts.get(key) ?? 0;
    if (left === 0) return false;
    counts.set(key, left - 1);
    return true;
  };

  return {
    consume: (key) => spendFrom(remaining, key),
    unused: (detected) => {
      // Copy the CURRENT counts, so entries already consumed by the live lint
      // pass are not reported again when the same site shows up in `detected`.
      const counts = new Map(remaining);
      for (const key of detected) spendFrom(counts, key);
      return [...counts.entries()].flatMap(([key, count]) => Array.from({ length: count }, () => key));
    },
  };
}

/** Stateless convenience for callers that only ask the staleness question. */
export function unusedBaselineEntries(detected: readonly string[], baseline: Baseline = []): readonly string[] {
  return baselineCounter(baseline).unused(detected);
}
