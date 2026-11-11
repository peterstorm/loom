/**
 * The fingerprint cache as data — the pure half of the edit-time clone corpus.
 *
 * Fingerprinting a whole project takes about a second; an edit hook cannot
 * spend that on every write. So the hook keeps each file's fingerprint hashes
 * beside the size and modification time they were computed from, and
 * re-fingerprints only the files whose size or time changed.
 *
 * The cache holds nothing the detector trusts. Hashes only NOMINATE files to
 * compare; the comparison reads the nominated files fresh. A stale, truncated
 * or foreign cache can therefore hide a clone from the edit hook — never invent
 * one — and the Wave Gate and `lint-project` do not read it at all.
 *
 * So the parse is deliberately forgiving where every other parser in the linter
 * is strict: a document that is not exactly this module's own output is an
 * empty cache, and the caller rebuilds.
 */

import type { CloneOptions, IndexEntry } from "./clone-detection";

/** One file's cached fingerprints, valid while its size and modification time are unchanged. */
export type CachedFile = Readonly<{ size: number; mtimeMs: number; hashes: readonly number[] }>;

/** Project-relative path → what the cache holds for it. */
export type IndexCache = ReadonlyMap<string, CachedFile>;

export const EMPTY_INDEX_CACHE: IndexCache = new Map();

/** Bumped whenever the lexer or the fingerprinting changes what a hash means. */
const CACHE_VERSION = 1;

type CacheDocument = Readonly<{ version: number; minTokens: number; files: Readonly<Record<string, unknown>> }>;

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isInteger = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value);

const isList = (value: unknown): value is readonly unknown[] => Array.isArray(value);

function cacheDocument(json: unknown): CacheDocument | null {
  if (!isRecord(json) || !isInteger(json.version) || !isInteger(json.minTokens) || !isRecord(json.files)) return null;
  return { version: json.version, minTokens: json.minTokens, files: json.files };
}

/** One `[size, mtimeMs, hashes]` entry, or null when it is not that shape. */
function cachedFile(raw: unknown): CachedFile | null {
  if (!isList(raw) || raw.length !== 3) return null;
  const [size, mtimeMs, hashes] = raw;
  if (!isInteger(size) || typeof mtimeMs !== "number" || !isList(hashes)) return null;
  const numbers = hashes.filter(isInteger);
  return numbers.length === hashes.length ? { size, mtimeMs, hashes: numbers } : null;
}

/**
 * The cache a document holds for these options. Empty when the text is not
 * JSON, is another version, was built for another token threshold (the hashes
 * would mean other k-grams), or holds any entry of another shape.
 */
export function parseIndexCache(text: string, options: CloneOptions): IndexCache {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    // Not JSON: a torn or foreign file. The cache is rebuilt from the sources.
    return EMPTY_INDEX_CACHE;
  }
  const document = cacheDocument(json);
  if (document === null || document.version !== CACHE_VERSION || document.minTokens !== options.minTokens) {
    return EMPTY_INDEX_CACHE;
  }
  const raw = Object.entries(document.files);
  const files = raw.flatMap(([path, entry]) => {
    const file = cachedFile(entry);
    return file === null ? [] : [[path, file] as const];
  });
  return files.length === raw.length ? new Map(files) : EMPTY_INDEX_CACHE;
}

/** The document `parseIndexCache` reads back as `cache` under the same options. */
export function renderIndexCache(cache: IndexCache, options: CloneOptions): string {
  const files = Object.fromEntries(
    [...cache].map(([path, file]) => [path, [file.size, file.mtimeMs, file.hashes]] as const),
  );
  return JSON.stringify({ version: CACHE_VERSION, minTokens: options.minTokens, files });
}

/** The cached hashes for a file of this size and modification time, or null when the cache has none that still apply. */
export function cachedHashes(
  cache: IndexCache,
  path: string,
  observed: Readonly<{ size: number; mtimeMs: number }>,
): readonly number[] | null {
  const file = cache.get(path);
  return file !== undefined && file.size === observed.size && file.mtimeMs === observed.mtimeMs ? file.hashes : null;
}

/** The index entries a cache stands for. */
export const indexEntries = (cache: IndexCache): readonly IndexEntry[] =>
  [...cache].map(([path, file]) => ({ path, hashes: file.hashes }));
