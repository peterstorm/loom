/**
 * The family-site metric (AD-11): how many raw second sites each known
 * invariant family still has outside its owner modules.
 *
 * `FAMILIES` is the ONE place a family's owners and raw-site patterns are
 * defined (FR-029). The scan, the baseline parser, the delta and both renderers
 * are pure: the `helper family-sites` shell reads the files and prints, nothing
 * else. Output is a function of the bytes alone — files are ordered by path
 * before scanning and sites by path then line — so the same repository bytes
 * always give the same output (FR-030, AS-032).
 *
 * The patterns are line regexes, so the counts are a gauge, not a proof. They
 * were calibrated against the known second copies at the feature's base
 * commit: every `existsSync(` probe and hand-rolled ENOENT decision, the
 * `guard-state-file.ts` / `extract-evidence.ts` / `report-discovery.ts`
 * tokenizers, and the `critical_findings` / `advisory_findings` view writes and
 * `splice`-based multiset removals outside `findings.ts`. Each pattern was
 * narrowed until mentions that decide nothing stopped matching (an ENOENT in an
 * errno list, a view's type annotation, a one-sided quote check, a split on a
 * single space).
 *
 * Pure module: no I/O, no clock, no randomness.
 */

import { isTestFileBySuffixes, DEFAULT_TEST_FILE_SUFFIXES } from "./test-file-classification";
import { failure, success, type DomainResult, type NonEmpty } from "./orchestration-contract/identity";
import { isRecord } from "./plain-record";

export type FamilyId = "fail-closed-path-probes" | "shell-tokenizing" | "claim-conservation";

export type Family = Readonly<{
  id: FamilyId;
  /** Repository-relative owner modules: the family's one home, never scanned for it. */
  owners: NonEmpty<string>;
  /** A line holding a match for any of these is one raw site. Never global: a `g` regex is stateful. */
  patterns: NonEmpty<RegExp>;
}>;

export const FAMILIES: readonly Family[] = Object.freeze([
  Object.freeze({
    id: "fail-closed-path-probes",
    owners: Object.freeze(["engine/src/utils/path-presence.ts"] as const),
    patterns: Object.freeze([
      // A fail-OPEN presence probe: false for EACCES, ELOOP, EIO as well as ENOENT.
      /\bexistsSync\(/,
      // A hand-rolled "ENOENT proves absence" decision, either operand order.
      /[!=]==\s*["']ENOENT["']|["']ENOENT["']\s*[!=]==/,
    ] as const),
  }),
  Object.freeze({
    id: "shell-tokenizing",
    owners: Object.freeze([
      "engine/src/core/shell-quoting.ts",
      "engine/src/core/shell-command.ts",
      "engine/src/core/shell-normalize.ts",
      "engine/src/core/shell-substitution.ts",
      "engine/src/core/shell-write-targets.ts",
      "engine/src/core/shell-ansi-c.ts",
    ] as const),
    patterns: Object.freeze([
      // Whitespace-splitting text into words, which ignores quoting.
      /\.split\(\s*\/\\s\+\//,
      // A hand-rolled quote-state opener: one line testing a character against two quote characters.
      /===\s*(?:"'"|'"'|"\\""|"`")[^\n]*\|\|[^\n]*===\s*(?:"'"|'"'|"\\""|"`")/,
      // Boolean quote-state flags of a hand-rolled tokenizer.
      /\blet\s+in(?:Single|Double)Quote\b/,
    ] as const),
  }),
  Object.freeze({
    id: "claim-conservation",
    owners: Object.freeze(["engine/src/core/findings.ts"] as const),
    patterns: Object.freeze([
      // A hand-derived write of a findings view as an object key: not a type
      // annotation, and not a property read before a ternary's colon.
      /(?<![.\w])(?:critical|advisory)_findings\s*:\s*(?!readonly\b|string\b|never\b)\S/,
      // Removing one occurrence by index: a hand-rolled multiset removal.
      /\.splice\(\s*\w+\s*,\s*1\s*\)/,
    ] as const),
  }),
]);

/** One already-read file, by its repository-relative path. */
export type SourceFile = Readonly<{ path: string; text: string }>;

export type FamilySites = Readonly<{
  family: FamilyId;
  owners: readonly string[];
  /** The `source` of each pattern the sites were found with. */
  patterns: readonly string[];
  /** `path:line`, sorted by path and then by line. The family's count is `sites.length`, never stored beside it. */
  sites: readonly string[];
}>;

export type FamilySiteReport = Readonly<{ schema: 1; families: readonly FamilySites[] }>;

/**
 * One family as a recorded baseline holds it. A baseline may name a family `FAMILIES` no longer defines.
 * The persisted `count` is checked against `sites.length` at parse time and then dropped, as in the live report.
 */
export type RecordedFamilySites = Readonly<{
  family: string;
  owners: readonly string[];
  patterns: readonly string[];
  sites: readonly string[];
}>;

export type FamilySiteBaseline = Readonly<{ families: readonly RecordedFamilySites[] }>;

export type FamilySiteDelta =
  | Readonly<{ kind: "compared"; family: FamilyId; baseline: number; current: number; delta: number; patternsChanged: boolean }>
  | Readonly<{ kind: "unrecorded"; family: FamilyId; current: number }>
  | Readonly<{ kind: "retired"; family: string; baseline: number }>;

/** The repository-relative tree the metric scans. The fs shell walks from here, so the scope has one definition. */
export const SCANNED_ROOT = "engine/src/";
const COMMENT_LINE = /^\s*(?:\/\/|\/\*|\*)/;

const normalizePath = (path: string): string => path.replace(/\\/g, "/");

/** Code-unit order: locale-independent, so the output never depends on the host. */
function compareText(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/** An `engine/src` TypeScript source that is not a test file, given a `/`-separated repository-relative path. */
export const isScannedSource = (path: string): boolean =>
  path.startsWith(SCANNED_ROOT) && path.endsWith(".ts") && !isTestFileBySuffixes(path, DEFAULT_TEST_FILE_SUFFIXES);

function rawSiteLines(family: Family, text: string): readonly number[] {
  return text.split("\n").flatMap((line, index) =>
    !COMMENT_LINE.test(line) && family.patterns.some((pattern) => pattern.test(line)) ? [index + 1] : []);
}

/** Count each family's raw sites in `files`, outside the family's owners. */
export function scanFamilySites(files: readonly SourceFile[]): FamilySiteReport {
  const sources = files
    .map(({ path, text }) => ({ path: normalizePath(path), text }))
    .filter(({ path }) => isScannedSource(path))
    .sort((a, b) => compareText(a.path, b.path) || compareText(a.text, b.text));
  const families = FAMILIES.map((family): FamilySites => {
    const owners = new Set(family.owners);
    const sites = sources
      .filter(({ path }) => !owners.has(path))
      .flatMap(({ path, text }) => rawSiteLines(family, text).map((line) => `${path}:${line}`));
    return Object.freeze({
      family: family.id,
      owners: family.owners,
      patterns: Object.freeze(family.patterns.map(({ source }) => source)),
      sites: Object.freeze(sites),
    });
  });
  return Object.freeze({ schema: 1, families: Object.freeze(families) });
}

const isStringArray = (value: unknown): value is readonly string[] =>
  Array.isArray(value) && value.every((entry) => typeof entry === "string");

function parseRecordedFamily(value: unknown, at: string): DomainResult<RecordedFamilySites, string> {
  if (!isRecord(value)) return failure(`${at} must be an object`);
  const { family, owners, patterns, count, sites } = value;
  if (typeof family !== "string" || family === "") return failure(`${at}.family must be a non-empty string`);
  if (!isStringArray(owners)) return failure(`${at}.owners must be an array of strings`);
  if (!isStringArray(patterns)) return failure(`${at}.patterns must be an array of strings`);
  if (!isStringArray(sites)) return failure(`${at}.sites must be an array of strings`);
  if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0) {
    return failure(`${at}.count must be a non-negative integer`);
  }
  if (count !== sites.length) return failure(`${at}.count (${count}) must equal sites.length (${sites.length})`);
  return success(Object.freeze({
    family,
    owners: Object.freeze([...owners]),
    patterns: Object.freeze([...patterns]),
    sites: Object.freeze([...sites]),
  }));
}

/** Parse a recorded baseline: the `--json` output of an earlier run. */
export function parseFamilySiteBaseline(value: unknown): DomainResult<FamilySiteBaseline, string> {
  if (!isRecord(value)) return failure("baseline must be a JSON object");
  if (value.schema !== 1) return failure(`baseline schema must be 1, got ${JSON.stringify(value.schema)}`);
  if (!Array.isArray(value.families)) return failure("baseline families must be an array");
  const families: RecordedFamilySites[] = [];
  for (const [index, raw] of value.families.entries()) {
    const parsed = parseRecordedFamily(raw, `baseline families[${index}]`);
    if (!parsed.ok) return parsed;
    if (families.some(({ family }) => family === parsed.value.family)) {
      return failure(`baseline names family ${parsed.value.family} more than once`);
    }
    families.push(parsed.value);
  }
  return success(Object.freeze({ families: Object.freeze(families) }));
}

const samePatterns = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((pattern, index) => pattern === b[index]);

/** Per-family change from `baseline` to `report`: current families in table order, then retired ones by name. */
export function familySiteDelta(report: FamilySiteReport, baseline: FamilySiteBaseline): readonly FamilySiteDelta[] {
  const recorded = new Map(baseline.families.map((family) => [family.family, family]));
  const current = report.families.map((family): FamilySiteDelta => {
    const before = recorded.get(family.family);
    return before === undefined
      ? Object.freeze({ kind: "unrecorded", family: family.family, current: family.sites.length })
      : Object.freeze({
        kind: "compared",
        family: family.family,
        baseline: before.sites.length,
        current: family.sites.length,
        delta: family.sites.length - before.sites.length,
        patternsChanged: !samePatterns(before.patterns, family.patterns),
      });
  });
  const live = new Set<string>(report.families.map(({ family }) => family));
  const retired = baseline.families
    .filter(({ family }) => !live.has(family))
    .sort((a, b) => compareText(a.family, b.family))
    .map((before): FamilySiteDelta => Object.freeze({ kind: "retired", family: before.family, baseline: before.sites.length }));
  return Object.freeze([...current, ...retired]);
}

/**
 * The `--json` output: the report, plus the delta when a baseline was given. One trailing newline.
 * Each family carries its derived `count` between `patterns` and `sites`, the key order the recorded
 * baseline `docs/family-sites.baseline.json` holds; `parseFamilySiteBaseline` checks it against the sites.
 */
export function serializeFamilySites(report: FamilySiteReport, delta: readonly FamilySiteDelta[] | null): string {
  const families = report.families.map(({ family, owners, patterns, sites }) =>
    ({ family, owners, patterns, count: sites.length, sites }));
  const document = { schema: report.schema, families, ...(delta === null ? {} : { delta }) };
  return `${JSON.stringify(document, null, 2)}\n`;
}

function signed(value: number): string {
  if (value > 0) return `+${value}`;
  if (value < 0) return `${value}`;
  return "±0";
}

function deltaLine(entry: FamilySiteDelta): string {
  switch (entry.kind) {
    case "compared":
      return `${entry.family}: ${entry.current} (baseline ${entry.baseline}, ${signed(entry.delta)}` +
        `${entry.patternsChanged ? "; patterns changed since the baseline" : ""})`;
    case "unrecorded":
      return `${entry.family}: ${entry.current} (not in the baseline)`;
    case "retired":
      return `${entry.family}: retired (baseline ${entry.baseline})`;
  }
}

/** The human output: each family's header and sites, then the delta when a baseline was given. */
export function renderFamilySites(report: FamilySiteReport, delta: readonly FamilySiteDelta[] | null): string {
  const lines = report.families.flatMap(({ family, owners, sites }) => [
    `${family}: ${sites.length} raw site${sites.length === 1 ? "" : "s"} outside ${owners.join(", ")}`,
    ...sites.map((site) => `  ${site}`),
  ]);
  const comparison = delta === null ? [] : ["", "Delta against the baseline:", ...delta.map((entry) => `  ${deltaLine(entry)}`)];
  return `${[...lines, ...comparison].join("\n")}\n`;
}
