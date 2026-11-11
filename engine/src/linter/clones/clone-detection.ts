/**
 * Clone detection — the pure core of the `no-duplicate-block` rule.
 *
 * A clone is a run of at least `minTokens` identical tokens, spanning at least
 * `minLines` lines, that appears in two places. Whitespace and comments are not
 * tokens, and import statements are dropped, so two files are never clones
 * merely for importing the same things or carrying the same header.
 *
 * Three steps, each a function of data in, data out:
 *   1. `fingerprint` — lex one source into a token stream and pick its
 *      fingerprints by winnowing (Schleimer, Wilkerson, Aiken 2003): hash every
 *      k-gram of tokens, then keep the minimum hash of every window. Any run of
 *      `minTokens` shared tokens contains one whole window, and a window picks
 *      the same k-gram wherever it appears, so two sources that share such a
 *      run always share a fingerprint.
 *   2. `candidatePaths` — the sources an index says share a fingerprint.
 *   3. `clonesBetween` — the exact answer for one pair: a shared fingerprint
 *      is a seed, extended token by token in both directions, then cut back to
 *      whole lines. The seeds are bounded (`MAX_SEEDS_PER_HASH`), so a source
 *      that repeats one line thousands of times costs no more to compare than
 *      one that repeats it a few dozen times.
 *
 * A fingerprint only nominates; step 3 compares tokens. A stale or colliding
 * index entry can therefore cost a comparison, never report a clone that is
 * not there.
 *
 * Zero dependencies beyond the linter's own source segmenter and its
 * positive-integer type.
 */

import { isPositiveInt, type PositiveInt } from "../positive-int";
import { sourceSegments } from "../source-segments";

// --- Options ---

/**
 * How long a shared run must be before it is a clone. Both thresholds are
 * positive integers by type: the config parse and `parseCloneOptions` are the
 * only ways to make one, so nothing below checks or clamps them.
 */
export type CloneOptions = Readonly<{ minTokens: PositiveInt; minLines: PositiveInt }>;

/** The outcome of `parseCloneOptions`: the linter's own result shape (`ConfigParse` is the other). */
export type CloneOptionsParse =
  | Readonly<{ ok: true; value: CloneOptions }>
  | Readonly<{ ok: false; error: string }>;

/** Thresholds as clone options, or which one is not a positive integer. */
export function parseCloneOptions(raw: Readonly<{ minTokens: unknown; minLines: unknown }>): CloneOptionsParse {
  const { minTokens, minLines } = raw;
  if (!isPositiveInt(minTokens)) return { ok: false, error: `minTokens must be a positive integer, got ${String(minTokens)}` };
  if (!isPositiveInt(minLines)) return { ok: false, error: `minLines must be a positive integer, got ${String(minLines)}` };
  return { ok: true, value: Object.freeze({ minTokens, minLines }) };
}

/** A literal through the one parser: a wrong literal fails this module's load, never a lint run. */
function literalCloneOptions(minTokens: number, minLines: number): CloneOptions {
  const parsed = parseCloneOptions({ minTokens, minLines });
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.value;
}

/**
 * 100 tokens over 8 lines is roughly a ten-line function body: long enough
 * that the copy is a decision somebody made, short enough to catch a fixture
 * builder or a re-implemented predicate.
 */
export const DEFAULT_CLONE_OPTIONS: CloneOptions = literalCloneOptions(100, 8);

/**
 * The k-gram length: half the threshold, so the window is as long again. A
 * threshold of one token still needs a one-token gram, the only case the floor
 * of one decides.
 */
const gramSize = (options: CloneOptions): number => Math.max(1, Math.floor(options.minTokens / 2));

/** The winnowing window, in k-grams: `gramSize + windowSize - 1 === minTokens`. */
const windowSize = (options: CloneOptions): number => options.minTokens - gramSize(options) + 1;

// --- Tokens ---

/**
 * One source as the detector reads it: a hash per token and the 1-indexed line
 * each token starts on. Typed arrays, because a project is millions of tokens
 * and an object per token costs more memory than the sources themselves. They
 * are written once, inside `tokenStream`, and only read afterwards.
 */
export type TokenStream = Readonly<{ hashes: Int32Array; lines: Uint32Array }>;

type RawToken = Readonly<{ text: string; line: number; kind: "code" | "string" }>;

/** A name, a number, or one punctuation character. */
const CODE_TOKEN = /[A-Za-z_$][\w$]*|\d[\w.]*|\S/g;

/** An import statement longer than this is not one: the skip gives up and the tokens stay. */
const IMPORT_SPAN_LIMIT = 400;

const FNV_OFFSET = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

/** One FNV-1a step: `value` folded into `hash`. */
const mixed = (hash: number, value: number): number => Math.imul(hash ^ value, FNV_PRIME);

/** A hash as eight hex digits. */
const hex = (hash: number): string => (hash >>> 0).toString(16).padStart(8, "0");

/** FNV-1a over UTF-16 code units, as a signed 32-bit integer. */
function hashText(text: string): number {
  let hash = FNV_OFFSET;
  for (let index = 0; index < text.length; index += 1) hash = mixed(hash, text.charCodeAt(index));
  return hash | 0;
}

/** How many newlines `content` holds in `[from, to)`. */
function newlinesBetween(content: string, from: number, to: number): number {
  let count = 0;
  for (let index = content.indexOf("\n", from); index !== -1 && index < to; index = content.indexOf("\n", index + 1)) {
    count += 1;
  }
  return count;
}

/** Every token of `content` in order: code split into names, numbers and punctuation, a quoted string whole. */
function rawTokens(content: string): readonly RawToken[] {
  // Segments and their tokens arrive in source order, so the line count only moves forward.
  let line = 1;
  let counted = 0;
  const lineAt = (offset: number): number => {
    line += newlinesBetween(content, counted, offset);
    counted = offset;
    return line;
  };
  return sourceSegments(content).flatMap((segment): readonly RawToken[] => {
    if (segment.kind === "comment") return [];
    if (segment.kind === "string") {
      return [{ text: content.slice(segment.start, segment.end), line: lineAt(segment.start), kind: "string" }];
    }
    return Array.from(content.slice(segment.start, segment.end).matchAll(CODE_TOKEN), (found) => ({
      text: found[0],
      line: lineAt(segment.start + found.index),
      kind: "code" as const,
    }));
  });
}

/**
 * The index just past the import statement opening at `start`, or `start` when
 * the token there does not open one. An import statement is `import` leading
 * its line, not a call (`import(`) or `import.meta`, running through its
 * module string and an optional `;`. One with no module string within
 * `IMPORT_SPAN_LIMIT` tokens is left in the stream: when in doubt the tokens
 * are compared, never skipped.
 */
function importEnd(tokens: readonly RawToken[], start: number): number {
  const token = tokens[start];
  const previous = tokens[start - 1];
  const next = tokens[start + 1];
  if (token === undefined || token.kind !== "code" || token.text !== "import") return start;
  if (previous !== undefined && previous.line === token.line) return start;
  if (next === undefined || next.text === "(" || next.text === ".") return start;
  const limit = Math.min(tokens.length, start + IMPORT_SPAN_LIMIT);
  for (let index = start + 1; index < limit; index += 1) {
    if (tokens[index]?.kind !== "string") continue;
    return tokens[index + 1]?.text === ";" ? index + 2 : index + 1;
  }
  return start;
}

/** `tokens` without its import statements. */
function withoutImports(tokens: readonly RawToken[]): readonly RawToken[] {
  const kept: RawToken[] = [];
  let index = 0;
  while (index < tokens.length) {
    const end = importEnd(tokens, index);
    if (end > index) {
      index = end;
      continue;
    }
    const token = tokens[index];
    if (token !== undefined) kept.push(token);
    index += 1;
  }
  return kept;
}

/** Lex one source into the token stream the detector compares. */
export function tokenStream(content: string): TokenStream {
  const tokens = withoutImports(rawTokens(content));
  return {
    hashes: Int32Array.from(tokens, (token) => hashText(token.text)),
    lines: Uint32Array.from(tokens, (token) => token.line),
  };
}

// --- Fingerprints ---

/**
 * One source ready to compare: its path, its tokens, the hash of every k-gram
 * (`grams[i]` covers tokens `i … i + gramSize - 1`) and the k-gram indices
 * winnowing selected, ascending.
 */
export type Fingerprinted = Readonly<{
  path: string;
  stream: TokenStream;
  grams: Int32Array;
  selected: Int32Array;
}>;

/** The polynomial hash of every k-gram of `hashes`, rolled in one pass. */
function gramHashes(hashes: Int32Array, size: number): Int32Array {
  const count = hashes.length - size + 1;
  if (count <= 0) return new Int32Array(0);
  const grams = new Int32Array(count);
  let leading = 1;
  for (let power = 1; power < size; power += 1) leading = Math.imul(leading, FNV_PRIME);
  let hash = 0;
  for (let index = 0; index < size; index += 1) hash = (Math.imul(hash, FNV_PRIME) + hashes[index]) | 0;
  grams[0] = hash;
  for (let index = 1; index < count; index += 1) {
    hash = (hash - Math.imul(hashes[index - 1], leading)) | 0;
    hash = (Math.imul(hash, FNV_PRIME) + hashes[index + size - 1]) | 0;
    grams[index] = hash;
  }
  return grams;
}

/**
 * The index of the rightmost minimum of every `window` consecutive grams, each
 * index once, ascending. A source with fewer grams than one window selects
 * nothing: it is shorter than `minTokens` and cannot hold a clone.
 */
function winnow(grams: Int32Array, window: number): Int32Array {
  const selected: number[] = [];
  const candidates: number[] = [];
  let head = 0;
  for (let index = 0; index < grams.length; index += 1) {
    while (candidates.length > head && grams[candidates[candidates.length - 1] ?? 0] >= grams[index]) candidates.pop();
    candidates.push(index);
    if ((candidates[head] ?? 0) <= index - window) head += 1;
    const minimum = candidates[head] ?? index;
    if (index >= window - 1 && selected[selected.length - 1] !== minimum) selected.push(minimum);
  }
  return Int32Array.from(selected);
}

/** Lex one source, then hash and winnow its k-grams at the given sizes. */
function fingerprinted(path: string, content: string, gram: number, window: number): Fingerprinted {
  const stream = tokenStream(content);
  const grams = gramHashes(stream.hashes, gram);
  return { path, stream, grams, selected: winnow(grams, window) };
}

/** Lex and fingerprint one source. */
export const fingerprint = (path: string, content: string, options: CloneOptions = DEFAULT_CLONE_OPTIONS): Fingerprinted =>
  fingerprinted(path, content, gramSize(options), windowSize(options));

/** The distinct fingerprint hashes of one source — what an index stores and is asked about. */
export const fingerprintHashes = (source: Fingerprinted): readonly number[] =>
  [...new Set(Array.from(source.selected, (index) => source.grams[index] ?? 0))];

// --- Scheme identity ---

/**
 * What a stored fingerprint hash means: the lexer, the token and k-gram hashes,
 * the winnowing, and the gram and window sizes it was computed with. Two hashes
 * are comparable only under the same scheme, so whoever stores hashes
 * (`index-cache.ts`) stores this beside them and trusts nothing stored under
 * another. Only `fingerprintScheme` makes one.
 */
export type FingerprintScheme = string & { readonly __brand: "FingerprintScheme" };

/**
 * A source that passes through every part of the lexer: import statements of
 * each shape, a dynamic import, both comment forms, each string quote, a
 * template with interpolations, a regex literal beside a division, names,
 * numbers and punctuation.
 */
const SCHEME_PROBE = [
  "import { one } from \"./one\";",
  "import type {",
  "  Two,",
  "} from \"./two\";",
  "import \"./side-effect\";",
  "const lazy = await import(\"./lazy\"); // a line comment",
  "/* a block comment */ const text = `u://${host}/${'a // b'}` + 'single';",
  "const ratio = total / count / 2.5e3;",
  "const found = /[/]\\/+/g.test(text) ? items[0x1f] : { key: \"value\" };",
].join("\n");

/** Small enough that the probe's handful of lines fills several windows. */
const PROBE_GRAM = 4;
const PROBE_WINDOW = 5;

/**
 * The scheme a source is fingerprinted under with these options. It is not a
 * number somebody remembers to bump: it is what the scheme DOES to the probe —
 * every token hash, k-gram hash and selected index, digested — with the gram
 * and window sizes the options give. Change the segmenter, `CODE_TOKEN`, the
 * import skip, a hash constant or the winnowing, and the identity changes with
 * it. The line threshold is not part of it: fingerprints do not depend on it.
 */
export function fingerprintScheme(options: CloneOptions): FingerprintScheme {
  const probe = fingerprinted("probe", SCHEME_PROBE, PROBE_GRAM, PROBE_WINDOW);
  const digest = [...probe.stream.hashes, ...probe.grams, ...probe.selected].reduce(mixed, FNV_OFFSET);
  // The one place a scheme is made; the brand says the string came from here.
  return `${hex(digest)}/k${gramSize(options)}/w${windowSize(options)}` as FingerprintScheme;
}

// --- Index ---

/** Which sources carry each fingerprint hash. Nominates pairs to compare; decides nothing. */
export type CloneIndex = ReadonlyMap<number, readonly string[]>;

/** One source as an index holds it: its path and its distinct fingerprint hashes. */
export type IndexEntry = Readonly<{ path: string; hashes: readonly number[] }>;

/** Every value filed under its key, in the order given. */
function grouped<K, V>(pairs: Iterable<readonly [K, V]>): ReadonlyMap<K, readonly V[]> {
  const groups = new Map<K, V[]>();
  for (const [key, value] of pairs) {
    const group = groups.get(key);
    if (group === undefined) groups.set(key, [value]);
    else group.push(value);
  }
  return groups;
}

/** The index of a set of sources. */
export const cloneIndex = (entries: readonly IndexEntry[]): CloneIndex =>
  grouped(entries.flatMap(({ path, hashes }) => hashes.map((hash) => [hash, path] as const)));

/** Every other source the index says shares a fingerprint with `target`, sorted. */
export function candidatePaths(target: Fingerprinted, index: CloneIndex): readonly string[] {
  const paths = fingerprintHashes(target).flatMap((hash) => index.get(hash) ?? []);
  return [...new Set(paths)].filter((path) => path !== target.path).sort();
}

// --- Corpus port ---

/**
 * The languages the detector lexes: TypeScript and JavaScript in every module
 * spelling. The segmenter reads their strings, templates, regexes and comments;
 * another language's would be misread, so it is not compared at all.
 */
export const CLONE_EXTENSIONS: readonly string[] = Object.freeze([
  ".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs",
]);

/**
 * What the rule needs from a project: the other sources that may hold a copy of
 * `target`, fingerprinted. The port; `project-corpus.ts` is the adapter that
 * reads a project, and a test passes a literal.
 *
 * `trust` says what nominated the candidates. A `"bytes"` corpus fingerprinted
 * every source from its current bytes, so it misses no copy. A
 * `"cache-assisted"` one may have taken fingerprints from the edit hook's
 * cache, which can hide a copy. The checks that decide — the full tier and the
 * baselines — ask for an `AuthoritativeCorpus` and so cannot be given the
 * second kind.
 */
export type CloneCorpus<Trust extends CorpusTrust = CorpusTrust> = Readonly<{
  trust: Trust;
  candidates: (target: Fingerprinted) => readonly Fingerprinted[];
}>;

export type CorpusTrust = "bytes" | "cache-assisted";

/** A corpus that never read the fingerprint cache. */
export type AuthoritativeCorpus = CloneCorpus<"bytes">;

/** No project: nothing can be a copy of anything else, so only a source's own repeats are found. */
export const EMPTY_CORPUS: AuthoritativeCorpus = Object.freeze({ trust: "bytes", candidates: () => [] });

// --- Clones ---

/** One side of a clone: where the run sits. Lines are 1-indexed and inclusive. */
export type CloneSite = Readonly<{ path: string; startLine: number; endLine: number }>;

/**
 * One shared run. `here` is in the source that was asked about, `there` in the
 * one it was compared with. `digest` identifies the run's tokens, so it
 * survives the run moving to other lines and changes when the run does.
 */
export type Clone = Readonly<{ tokens: number; digest: string; here: CloneSite; there: CloneSite }>;

/** A shared run: `length` tokens from `start` in the target, from `start + delta` in the other. */
export type Run = Readonly<{ start: number; delta: number; length: number }>;

/** A seed: one fingerprint two sources share, at `[targetIndex, otherIndex]`. */
type Seed = readonly [number, number];

/**
 * How many positions of ONE fingerprint hash, per source, seed a comparison.
 *
 * Without a cap the seeds are a cross product: a source that repeats one line
 * 3,000 times holds 3,000 positions of one hash, which pair into millions of
 * seeds against itself or a file like it. With it, the seeds of one comparison
 * number at most `MAX_SEEDS_PER_HASH` × the smaller source's fingerprints.
 *
 * The cap never invents a clone — a seed is still extended by comparing
 * tokens. What it can miss is stated exactly: a shared run goes unreported only
 * when EVERY fingerprint inside it sits, in one of the two sources, after that
 * source's first `MAX_SEEDS_PER_HASH` positions of the same fingerprint. That
 * is a run made of something its source has already repeated 32 times — rows of
 * a generated table, a long list of identical lines — and the first 32
 * repetitions are still compared, so the repetition is reported; only its
 * further restatements are not. Hand-written code is far below the cap: the
 * most any Loom file repeats one fingerprint is 14 times.
 */
export const MAX_SEEDS_PER_HASH = 32;

/** Where each selected gram hash of `source` sits, ascending. */
const selectedByHash = (source: Fingerprinted): ReadonlyMap<number, readonly number[]> =>
  grouped(Array.from(source.selected, (index) => [source.grams[index] ?? 0, index] as const));

/** The positions of each selected gram hash that may seed a comparison: its first `MAX_SEEDS_PER_HASH`. */
const seedPositions = (source: Fingerprinted): ReadonlyMap<number, readonly number[]> =>
  new Map(Array.from(selectedByHash(source), ([hash, positions]) => [hash, positions.slice(0, MAX_SEEDS_PER_HASH)] as const));

/**
 * The seeds of one comparison, in target order. The cap applies to both
 * sources alike, so asking from the other side pairs the same positions.
 * Within one source (`self`), only pairs with the copy after the original.
 */
function seedPairs(target: Fingerprinted, other: Fingerprinted, self: boolean): readonly Seed[] {
  const theirs = seedPositions(other);
  const mine = self ? theirs : seedPositions(target);
  return Array.from(mine)
    .flatMap(([hash, positions]) => {
      const partners = theirs.get(hash) ?? [];
      return positions.flatMap((a) => partners.filter((b) => !self || b > a).map((b): Seed => [a, b]));
    })
    .sort((left, right) => left[0] - right[0] || left[1] - right[1]);
}

/** The maximal run of equal tokens through the seed `(a, b)`. */
function extend(left: Int32Array, right: Int32Array, a: number, b: number): Run {
  let back = 0;
  while (a - back > 0 && b - back > 0 && left[a - back - 1] === right[b - back - 1]) back += 1;
  let forward = 0;
  while (a + forward < left.length && b + forward < right.length && left[a + forward] === right[b + forward]) forward += 1;
  return { start: a - back, delta: b - a, length: back + forward };
}

/**
 * Within one source a run may not overlap its own copy: a run at distance
 * `delta` is cut to `delta` tokens, so a repeating pattern reports the part
 * that is genuinely written twice.
 */
const withinSelf = (run: Run): Run => ({ ...run, length: Math.min(run.length, run.delta) });

/**
 * One comparison before any threshold: its maximal runs, each once, and the
 * number of seeds it paired to find them — the work `MAX_SEEDS_PER_HASH` bounds.
 */
export type SharedRuns = Readonly<{ seeds: number; runs: readonly Run[] }>;

/**
 * The maximal runs through `target`'s seeds with `other`. Pass the same value
 * twice for the runs a source shares with itself.
 *
 * Each maximal run is extended once. Seeds arrive in target order, and the
 * maximal runs at one distance (`delta`) never overlap, so a seed lies inside a
 * run already found exactly when the last run extended at its distance reaches
 * past it: one lookup per seed, no search through the runs found so far.
 */
export function sharedRuns(target: Fingerprinted, other: Fingerprinted): SharedRuns {
  const self = target === other;
  const seeds = seedPairs(target, other, self);
  const reach = new Map<number, number>();
  const runs: Run[] = [];
  for (const [a, b] of seeds) {
    if ((reach.get(b - a) ?? 0) > a) continue;
    const run = extend(target.stream.hashes, other.stream.hashes, a, b);
    reach.set(run.delta, run.start + run.length);
    runs.push(self ? withinSelf(run) : run);
  }
  return { seeds: seeds.length, runs };
}

const leadsLine = (lines: Uint32Array, index: number): boolean => index === 0 || lines[index - 1] !== lines[index];

const endsLine = (lines: Uint32Array, index: number): boolean =>
  index === lines.length - 1 || lines[index + 1] !== lines[index];

/**
 * `run` cut back to whole lines on both sides. A maximal run usually starts
 * with the `);` that happens to close the line before each copy; keeping it
 * would report a line that is not duplicated and tie the digest to the
 * neighbours' punctuation.
 */
function wholeLines(left: Uint32Array, right: Uint32Array, run: Run): Run {
  let start = run.start;
  let end = run.start + run.length;
  while (start < end && !(leadsLine(left, start) && leadsLine(right, start + run.delta))) start += 1;
  while (end > start && !(endsLine(left, end - 1) && endsLine(right, end - 1 + run.delta))) end -= 1;
  return { start, delta: run.delta, length: end - start };
}

const siteOf = (source: Fingerprinted, start: number, length: number): CloneSite => ({
  path: source.path,
  startLine: source.stream.lines[start] ?? 1,
  endLine: source.stream.lines[start + length - 1] ?? 1,
});

const lineSpan = (site: CloneSite): number => site.endLine - site.startLine + 1;

/** The run's tokens as eight hex digits. */
const runDigest = (hashes: Int32Array, run: Run): string =>
  hex(hashes.subarray(run.start, run.start + run.length).reduce(mixed, FNV_OFFSET));

/**
 * Every clone `target` shares with `other`, in `target` order. Pass the same
 * value twice to find the clones a source holds of itself.
 */
export function clonesBetween(
  target: Fingerprinted,
  other: Fingerprinted,
  options: CloneOptions = DEFAULT_CLONE_OPTIONS,
): readonly Clone[] {
  return sharedRuns(target, other).runs
    .map((run) => wholeLines(target.stream.lines, other.stream.lines, run))
    .filter((run) => run.length >= options.minTokens)
    .map((run) => ({
      tokens: run.length,
      digest: runDigest(target.stream.hashes, run),
      here: siteOf(target, run.start, run.length),
      there: siteOf(other, run.start + run.delta, run.length),
    }))
    .filter((clone) => lineSpan(clone.here) >= options.minLines && lineSpan(clone.there) >= options.minLines)
    .sort((left, right) => left.here.startLine - right.here.startLine || left.there.startLine - right.there.startLine);
}
