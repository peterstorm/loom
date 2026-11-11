/**
 * The project corpus against a real directory: which files it nominates, and
 * what the fingerprint cache may and may not change.
 */
import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fingerprint, type CloneOptions } from "../../../src/linter/clones/clone-detection";
import { parseIndexCache, renderIndexCache } from "../../../src/linter/clones/index-cache";
import { defaultCacheFile, projectCorpus } from "../../../src/linter/clones/project-corpus";
import { canonicalTempDir } from "../../fixtures/canonical-temp-dir";

const CLONE: CloneOptions = { minTokens: 20, minLines: 4 };

const block = (name: string, count: number): string =>
  Array.from({ length: count }, (_, row) => `const ${name}${row} = compute${name}(${row}, "${name}");`).join("\n");

const SHARED = block("shared", 8);
const TARGET = fingerprint("src/target.ts", [block("target", 2), SHARED].join("\n"), CLONE);

const cleanup: string[] = [];
afterEach(() => {
  for (const dir of cleanup.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function projectWith(files: Readonly<Record<string, string>>): string {
  const root = canonicalTempDir("project-corpus-");
  cleanup.push(root);
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return root;
}

const candidatesIn = (root: string, cacheFile: string | null, exclusions: readonly { path: string; reason: string }[] = []) =>
  projectCorpus({ projectRoot: root, exclusions, clone: CLONE, cacheFile }).candidates(TARGET).map((source) => source.path);

describe("projectCorpus", () => {
  it("nominates the script files sharing a block, by project-relative path", () => {
    const root = projectWith({
      "src/copy.ts": [SHARED, block("copy", 2)].join("\n"),
      "tests/deep/copy.test.tsx": [block("deep", 3), SHARED].join("\n"),
      "src/unrelated.ts": block("unrelated", 12),
      "src/Copy.java": SHARED,
      "node_modules/pkg/copy.ts": SHARED,
    });
    expect(candidatesIn(root, null)).toEqual(["src/copy.ts", "tests/deep/copy.test.tsx"]);
  });

  it("never nominates the target itself or an excluded path", () => {
    const root = projectWith({
      "src/target.ts": [block("target", 2), SHARED].join("\n"),
      "vendor-copy/copy.ts": SHARED,
      "src/copy.ts": SHARED,
    });
    expect(candidatesIn(root, null, [{ path: "vendor-copy/", reason: "vendored" }])).toEqual(["src/copy.ts"]);
  });

  it("reads a nominated source's current bytes", () => {
    const root = projectWith({ "src/copy.ts": [SHARED, block("copy", 2)].join("\n") });
    const [copy] = projectCorpus({ projectRoot: root, exclusions: [], clone: CLONE, cacheFile: null }).candidates(TARGET);
    expect(Array.from(copy?.stream.hashes ?? [])).toEqual(
      Array.from(fingerprint("src/copy.ts", readFileSync(join(root, "src/copy.ts"), "utf-8"), CLONE).stream.hashes),
    );
  });

  it("writes no cache when given none", () => {
    const root = projectWith({ "src/copy.ts": SHARED });
    candidatesIn(root, null);
    expect(existsSync(defaultCacheFile(root))).toBe(false);
  });
});

describe("projectCorpus with a fingerprint cache", () => {
  const cached = (root: string) => parseIndexCache(readFileSync(defaultCacheFile(root), "utf-8"), CLONE);

  it("records every compared file's size, time and fingerprints on first use", () => {
    const root = projectWith({ "src/copy.ts": SHARED, "src/unrelated.ts": block("unrelated", 12) });
    expect(candidatesIn(root, defaultCacheFile(root))).toEqual(["src/copy.ts"]);
    expect([...cached(root).keys()]).toEqual(["src/copy.ts", "src/unrelated.ts"]);
    expect(cached(root).get("src/copy.ts")?.hashes.length).toBeGreaterThan(0);
  });

  it("re-fingerprints a file whose bytes changed since the cache was written", () => {
    const root = projectWith({ "src/later.ts": block("later", 12) });
    const cacheFile = defaultCacheFile(root);
    expect(candidatesIn(root, cacheFile)).toEqual([]);

    writeFileSync(join(root, "src/later.ts"), [block("later", 12), SHARED].join("\n"));

    expect(candidatesIn(root, cacheFile)).toEqual(["src/later.ts"]);
  });

  it("drops a deleted file and picks up a new one", () => {
    const root = projectWith({ "src/old.ts": SHARED });
    const cacheFile = defaultCacheFile(root);
    expect(candidatesIn(root, cacheFile)).toEqual(["src/old.ts"]);

    rmSync(join(root, "src/old.ts"));
    writeFileSync(join(root, "src/new.ts"), SHARED);

    expect(candidatesIn(root, cacheFile)).toEqual(["src/new.ts"]);
    expect([...cached(root).keys()]).toEqual(["src/new.ts"]);
  });

  it("trusts an entry whose size and time still match — the cache can hide a copy, which is why the gate reads none", () => {
    const root = projectWith({ "src/copy.ts": SHARED });
    const cacheFile = defaultCacheFile(root);
    expect(candidatesIn(root, cacheFile)).toEqual(["src/copy.ts"]);

    const emptied = new Map([...cached(root)].map(([path, file]) => [path, { ...file, hashes: [] }] as const));
    writeFileSync(cacheFile, renderIndexCache(emptied, CLONE));

    expect(candidatesIn(root, cacheFile)).toEqual([]);
    expect(candidatesIn(root, null)).toEqual(["src/copy.ts"]);
  });

  it("can never make a copy appear: a nominated file is compared by its current bytes", () => {
    const root = projectWith({ "src/copy.ts": SHARED });
    const cacheFile = defaultCacheFile(root);
    // A whole-second stamp, so setting it again reproduces it exactly.
    const stamp = new Date("2026-01-01T00:00:00Z");
    utimesSync(join(root, "src/copy.ts"), stamp, stamp);
    candidatesIn(root, cacheFile);

    // Same size, same time, different bytes: the stale entry still nominates it…
    const rewritten = SHARED.replaceAll("shared", "sharee");
    writeFileSync(join(root, "src/copy.ts"), rewritten);
    utimesSync(join(root, "src/copy.ts"), stamp, stamp);

    const [nominated] = projectCorpus({ projectRoot: root, exclusions: [], clone: CLONE, cacheFile }).candidates(TARGET);
    // …and what it hands the rule is the file as it is now.
    expect(Array.from(nominated?.stream.hashes ?? [])).toEqual(
      Array.from(fingerprint("src/copy.ts", rewritten, CLONE).stream.hashes),
    );
  });

  it("rebuilds from the sources when the cache file is not its own output", () => {
    const root = projectWith({ "src/copy.ts": SHARED });
    const cacheFile = defaultCacheFile(root);
    mkdirSync(dirname(cacheFile), { recursive: true });
    writeFileSync(cacheFile, "{ not json");
    expect(candidatesIn(root, cacheFile)).toEqual(["src/copy.ts"]);
    expect([...cached(root).keys()]).toEqual(["src/copy.ts"]);
  });
});
