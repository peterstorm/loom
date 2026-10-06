/**
 * Standalone review read coverage (ADR-0022): the obligation that every
 * issued reviewer was actually shown every unit of the frozen diff of its
 * scope before its result is admitted.
 *
 * Three facts, all fixed or verified by the engine, never self-reported:
 *
 * - **The obligation** is the `standalone-frozen-diff` Context Packet section:
 *   one unified diff text per scoped file, base revision → frozen head bytes,
 *   frozen at Run start. Its digest is inside every request's context digest.
 * - **The observation** is built at capture from the harness transcript's own
 *   tool outputs. A tool output counts only if it is a page the engine reader
 *   printed (`--diff PATH`) AND its text is byte-for-byte the frozen diff text
 *   at the page's range. A reviewer's claim, an echoed command or a truncated
 *   page proves nothing.
 * - **The decision** is pure: the union of verified ranges must cover
 *   `[0, totalUnits)` of every text diff, or admission refuses with the exact
 *   unread ranges.
 *
 * Offsets are UTF-16 code units, the same unit the Context Packet reader
 * pages in. Pure module: no I/O, no clock, no randomness.
 */
import { sha256Hex } from "./digest";
import { canonicalRecord, type DomainResult } from "./orchestration-contract/identity";
import { isRecord } from "./plain-record";
import { unifiedDiff } from "./unified-diff";

export const STANDALONE_FROZEN_DIFF_SECTION = "standalone-frozen-diff";
/** Largest page the reader prints: the JSON-escaped page stays well under
 *  Claude Code's 30,000-character Bash output limit, so pages are never truncated. */
export const FROZEN_DIFF_PAGE_UNITS = 12_000;
/** The most diff text one reviewer can be obliged to read; larger scopes must be partitioned. */
export const READ_COVERAGE_SCOPE_BUDGET_UNITS = 240_000;

export const STANDALONE_READ_COVERAGE_V1 = canonicalRecord({
  protocol: "loom-standalone-read-coverage" as const,
  version: 1 as const,
  obligation: "every-frozen-diff-unit" as const,
  section: STANDALONE_FROZEN_DIFF_SECTION,
  pageUnits: FROZEN_DIFF_PAGE_UNITS,
  scopeBudgetUnits: READ_COVERAGE_SCOPE_BUDGET_UNITS,
});
export type StandaloneReadCoveragePolicy = typeof STANDALONE_READ_COVERAGE_V1;

/** Exact supported policy bytes; any other value refuses rather than selecting a variant. */
export function parseStandaloneReadCoverage(raw: unknown): DomainResult<StandaloneReadCoveragePolicy, string> {
  const keys = Object.keys(STANDALONE_READ_COVERAGE_V1);
  return isRecord(raw) && Object.keys(raw).length === keys.length &&
      keys.every((key) => (raw as Record<string, unknown>)[key] === (STANDALONE_READ_COVERAGE_V1 as Record<string, unknown>)[key])
    ? { ok: true, value: STANDALONE_READ_COVERAGE_V1 }
    : { ok: false, error: "read coverage policy must be exactly loom-standalone-read-coverage v1" };
}

// ---------------------------------------------------------------------------
// The frozen diff (the obligation)
// ---------------------------------------------------------------------------

/** One side of a scoped file as frozen: absent, UTF-8 text, or binary. */
export type FrozenDiffSide =
  | Readonly<{ kind: "absent" }>
  | Readonly<{ kind: "text"; text: string }>
  | Readonly<{ kind: "binary" }>;

export type FrozenDiffFile =
  | Readonly<{ path: string; kind: "text-diff"; digest: string; totalUnits: number; text: string }>
  | Readonly<{ path: string; kind: "no-diff"; reason: "unchanged" | "binary" }>;

export type FrozenDiff = Readonly<{
  schemaVersion: 1;
  baseRevision: string;
  headRevision: string;
  files: readonly FrozenDiffFile[];
}>;

function diffFile(path: string, base: FrozenDiffSide, head: FrozenDiffSide): FrozenDiffFile {
  if (base.kind === "binary" || head.kind === "binary") return Object.freeze({ path, kind: "no-diff", reason: "binary" });
  const text = unifiedDiff(path, base.kind === "text" ? base.text : null, head.kind === "text" ? head.text : null);
  return text === ""
    ? Object.freeze({ path, kind: "no-diff", reason: "unchanged" })
    : Object.freeze({ path, kind: "text-diff", digest: sha256Hex(text), totalUnits: text.length, text });
}

/** Freeze the diff of every scoped file, in scope order. */
export function freezeDiff(input: Readonly<{
  baseRevision: string;
  headRevision: string;
  files: readonly Readonly<{ path: string; base: FrozenDiffSide; head: FrozenDiffSide }>[];
}>): FrozenDiff {
  return Object.freeze({
    schemaVersion: 1 as const,
    baseRevision: input.baseRevision,
    headRevision: input.headRevision,
    files: Object.freeze(input.files.map(({ path, base, head }) => diffFile(path, base, head))),
  });
}

/** The total diff text a reviewer of this scope must be shown. */
export function obligatedUnits(diff: FrozenDiff): number {
  return diff.files.reduce((sum, file) => sum + (file.kind === "text-diff" ? file.totalUnits : 0), 0);
}

/** Start-time refusal for a scope whose diff no single reviewer could read. */
export function readCoverageBudgetProblem(diff: FrozenDiff): string | null {
  const units = obligatedUnits(diff);
  return units <= READ_COVERAGE_SCOPE_BUDGET_UNITS ? null :
    `the frozen diff of this scope is ${units} UTF-16 units, over the ${READ_COVERAGE_SCOPE_BUDGET_UNITS}-unit ` +
    "read-coverage budget every reviewer must read in full; partition the scope into smaller explicit --files runs";
}

const nonNegativeInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

/** Parse stored frozen-diff bytes, re-deriving each text's digest and length. */
export function parseFrozenDiff(raw: unknown): DomainResult<FrozenDiff, string> {
  const bad = (error: string): DomainResult<never, string> => ({ ok: false, error: `frozen diff ${error}` });
  if (!isRecord(raw) || raw["schemaVersion"] !== 1 || typeof raw["baseRevision"] !== "string" ||
      typeof raw["headRevision"] !== "string" || !Array.isArray(raw["files"])) return bad("record is malformed");
  const files: FrozenDiffFile[] = [];
  const seen = new Set<string>();
  for (const file of raw["files"] as unknown[]) {
    if (!isRecord(file) || typeof file["path"] !== "string" || seen.has(file["path"])) return bad("file entry is malformed or duplicated");
    seen.add(file["path"]);
    if (file["kind"] === "no-diff" && (file["reason"] === "unchanged" || file["reason"] === "binary")) {
      files.push(Object.freeze({ path: file["path"], kind: "no-diff", reason: file["reason"] }));
      continue;
    }
    const text = file["text"];
    if (file["kind"] !== "text-diff" || typeof text !== "string" || text === "" ||
        file["digest"] !== sha256Hex(text) || file["totalUnits"] !== text.length) {
      return bad(`entry for ${file["path"]} does not match its own text`);
    }
    files.push(Object.freeze({ path: file["path"], kind: "text-diff", digest: sha256Hex(text), totalUnits: text.length, text }));
  }
  return { ok: true, value: Object.freeze({ schemaVersion: 1, baseRevision: raw["baseRevision"], headRevision: raw["headRevision"], files: Object.freeze(files) }) };
}

// ---------------------------------------------------------------------------
// Reader pages
// ---------------------------------------------------------------------------

export type FrozenDiffPage = Readonly<{
  kind: "loom-frozen-diff-page";
  path: string;
  digest: string;
  offset: number;
  /** Where the next page starts, or null when this page reaches the end. */
  nextOffset: number | null;
  totalUnits: number;
  text: string;
}>;

/** One reader page of a scoped file's frozen diff. */
export function frozenDiffPage(diff: FrozenDiff, path: string, offset: number, limit: number): DomainResult<FrozenDiffPage, string> {
  const file = diff.files.find((entry) => entry.path === path);
  if (file === undefined) return { ok: false, error: "path is not in this packet's frozen diff" };
  if (file.kind !== "text-diff") return { ok: false, error: `path has no text diff to read (${file.reason})` };
  if (!Number.isSafeInteger(offset) || offset < 0 || offset >= file.totalUnits) return { ok: false, error: "offset is outside the diff text" };
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > FROZEN_DIFF_PAGE_UNITS) return { ok: false, error: `limit must be 1..${FROZEN_DIFF_PAGE_UNITS}` };
  const end = Math.min(file.totalUnits, offset + limit);
  return { ok: true, value: Object.freeze({
    kind: "loom-frozen-diff-page", path, digest: file.digest, offset,
    nextOffset: end < file.totalUnits ? end : null, totalUnits: file.totalUnits, text: file.text.slice(offset, end),
  }) };
}

// ---------------------------------------------------------------------------
// The observation (built at capture from the harness transcript)
// ---------------------------------------------------------------------------

/** A half-open `[start, end)` range of UTF-16 units. */
export type UnitRange = readonly [number, number];

export type ReadCoverageObservation = Readonly<{
  schemaVersion: 1;
  kind: "standalone-read-coverage-observation";
  requestId: string;
  contextDigest: string;
  /** `unobservable` when the harness supplied no tool outputs: nothing could be verified. */
  transcript: "observed" | "unobservable";
  covered: readonly Readonly<{ path: string; ranges: readonly UnitRange[] }>[];
}>;

/** Sorted, disjoint, non-adjacent union of ranges. */
export function mergeRanges(ranges: readonly UnitRange[]): readonly UnitRange[] {
  const sorted = [...ranges].filter(([start, end]) => end > start).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const merged: [number, number][] = [];
  for (const [start, end] of sorted) {
    const last = merged.at(-1);
    if (last !== undefined && start <= last[1]) last[1] = Math.max(last[1], end);
    else merged.push([start, end]);
  }
  return Object.freeze(merged.map((range) => Object.freeze(range) as UnitRange));
}

/** The verified range one tool-output line proves was delivered, or null. */
function verifiedPageRange(diff: FrozenDiff, line: string): Readonly<{ path: string; range: UnitRange }> | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) return null;
  let page: unknown;
  try { page = JSON.parse(trimmed); } catch { return null; }
  if (!isRecord(page) || page["kind"] !== "loom-frozen-diff-page" || typeof page["path"] !== "string" ||
      typeof page["text"] !== "string" || !nonNegativeInteger(page["offset"])) return null;
  const file = diff.files.find((entry) => entry.path === page["path"]);
  if (file === undefined || file.kind !== "text-diff" || page["digest"] !== file.digest || page["totalUnits"] !== file.totalUnits) return null;
  const offset = page["offset"];
  const end = offset + page["text"].length;
  const expectedNext = end < file.totalUnits ? end : null;
  if (page["text"].length === 0 || end > file.totalUnits || page["nextOffset"] !== expectedNext ||
      file.text.slice(offset, end) !== page["text"]) return null;
  return { path: file.path, range: [offset, end] };
}

/**
 * Build the observation from the harness's own tool outputs (each a text the
 * transcript records as delivered to the reviewer). Every line is a candidate
 * page, so several reader calls chained in one shell command still count.
 */
export function observeReadCoverage(
  diff: FrozenDiff,
  request: Readonly<{ requestId: string; contextDigest: string }>,
  toolOutputs: readonly string[] | null,
): ReadCoverageObservation {
  const byPath = new Map<string, UnitRange[]>();
  for (const output of toolOutputs ?? []) {
    for (const line of output.split("\n")) {
      const verified = verifiedPageRange(diff, line);
      if (verified === null) continue;
      byPath.set(verified.path, [...(byPath.get(verified.path) ?? []), verified.range]);
    }
  }
  return Object.freeze({
    schemaVersion: 1 as const,
    kind: "standalone-read-coverage-observation" as const,
    requestId: request.requestId,
    contextDigest: request.contextDigest,
    transcript: toolOutputs === null ? "unobservable" as const : "observed" as const,
    covered: Object.freeze(diff.files.flatMap((file) => {
      const ranges = byPath.get(file.path);
      return ranges === undefined ? [] : [Object.freeze({ path: file.path, ranges: mergeRanges(ranges) })];
    })),
  });
}

export function parseReadCoverageObservation(raw: unknown): DomainResult<ReadCoverageObservation, string> {
  const bad: DomainResult<never, string> = { ok: false, error: "read coverage observation is malformed" };
  if (!isRecord(raw) || raw["schemaVersion"] !== 1 || raw["kind"] !== "standalone-read-coverage-observation" ||
      typeof raw["requestId"] !== "string" || typeof raw["contextDigest"] !== "string" ||
      (raw["transcript"] !== "observed" && raw["transcript"] !== "unobservable") || !Array.isArray(raw["covered"])) return bad;
  const covered: { path: string; ranges: UnitRange[] }[] = [];
  for (const entry of raw["covered"] as unknown[]) {
    if (!isRecord(entry) || typeof entry["path"] !== "string" || !Array.isArray(entry["ranges"])) return bad;
    const ranges: UnitRange[] = [];
    for (const range of entry["ranges"] as unknown[]) {
      if (!Array.isArray(range) || range.length !== 2 || !nonNegativeInteger(range[0]) || !nonNegativeInteger(range[1]) || range[1] <= range[0]) return bad;
      ranges.push([range[0], range[1]]);
    }
    covered.push({ path: entry["path"], ranges });
  }
  return { ok: true, value: Object.freeze({
    schemaVersion: 1, kind: "standalone-read-coverage-observation", requestId: raw["requestId"],
    contextDigest: raw["contextDigest"], transcript: raw["transcript"],
    covered: Object.freeze(covered.map(({ path, ranges }) => Object.freeze({ path, ranges: mergeRanges(ranges) }))),
  }) };
}

// ---------------------------------------------------------------------------
// The decision
// ---------------------------------------------------------------------------

export type ReadCoverageGap = Readonly<{ path: string; totalUnits: number; unread: readonly UnitRange[] }>;

/** Every text diff's ranges the observation does not cover, in scope order. */
export function readCoverageGaps(diff: FrozenDiff, observation: ReadCoverageObservation): readonly ReadCoverageGap[] {
  const covered = new Map(observation.covered.map(({ path, ranges }) => [path, mergeRanges(ranges)] as const));
  return Object.freeze(diff.files.flatMap((file) => {
    if (file.kind !== "text-diff") return [];
    const unread: UnitRange[] = [];
    let cursor = 0;
    for (const [start, end] of covered.get(file.path) ?? []) {
      if (start > cursor) unread.push([cursor, Math.min(start, file.totalUnits)]);
      cursor = Math.max(cursor, end);
      if (cursor >= file.totalUnits) break;
    }
    if (cursor < file.totalUnits) unread.push([cursor, file.totalUnits]);
    return unread.length === 0 ? [] : [Object.freeze({ path: file.path, totalUnits: file.totalUnits, unread: Object.freeze(unread) })];
  }));
}

const GAP_REPORT_FILES = 20;

/** Bounded diagnostic naming each unread file and range, for the retry prompt. */
export function describeReadCoverageGaps(gaps: readonly ReadCoverageGap[]): string {
  const shown = gaps.slice(0, GAP_REPORT_FILES).map(({ path, totalUnits, unread }) => {
    const missing = unread.reduce((sum, [start, end]) => sum + end - start, 0);
    const ranges = unread.slice(0, 8).map(([start, end]) => `${start}-${end}`).join(", ") + (unread.length > 8 ? ", ..." : "");
    return `${path} (${missing} of ${totalUnits} units unread: ${ranges})`;
  });
  const more = gaps.length > GAP_REPORT_FILES ? `; and ${gaps.length - GAP_REPORT_FILES} more files` : "";
  return `${shown.join("; ")}${more}`;
}

/**
 * Admit one captured reviewer result against its read obligation. An absent
 * observation (no engine capture of this attempt's transcript) and an
 * unobservable transcript both refuse: coverage that was not observed is
 * not coverage.
 */
export function admitReadCoverage(
  diff: FrozenDiff,
  request: Readonly<{ requestId: string; contextDigest: string }>,
  observation: ReadCoverageObservation | null,
): DomainResult<null, string> {
  // A scope without any text diff obliges nothing, so nothing must be observed.
  if (obligatedUnits(diff) === 0) return { ok: true, value: null };
  if (observation === null) {
    return { ok: false, error: "read coverage was not observed: the engine captured no transcript tool outputs for this attempt, so it cannot prove the frozen diff was read" };
  }
  if (observation.requestId !== request.requestId || observation.contextDigest !== request.contextDigest) {
    return { ok: false, error: "read coverage observation belongs to a different request or context" };
  }
  if (observation.transcript === "unobservable") {
    return { ok: false, error: "read coverage was not observed: the harness delivered no tool outputs for this attempt" };
  }
  const gaps = readCoverageGaps(diff, observation);
  return gaps.length === 0 ? { ok: true, value: null } : {
    ok: false,
    error: `read coverage incomplete: the engine observed no frozen diff page for ${describeReadCoverageGaps(gaps)}. ` +
      "Coverage is observed per attempt and a retry starts with nothing read, so these ranges only explain this refusal: " +
      "read every page of EVERY file in the read obligation list with the reader's --diff mode, not only these ranges, before emitting the result.",
  };
}
