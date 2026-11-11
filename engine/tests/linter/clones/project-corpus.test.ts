/**
 * The project corpus against a real directory: which files it nominates, what
 * the fingerprint cache may and may not change, and which failures it swallows.
 */
import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fingerprint, fingerprintScheme, type CloneCorpus } from "../../../src/linter/clones/clone-detection";
import { parseIndexCache, renderIndexCache } from "../../../src/linter/clones/index-cache";
import { authoritativeCorpus, cacheAssistedCorpus, defaultCacheFile } from "../../../src/linter/clones/project-corpus";
import { block, cloneOptions, cloneProjects } from "../../fixtures/clone-fixtures";

const CLONE = cloneOptions(20, 4);
const SCHEME = fingerprintScheme(CLONE);

const SHARED = block("shared", 8);
const TARGET = fingerprint("src/target.ts", [block("target", 2), SHARED].join("\n"), CLONE);
/** A target that shares a fingerprint with nothing: asking about it builds the index and reads no source. */
const UNRELATED = fingerprint("src/elsewhere.ts", block("elsewhere", 12), CLONE);

const projects = cloneProjects("project-corpus-");
afterEach(projects.dispose);

/** The project's corpus: cache-assisted when given a cache file, authoritative (bytes only) when given null. */
function corpusOf(root: string, cacheFile: string | null, exclusions: readonly { path: string; reason: string }[] = []): CloneCorpus {
  const source = { projectRoot: root, exclusions, clone: CLONE };
  return cacheFile === null ? authoritativeCorpus(source) : cacheAssistedCorpus(source, cacheFile);
}

const candidatesIn = (root: string, cacheFile: string | null, exclusions: readonly { path: string; reason: string }[] = []) =>
  corpusOf(root, cacheFile, exclusions).candidates(TARGET).map((source) => source.path);

describe("the project corpus", () => {
  it("nominates the script files sharing a block, by project-relative path", () => {
    const root = projects.create({
      "src/copy.ts": [SHARED, block("copy", 2)].join("\n"),
      "tests/deep/copy.test.tsx": [block("deep", 3), SHARED].join("\n"),
      "src/unrelated.ts": block("unrelated", 12),
      "src/Copy.java": SHARED,
      "node_modules/pkg/copy.ts": SHARED,
    });
    expect(candidatesIn(root, null)).toEqual(["src/copy.ts", "tests/deep/copy.test.tsx"]);
  });

  it("never nominates the target itself or an excluded path", () => {
    const root = projects.create({
      "src/target.ts": [block("target", 2), SHARED].join("\n"),
      "vendor-copy/copy.ts": SHARED,
      "src/copy.ts": SHARED,
    });
    expect(candidatesIn(root, null, [{ path: "vendor-copy/", reason: "vendored" }])).toEqual(["src/copy.ts"]);
  });

  it("reads a nominated source's current bytes", () => {
    const root = projects.create({ "src/copy.ts": [SHARED, block("copy", 2)].join("\n") });
    const [copy] = corpusOf(root, null).candidates(TARGET);
    expect(Array.from(copy?.stream.hashes ?? [])).toEqual(
      Array.from(fingerprint("src/copy.ts", readFileSync(join(root, "src/copy.ts"), "utf-8"), CLONE).stream.hashes),
    );
  });

  it("writes no cache when given none", () => {
    const root = projects.create({ "src/copy.ts": SHARED });
    candidatesIn(root, null);
    expect(existsSync(defaultCacheFile(root))).toBe(false);
  });
});

describe("the project corpus with a fingerprint cache", () => {
  const cached = (root: string) => parseIndexCache(readFileSync(defaultCacheFile(root), "utf-8"), SCHEME);

  it("records every compared file's size, time and fingerprints on first use", () => {
    const root = projects.create({ "src/copy.ts": SHARED, "src/unrelated.ts": block("unrelated", 12) });
    expect(candidatesIn(root, defaultCacheFile(root))).toEqual(["src/copy.ts"]);
    expect([...cached(root).keys()]).toEqual(["src/copy.ts", "src/unrelated.ts"]);
    expect(cached(root).get("src/copy.ts")?.hashes.length).toBeGreaterThan(0);
  });

  it("re-fingerprints a file whose bytes changed since the cache was written", () => {
    const root = projects.create({ "src/later.ts": block("later", 12) });
    const cacheFile = defaultCacheFile(root);
    expect(candidatesIn(root, cacheFile)).toEqual([]);

    writeFileSync(join(root, "src/later.ts"), [block("later", 12), SHARED].join("\n"));

    expect(candidatesIn(root, cacheFile)).toEqual(["src/later.ts"]);
  });

  it("drops a deleted file and picks up a new one", () => {
    const root = projects.create({ "src/old.ts": SHARED });
    const cacheFile = defaultCacheFile(root);
    expect(candidatesIn(root, cacheFile)).toEqual(["src/old.ts"]);

    rmSync(join(root, "src/old.ts"));
    writeFileSync(join(root, "src/new.ts"), SHARED);

    expect(candidatesIn(root, cacheFile)).toEqual(["src/new.ts"]);
    expect([...cached(root).keys()]).toEqual(["src/new.ts"]);
  });

  it("trusts an entry whose size and time still match — the cache can hide a copy, which is why the gate reads none", () => {
    const root = projects.create({ "src/copy.ts": SHARED });
    const cacheFile = defaultCacheFile(root);
    expect(candidatesIn(root, cacheFile)).toEqual(["src/copy.ts"]);

    const emptied = new Map([...cached(root)].map(([path, file]) => [path, { ...file, hashes: [] }] as const));
    writeFileSync(cacheFile, renderIndexCache(emptied, SCHEME));

    expect(candidatesIn(root, cacheFile)).toEqual([]);
    expect(candidatesIn(root, null)).toEqual(["src/copy.ts"]);
  });

  it("trusts nothing cached under another fingerprint scheme, and replaces it", () => {
    const root = projects.create({ "src/copy.ts": SHARED });
    const cacheFile = defaultCacheFile(root);
    candidatesIn(root, cacheFile);

    // The same entries with their hashes emptied would hide the copy — if they were believed.
    const emptied = new Map([...cached(root)].map(([path, file]) => [path, { ...file, hashes: [] }] as const));
    writeFileSync(cacheFile, renderIndexCache(emptied, fingerprintScheme(cloneOptions(21, 4))));

    expect(candidatesIn(root, cacheFile)).toEqual(["src/copy.ts"]);
    expect(cached(root).get("src/copy.ts")?.hashes.length).toBeGreaterThan(0);
  });

  it("can never make a copy appear: a nominated file is compared by its current bytes", () => {
    const root = projects.create({ "src/copy.ts": SHARED });
    const cacheFile = defaultCacheFile(root);
    // A whole-second stamp, so setting it again reproduces it exactly.
    const stamp = new Date("2026-01-01T00:00:00Z");
    utimesSync(join(root, "src/copy.ts"), stamp, stamp);
    candidatesIn(root, cacheFile);

    // Same size, same time, different bytes: the stale entry still nominates it…
    const rewritten = SHARED.replaceAll("shared", "sharee");
    writeFileSync(join(root, "src/copy.ts"), rewritten);
    utimesSync(join(root, "src/copy.ts"), stamp, stamp);

    const [nominated] = corpusOf(root, cacheFile).candidates(TARGET);
    // …and what it hands the rule is the file as it is now.
    expect(Array.from(nominated?.stream.hashes ?? [])).toEqual(
      Array.from(fingerprint("src/copy.ts", rewritten, CLONE).stream.hashes),
    );
  });

  it("rebuilds from the sources when the cache file is not its own output", () => {
    const root = projects.create({ "src/copy.ts": SHARED });
    const cacheFile = defaultCacheFile(root);
    mkdirSync(dirname(cacheFile), { recursive: true });
    writeFileSync(cacheFile, "{ not json");
    expect(candidatesIn(root, cacheFile)).toEqual(["src/copy.ts"]);
    expect([...cached(root).keys()]).toEqual(["src/copy.ts"]);
  });

  it("answers the same when the cache cannot be written: the failure is the next edit's cost, never this one's", () => {
    const root = projects.create({ "src/copy.ts": SHARED });
    // Beneath a regular file: neither the cache's directory nor the cache can ever be created.
    const unwritable = join(root, "src/copy.ts", "cache.json");

    expect(candidatesIn(root, unwritable)).toEqual(["src/copy.ts"]);
    expect(candidatesIn(root, unwritable)).toEqual(["src/copy.ts"]);
    expect(statSync(join(root, "src/copy.ts")).isFile()).toBe(true);
  });
});

describe("the project corpus reading a source that changed under it", () => {
  /** A corpus whose index is built — from a warm cache, so no source has been read yet. */
  function builtCorpus(root: string) {
    const cacheFile = defaultCacheFile(root);
    candidatesIn(root, cacheFile);
    const corpus = corpusOf(root, cacheFile);
    expect(corpus.candidates(UNRELATED)).toEqual([]);
    return corpus;
  }

  it("skips a nominated source that is gone", () => {
    const root = projects.create({ "src/copy.ts": SHARED, "src/kept.ts": SHARED });
    const corpus = builtCorpus(root);

    rmSync(join(root, "src/copy.ts"));

    expect(corpus.candidates(TARGET).map((source) => source.path)).toEqual(["src/kept.ts"]);
  });

  it("fails closed on a nominated source it cannot read for any other reason", () => {
    const root = projects.create({ "src/copy.ts": SHARED });
    const corpus = builtCorpus(root);

    // The path is still there and no longer a file: a read error that is not "gone".
    rmSync(join(root, "src/copy.ts"));
    mkdirSync(join(root, "src/copy.ts"));

    expect(() => corpus.candidates(TARGET)).toThrow(/EISDIR/);
  });
});
