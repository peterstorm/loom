/**
 * The clone corpus of one project — the adapter behind `CloneCorpus`, the
 * shell half of `no-duplicate-block`.
 *
 * The rule asks one question of it: which other sources might hold a copy of
 * this one? The corpus answers by walking the project (the lint walk, minus the
 * project's exclusions), fingerprinting what it finds, and reading every
 * nominated source fresh from disk. It is built on first use and lives for one
 * rule load, so a batch run walks once and a run that never meets a script file
 * never walks at all.
 *
 * Two trust levels, chosen by the caller:
 *   - with a cache file (the edit hook): unchanged files keep the fingerprints
 *     the last edit computed, so an edit costs one walk, plus lexing the edited
 *     file, the nominated candidates and any file whose size or time changed;
 *   - without one (the Wave Gate, `lint-project`): every file is fingerprinted
 *     from its bytes. The cache can only hide a clone, so the checks that
 *     decide never read it.
 */

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, extname, join, relative, sep } from "node:path";
import { scopeOf, type Exclusions } from "../project-scope";
import { walkLintableFiles, type WalkedFile } from "../project-walk";
import {
  candidatePaths,
  CLONE_EXTENSIONS,
  cloneIndex,
  fingerprint,
  fingerprintHashes,
  fingerprintScheme,
  type CloneCorpus,
  type CloneIndex,
  type CloneOptions,
  type Fingerprinted,
  type FingerprintScheme,
} from "./clone-detection";
import {
  cachedHashes,
  EMPTY_INDEX_CACHE,
  indexEntries,
  parseIndexCache,
  renderIndexCache,
  type CachedFile,
  type IndexCache,
} from "./index-cache";

export type ProjectCorpusOptions = Readonly<{
  projectRoot: string;
  /** The project's `exclude` list: an excluded file is never a clone's other side. */
  exclusions: Exclusions;
  clone: CloneOptions;
  /** The fingerprint cache file, or null to fingerprint every file from its bytes. */
  cacheFile: string | null;
}>;

/** Where the edit hook keeps one project's fingerprint cache: outside the project, keyed by its root. */
export function defaultCacheFile(projectRoot: string): string {
  const key = createHash("sha256").update(projectRoot).digest("hex").slice(0, 16);
  return join(tmpdir(), "loom-clone-index", `${key}.json`);
}

const isAbsent = (error: unknown): boolean => (error as NodeJS.ErrnoException).code === "ENOENT";

/** A file's text, or null when it is gone. Any other read failure propagates: the lint run fails closed. */
function readSource(absolute: string): string | null {
  try {
    return readFileSync(absolute, "utf-8");
  } catch (error) {
    if (isAbsent(error)) return null;
    throw error;
  }
}

function readCache(cacheFile: string | null, scheme: FingerprintScheme): IndexCache {
  if (cacheFile === null) return EMPTY_INDEX_CACHE;
  try {
    return parseIndexCache(readFileSync(cacheFile, "utf-8"), scheme);
  } catch {
    // Absent or unreadable cache file: every file is fingerprinted from its bytes.
    return EMPTY_INDEX_CACHE;
  }
}

function writeCache(cacheFile: string, cache: IndexCache, scheme: FingerprintScheme): void {
  const partial = `${cacheFile}.${process.pid}.tmp`;
  try {
    mkdirSync(dirname(cacheFile), { recursive: true });
    writeFileSync(partial, renderIndexCache(cache, scheme));
    renameSync(partial, cacheFile);
  } catch {
    // An unwritable cache directory costs the next edit a full fingerprinting
    // pass and nothing else; it must not fail the lint of a correct file.
  }
}

/** Do two caches hold the same files at the same size and time? Hashes follow from those. */
function sameCache(left: IndexCache, right: IndexCache): boolean {
  if (left.size !== right.size) return false;
  return [...right].every(([path, file]) => {
    const other = left.get(path);
    return other !== undefined && other.size === file.size && other.mtimeMs === file.mtimeMs;
  });
}

type CorpusFile = Readonly<{ file: WalkedFile; path: string }>;

/** The files a copy may be a copy of: the lint walk's script files, minus the project's exclusions. */
function corpusFiles(projectRoot: string, exclusions: Exclusions): readonly CorpusFile[] {
  return walkLintableFiles(projectRoot)
    .filter((file) => CLONE_EXTENSIONS.includes(extname(file.absolute)))
    .map((file) => ({ file, path: relative(projectRoot, file.absolute).split(sep).join("/") }))
    .filter(({ path }) => scopeOf(path, exclusions).kind === "lint");
}

/**
 * The corpus of one project. `candidates` fingerprints lazily and remembers
 * what it read, so a batch run lexes each source once.
 */
export function projectCorpus({ projectRoot, exclusions, clone, cacheFile }: ProjectCorpusOptions): CloneCorpus {
  const loaded = new Map<string, Fingerprinted | null>();
  let index: CloneIndex | undefined;

  const load = (path: string): Fingerprinted | null => {
    const known = loaded.get(path);
    if (known !== undefined) return known;
    const content = readSource(join(projectRoot, path));
    const source = content === null ? null : fingerprint(path, content, clone);
    loaded.set(path, source);
    return source;
  };

  /** A file's hashes from its bytes, or null when it is gone. Reached only when the cache has none that apply. */
  const hashesFromBytes = (path: string): readonly number[] | null => {
    const source = load(path);
    return source === null ? null : fingerprintHashes(source);
  };

  const cachedFileOf = (cache: IndexCache, path: string, file: WalkedFile): CachedFile | null => {
    const hashes = cachedHashes(cache, path, file) ?? hashesFromBytes(path);
    return hashes === null ? null : { size: file.size, mtimeMs: file.mtimeMs, hashes };
  };

  const build = (): CloneIndex => {
    const scheme = fingerprintScheme(clone);
    const previous = readCache(cacheFile, scheme);
    const current: IndexCache = new Map(
      corpusFiles(projectRoot, exclusions).flatMap(({ file, path }) => {
        const entry = cachedFileOf(previous, path, file);
        return entry === null ? [] : [[path, entry] as const];
      }),
    );
    if (cacheFile !== null && !sameCache(previous, current)) writeCache(cacheFile, current, scheme);
    return cloneIndex(indexEntries(current));
  };

  return {
    candidates: (target) => {
      index ??= build();
      return candidatePaths(target, index).flatMap((path) => {
        const source = load(path);
        return source === null ? [] : [source];
      });
    },
  };
}
