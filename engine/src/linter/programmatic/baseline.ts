/**
 * Grandfathered-violation baselines, owned in one place.
 *
 * A baseline is debt with a shape: a list of `path::key` entries where each
 * entry excuses exactly one violation of one rule. Four rules need it — the
 * switch form and the if-chain form of "branching on a union without a totality
 * proof", the copied block, and the wire value typed without being parsed —
 * and a baseline that only ever SUPPRESSES is a list nobody notices
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
 *
 * A baseline is PROJECT data, not linter data: every project keeps its own in
 * its linter `config.json` (`switchTotalityBaseline`,
 * `discriminantBranchingBaseline`, `duplicateBlockBaseline`,
 * `wireCastBaseline`), written by `lint-project --write-baseline`.
 * Loom's own debt lives in Loom's `config.json` like any other project's — the
 * linter ships no list keyed to one repository's tree.
 */

/**
 * One baseline entry: the site's project-relative path, `::`, then what the
 * rule branched on. The shape is a type, so a key built by `baselineKey` or
 * accepted by `parseBaselineKey` always has a path to read back — an entry
 * without `::` is refused when the config is parsed, never sliced into a
 * wrong path later.
 */
export type BaselineKey = `${string}::${string}`;

export type Baseline = readonly BaselineKey[];

const KEY_SEPARATOR = "::";

/** A config entry as a baseline key, or null when it is not `path::key` with both sides non-empty. */
export function parseBaselineKey(entry: string): BaselineKey | null {
  const separator = entry.indexOf(KEY_SEPARATOR);
  if (separator <= 0 || separator + KEY_SEPARATOR.length >= entry.length) return null;
  return entry as BaselineKey;
}

/** The project-relative path a baseline key excuses a site in. */
export const baselineKeyPath = (key: BaselineKey): string => key.slice(0, key.indexOf(KEY_SEPARATOR));

/** A path rooted at `/` or at a Windows drive (`C:/`), forward-slashed. */
export const isAbsolutePath = (path: string): boolean => path.startsWith("/") || /^[A-Za-z]:\//.test(path);

/**
 * Normalize a lint target to the project-relative form baseline keys and module
 * scopes are written in. `lintFile` hands rules ABSOLUTE paths, so without this
 * a baselined site stops matching wherever the checkout lives — and a
 * grandfathered list that quietly stops applying is worse than no list: the
 * site looks baselined in review and fails in CI.
 *
 * The frame is the root of the project that owns the config (`projectRoot`),
 * never a list of one repository's directory names. That list was how the
 * rules came to work only inside Loom: a target project's paths matched no
 * anchor and stayed absolute, so no baseline could ever describe them. A path
 * already relative is taken as project-relative; a path outside the root, or a
 * run with no project root, stays as given — and a key that cannot match fails
 * toward reporting the site, never toward excusing it.
 */
export const projectRelative = (filePath: string, projectRoot: string | null): string => {
  const normalized = filePath.replace(/\\/g, "/");
  if (projectRoot === null || !isAbsolutePath(normalized)) return normalized;
  const root = projectRoot.replace(/\\/g, "/").replace(/\/+$/, "");
  return normalized.startsWith(`${root}/`) ? normalized.slice(root.length + 1) : normalized;
};

/** The key form every rule uses: the site's repo-relative path, then the thing
 *  the rule branched on (`x.kind`, `event.status`), so a second branch on the
 *  same tag in the same file is its own entry. */
export const baselineKey = (filePath: string, key: string): BaselineKey =>
  `${filePath.replace(/\\/g, "/")}${KEY_SEPARATOR}${key}`;

export interface BaselineCounter {
  /** Spend one entry for `key`; false when the baseline has none left. */
  readonly consume: (key: BaselineKey) => boolean;
  /** Entries no detected site consumed. */
  readonly unused: (detected: readonly BaselineKey[]) => readonly BaselineKey[];
}

export function baselineCounter(baseline: Baseline = []): BaselineCounter {
  const remaining = new Map<BaselineKey, number>();
  for (const key of baseline) remaining.set(key, (remaining.get(key) ?? 0) + 1);

  const spendFrom = (counts: Map<BaselineKey, number>, key: BaselineKey): boolean => {
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

/**
 * The two lists a baseline is compared against: the sites a rule detects, and
 * the entries that excuse them. Both are key lists of one type, so they are
 * passed by name — a positional swap would compile and flip the difference.
 */
export type BaselineComparison = Readonly<{ detected: readonly BaselineKey[]; baseline: Baseline }>;

/** The baseline entries no detected site consumes — the stale debt. */
export function unusedBaselineEntries({ detected, baseline }: BaselineComparison): readonly BaselineKey[] {
  return baselineCounter(baseline).unused(detected);
}

/** The detected sites no baseline entry excuses — what the rule reports. */
export function unbaselinedSites({ detected, baseline }: BaselineComparison): readonly BaselineKey[] {
  const entries = baselineCounter(baseline);
  return detected.filter((key) => !entries.consume(key));
}

/** The `config.json` field each baselined rule keeps its list in. */
export type BaselineConfigKey =
  | "switchTotalityBaseline"
  | "discriminantBranchingBaseline"
  | "duplicateBlockBaseline"
  | "wireCastBaseline";

/**
 * A rule that keeps a grandfathered list, as the staleness pass sees it: the
 * list, the config field it lives in, what one entry excuses, and the rule's
 * own detector — the sites the rule would flag absent the list. `index.ts`
 * registers every owner, so a new baselined rule joins the drift report and
 * `--write-baseline` by being registered, not by someone remembering to extend
 * a script.
 */
export type BaselineOwner = Readonly<{
  rule: string;
  configKey: BaselineConfigKey;
  /** The file extensions the rule reads — the files `--write-baseline` scans. */
  extensions: readonly string[];
  baseline: Baseline;
  /** What one entry excuses, in the rule's own words (`unproven switch`). */
  site: string;
  detect: (content: string, filePath: string) => readonly BaselineKey[];
}>;

/**
 * The entries of one owner's baseline that no live site consumes. The walk is
 * over the BASELINE'S OWN paths, not over whatever a lint invocation scanned: a
 * targeted run must not call every other entry stale. An entry whose file is
 * gone (`readSource` answers null) contributes no sites and is reported, which
 * is the drift this pass exists to catch.
 */
export function staleBaselineEntries(
  owner: BaselineOwner,
  readSource: (repoRelativePath: string) => string | null,
): readonly BaselineKey[] {
  const paths = [...new Set(owner.baseline.map(baselineKeyPath))];
  const detected = paths.flatMap((path) => {
    const content = readSource(path);
    return content === null ? [] : owner.detect(content, path);
  });
  return unusedBaselineEntries({ detected, baseline: owner.baseline });
}
