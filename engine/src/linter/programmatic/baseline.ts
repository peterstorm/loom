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

/** A module scope's first two segments, as a path prefix (`engine/src/core/`). */
const anchorOf = (module: string): string => `${module.split("/").slice(0, 2).join("/")}/`;

/** Repository trees a baseline key may start with. `anchors` narrow to a module
 *  scope; these recover the repo-relative form for a tree the anchors do not
 *  name (`pi/`), which otherwise stayed ABSOLUTE — every baseline key written
 *  for that tree was therefore dead, and the rule reported the site it was
 *  supposed to grandfather. */
const REPO_ROOTS: readonly string[] = ["engine/", "pi/", "tests/", "scripts/"];

/**
 * Normalize a lint target to the repo-relative form baseline keys are written
 * in. `lintFile` hands rules ABSOLUTE paths, so without this a baselined site
 * stops matching wherever the checkout lives — and a grandfathered list that
 * quietly stops applying is worse than no list: the site looks baselined in
 * review and fails in CI.
 *
 * Anchors on the MODULE SCOPE (`engine/src/<area>/`) rather than reusing
 * `toRepositoryRelative`, which anchors on the import-boundary table:
 * `engine/src/machine/` is not an import boundary, so an absolute path there
 * stayed absolute. One owner, so the two rules that key baselines normalize
 * identically — the bug this replaces was two copies that disagreed.
 */
export const repoRelative = (filePath: string, anchors: readonly string[]): string => {
  const normalized = filePath.replace(/\\/g, "/");
  for (const anchor of [...anchors.map(anchorOf), ...REPO_ROOTS]) {
    const at = normalized.lastIndexOf(`/${anchor}`);
    if (at !== -1) return normalized.slice(at + 1);
    if (normalized.startsWith(anchor)) return normalized;
  }
  return normalized;
};

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
