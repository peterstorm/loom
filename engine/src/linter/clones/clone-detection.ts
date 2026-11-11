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
 *   3. `clonesBetween` — the exact answer for one pair: every shared
 *      fingerprint is a seed, extended token by token in both directions, then
 *      cut back to whole lines.
 *
 * A fingerprint only nominates; step 3 compares tokens. A stale or colliding
 * index entry can therefore cost a comparison, never report a clone that is
 * not there.
 *
 * Zero dependencies beyond the linter's own source segmenter.
 */

import { sourceSegments } from "../programmatic/no-io-in-pure-modules";

// --- Options ---

/** How long a shared run must be before it is a clone. */
export type CloneOptions = Readonly<{ minTokens: number; minLines: number }>;

/**
 * 100 tokens over 8 lines is roughly a ten-line function body: long enough
 * that the copy is a decision somebody made, short enough to catch a fixture
 * builder or a re-implemented predicate.
 */
export const DEFAULT_CLONE_OPTIONS: CloneOptions = Object.freeze({ minTokens: 100, minLines: 8 });

/** The k-gram length: half the threshold, so the window is as long again. */
const gramSize = (options: CloneOptions): number => Math.max(1, Math.floor(options.minTokens / 2));

/** The winnowing window, in k-grams: `gramSize + windowSize - 1 === minTokens`. */
const windowSize = (options: CloneOptions): number => Math.max(1, options.minTokens - gramSize(options) + 1);

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

/** FNV-1a over UTF-16 code units, as a signed 32-bit integer. */
function hashText(text: string): number {
  let hash = FNV_OFFSET;
  for (let index = 0; index < text.length; index += 1) {
    hash = Math.imul(hash ^ text.charCodeAt(index), FNV_PRIME);
  }
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

/** Lex and fingerprint one source. */
export function fingerprint(path: string, content: string, options: CloneOptions = DEFAULT_CLONE_OPTIONS): Fingerprinted {
  const stream = tokenStream(content);
  const grams = gramHashes(stream.hashes, gramSize(options));
  return { path, stream, grams, selected: winnow(grams, windowSize(options)) };
}

/** The distinct fingerprint hashes of one source — what an index stores and is asked about. */
export const fingerprintHashes = (source: Fingerprinted): readonly number[] =>
  [...new Set(Array.from(source.selected, (index) => source.grams[index] ?? 0))];

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
 */
export type CloneCorpus = Readonly<{ candidates: (target: Fingerprinted) => readonly Fingerprinted[] }>;

/** No project: nothing can be a copy of anything else, so only a source's own repeats are found. */
export const EMPTY_CORPUS: CloneCorpus = Object.freeze({ candidates: () => [] });

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
type Run = Readonly<{ start: number; delta: number; length: number }>;

/** Where each selected gram hash of `source` sits. */
const selectedByHash = (source: Fingerprinted): ReadonlyMap<number, readonly number[]> =>
  grouped(Array.from(source.selected, (index) => [source.grams[index] ?? 0, index] as const));

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

const covers = (run: Run, a: number, b: number): boolean =>
  b - a === run.delta && a >= run.start && a < run.start + run.length;

/** Every seed two fingerprinted sources share; within one source, only pairs with the copy after the original. */
function seeds(target: Fingerprinted, other: Fingerprinted): readonly (readonly [number, number])[] {
  const self = target === other;
  const byHash = selectedByHash(other);
  return Array.from(target.selected).flatMap((a) =>
    (byHash.get(target.grams[a] ?? 0) ?? [])
      .filter((b) => !self || b > a)
      .map((b) => [a, b] as const),
  );
}

/** The maximal runs through `target`'s seeds with `other`, each once. */
function sharedRuns(target: Fingerprinted, other: Fingerprinted): readonly Run[] {
  const self = target === other;
  const runs: Run[] = [];
  for (const [a, b] of seeds(target, other)) {
    if (runs.some((run) => covers(run, a, b))) continue;
    const run = extend(target.stream.hashes, other.stream.hashes, a, b);
    runs.push(self ? withinSelf(run) : run);
  }
  return runs;
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
function runDigest(hashes: Int32Array, run: Run): string {
  let hash = FNV_OFFSET;
  for (let index = run.start; index < run.start + run.length; index += 1) {
    hash = Math.imul(hash ^ hashes[index], FNV_PRIME);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/**
 * Every clone `target` shares with `other`, in `target` order. Pass the same
 * value twice to find the clones a source holds of itself.
 */
export function clonesBetween(
  target: Fingerprinted,
  other: Fingerprinted,
  options: CloneOptions = DEFAULT_CLONE_OPTIONS,
): readonly Clone[] {
  return sharedRuns(target, other)
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
