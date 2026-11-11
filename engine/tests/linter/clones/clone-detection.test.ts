/**
 * The clone detector, both directions: the copies it exists to catch, and the
 * likenesses it must leave alone. A detector that fires on two files importing
 * the same modules gets disabled, which is worse than not having it.
 */
import { describe, expect, it } from "vitest";
import {
  candidatePaths,
  cloneIndex,
  clonesBetween,
  DEFAULT_CLONE_OPTIONS,
  fingerprint,
  fingerprintHashes,
  fingerprintScheme,
  MAX_SEEDS_PER_HASH,
  parseCloneOptions,
  sharedRuns,
  tokenStream,
  type Clone,
  type Fingerprinted,
} from "../../../src/linter/clones/clone-detection";
import { block, cloneOptions } from "../../fixtures/clone-fixtures";

/** Small thresholds so a fixture is a dozen lines, not a hundred. */
const OPTIONS = cloneOptions(20, 4);

const SHARED = block("shared", 8);

const source = (path: string, ...blocks: readonly string[]): Fingerprinted =>
  fingerprint(path, blocks.join("\n"), OPTIONS);

describe("parseCloneOptions", () => {
  it("accepts two positive integers, and the shipped defaults are such a pair", () => {
    expect(parseCloneOptions({ minTokens: 1, minLines: 1 })).toEqual({ ok: true, value: { minTokens: 1, minLines: 1 } });
    expect(DEFAULT_CLONE_OPTIONS).toEqual({ minTokens: 100, minLines: 8 });
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, "100", null, undefined])(
    "refuses %s as either threshold, naming the one it refused",
    (raw) => {
      expect(parseCloneOptions({ minTokens: raw, minLines: 8 })).toEqual({
        ok: false,
        error: `minTokens must be a positive integer, got ${String(raw)}`,
      });
      expect(parseCloneOptions({ minTokens: 100, minLines: raw })).toEqual({
        ok: false,
        error: `minLines must be a positive integer, got ${String(raw)}`,
      });
    },
  );

  it("fingerprints at the smallest threshold there is: one token is one gram in a window of one", () => {
    const single = fingerprint("src/a.ts", "a b c", cloneOptions(1, 1));
    expect(Array.from(single.selected)).toEqual([0, 1, 2]);
  });
});

describe("fingerprintScheme", () => {
  it("is the same for options that fingerprint alike: the line threshold is not part of it", () => {
    expect(fingerprintScheme(cloneOptions(100, 3))).toBe(fingerprintScheme(DEFAULT_CLONE_OPTIONS));
  });

  it("differs when the token threshold does: the hashes are of other k-grams", () => {
    expect(fingerprintScheme(cloneOptions(70, 8))).not.toBe(fingerprintScheme(DEFAULT_CLONE_OPTIONS));
  });

  // A change detector on purpose. This value moves whenever the segmenter, the
  // tokenizer, the import skip, a hash constant or the winnowing changes what a
  // fingerprint means. Cached fingerprints retire themselves when it does; a
  // project's `duplicateBlockBaseline` digests may have moved with it, so
  // re-check them (`lint-project`) before updating the value here.
  it("names what the scheme does to its probe, and the gram and window sizes", () => {
    expect(fingerprintScheme(DEFAULT_CLONE_OPTIONS)).toBe("c823ffd7/k50/w51");
  });
});

describe("tokenStream", () => {
  it("ignores whitespace and comments", () => {
    const plain = tokenStream("const total = add(1, 2);");
    const spaced = tokenStream("const   total =\n  add( 1 , 2 ) ; // sum\n/* done */");
    expect(Array.from(spaced.hashes)).toEqual(Array.from(plain.hashes));
  });

  it("records the line each token starts on", () => {
    expect(Array.from(tokenStream("a\n\n  b // tail\nc").lines)).toEqual([1, 3, 4]);
  });

  it("keeps a string literal as one token, distinct by content", () => {
    const first = tokenStream(`call("one two three")`);
    const second = tokenStream(`call("one two four")`);
    expect(first.hashes).toHaveLength(4);
    expect(first.hashes[2]).not.toBe(second.hashes[2]);
  });

  it("drops import statements, single-line and multi-line", () => {
    const withImports = [
      `import { a, b } from "./one";`,
      `import type {`,
      `  C,`,
      `} from "./two";`,
      `import "./side-effect";`,
      `const value = a + b;`,
    ].join("\n");
    expect(Array.from(tokenStream(withImports).hashes)).toEqual(Array.from(tokenStream("const value = a + b;").hashes));
  });

  it("keeps a dynamic import and import.meta, even leading a line", () => {
    const wrapped = tokenStream(`const loaded = await\nimport("./lazy");\nconst here =\nimport.meta.url;`);
    const flat = tokenStream(`const loaded = await import("./lazy"); const here = import.meta.url;`);
    expect(Array.from(wrapped.hashes)).toEqual(Array.from(flat.hashes));
  });

  it("keeps the tokens after an import that never names a module", () => {
    expect(tokenStream("import\nfoo = bar;").hashes).toHaveLength(5);
  });
});

describe("clonesBetween", () => {
  it("reports a block copied into another file, with both sites, cut to whole lines", () => {
    const original = source("src/a.ts", block("before", 3), SHARED, block("after", 2));
    const copy = source("src/b.ts", block("other", 5), SHARED);

    const clones = clonesBetween(copy, original, OPTIONS);

    // Both copies follow a line ending `);`, which the maximal run includes;
    // the whole-line cut drops it.
    expect(clones).toEqual([
      {
        tokens: tokenStream(SHARED).hashes.length,
        digest: expect.stringMatching(/^[0-9a-f]{8}$/),
        here: { path: "src/b.ts", startLine: 6, endLine: 13 },
        there: { path: "src/a.ts", startLine: 4, endLine: 11 },
      },
    ]);
  });

  it("is symmetric: the same run from either side, sites swapped", () => {
    const left = source("src/a.ts", block("p", 2), SHARED);
    const right = source("src/b.ts", SHARED, block("q", 4));

    const forward = clonesBetween(left, right, OPTIONS);

    expect(forward).toHaveLength(1);
    expect(clonesBetween(right, left, OPTIONS)).toEqual(
      forward.map((clone) => ({ ...clone, here: clone.there, there: clone.here })),
    );
  });

  it("matches through reformatting and comments", () => {
    const original = source("src/a.ts", SHARED);
    const reformatted = source("src/b.ts", SHARED.replaceAll(" = ", " = // why\n    "));
    expect(clonesBetween(reformatted, original, OPTIONS)).toHaveLength(1);
  });

  it("leaves two files of different code alone", () => {
    expect(clonesBetween(source("src/a.ts", block("one", 12)), source("src/b.ts", block("two", 12)), OPTIONS)).toEqual([]);
  });

  it("leaves a shared run shorter than the token threshold alone", () => {
    const short = block("shared", 1);
    const one = source("src/a.ts", block("one", 6), short);
    const two = source("src/b.ts", short, block("two", 6));
    expect(clonesBetween(one, two, OPTIONS)).toEqual([]);
  });

  it("leaves a long shared run on too few lines alone", () => {
    const oneLine = SHARED.replaceAll("\n", " ");
    expect(clonesBetween(source("src/a.ts", oneLine), source("src/b.ts", oneLine), OPTIONS)).toEqual([]);
  });

  it("leaves two files alone that share only their imports", () => {
    const imports = Array.from({ length: 12 }, (_, row) => `import { thing${row} } from "./module-${row}";`).join("\n");
    const one = source("src/a.ts", imports, block("one", 3));
    const two = source("src/b.ts", imports, block("two", 3));
    expect(clonesBetween(one, two, OPTIONS)).toEqual([]);
  });

  it("finds a block a file holds twice, once", () => {
    const twice = source("src/a.ts", SHARED, block("between", 2), SHARED);

    const clones = clonesBetween(twice, twice, OPTIONS);

    expect(clones).toHaveLength(1);
    expect(clones[0]).toMatchObject({ here: { startLine: 1, endLine: 8 }, there: { startLine: 11, endLine: 18 } });
  });

  it("does not report a file as a clone of itself", () => {
    const plain = source("src/a.ts", block("one", 6), block("two", 6));
    expect(clonesBetween(plain, plain, OPTIONS)).toEqual([]);
  });

  it("reports a block written three times running once per repeat, never the same pair twice", () => {
    const thrice = source("src/a.ts", SHARED, SHARED, SHARED);

    expect(clonesBetween(thrice, thrice, OPTIONS).map(({ here, there }) => [here.startLine, there.startLine])).toEqual([
      [1, 9],
      [1, 17],
    ]);
  });

  it("gives a run the same digest wherever it sits, and another when it changes", () => {
    const digestOf = (target: Fingerprinted, other: Fingerprinted): string | undefined =>
      clonesBetween(target, other, OPTIONS)[0]?.digest;
    const original = source("src/a.ts", SHARED);
    const moved = source("src/b.ts", block("pad", 9), SHARED);
    const grown = [SHARED, "const extra = 1;"].join("\n");

    expect(digestOf(moved, original)).toBe(digestOf(original, moved));
    expect(digestOf(source("src/c.ts", grown), source("src/d.ts", grown))).not.toBe(digestOf(moved, original));
  });
});

describe("the seed bound", () => {
  /** One line written `count` times: every fingerprint of the source is the same hash. */
  const repeated = (path: string, count: number): Fingerprinted =>
    source(path, ...Array.from({ length: count }, () => `const value = compute(input, "x");`));

  const sites = (clones: readonly Clone[]): readonly string[] =>
    clones.map(({ here, there }) => `${here.startLine}-${here.endLine}:${there.startLine}-${there.endLine}`);

  it("pairs no more seeds for 3,000 identical lines than for 300, within one file or across two", () => {
    const small = repeated("src/small.ts", 300);
    const big = repeated("src/big.ts", 3_000);
    const other = repeated("src/other.ts", 3_000);

    // Uncapped these are cross products: ~4.5 million seeds within `big`, ~9 million against `other`.
    expect(big.selected.length).toBeGreaterThan(2_900);
    expect(sharedRuns(big, big).seeds).toBe(sharedRuns(small, small).seeds);
    expect(sharedRuns(big, big).seeds).toBeLessThanOrEqual(MAX_SEEDS_PER_HASH ** 2);
    expect(sharedRuns(big, other).seeds).toBe(sharedRuns(small, other).seeds);
    expect(sharedRuns(big, other).seeds).toBeLessThanOrEqual(MAX_SEEDS_PER_HASH ** 2);
  });

  it("never pairs more seeds than the cap times the smaller source's fingerprints", () => {
    const table = (path: string, rows: number): Fingerprinted =>
      source(path, ...Array.from({ length: rows }, (_, row) => `  { id: ${row % 7}, name: "row", flags: [1, 2, 3] },`));
    const long = table("src/long.ts", 2_000);
    const short = table("src/short.ts", 150);

    for (const [target, other] of [[long, short], [short, long], [long, long]] as const) {
      const { seeds, runs } = sharedRuns(target, other);
      expect(seeds).toBeLessThanOrEqual(MAX_SEEDS_PER_HASH * Math.min(target.selected.length, other.selected.length));
      // Each maximal run is extended once: never more runs than seeds, never one twice.
      expect(runs.length).toBeLessThanOrEqual(seeds);
      expect(new Set(runs.map((run) => `${run.start}:${run.delta}`)).size).toBe(runs.length);
    }
  });

  it("still reports the repetition, each pairing once", () => {
    const big = repeated("src/big.ts", 3_000);

    const clones = clonesBetween(big, big, OPTIONS);

    expect(clones.length).toBeGreaterThan(0);
    expect(new Set(sites(clones)).size).toBe(clones.length);
  });

  it("misses a copy only past a source's first 32 occurrences of every fingerprint in it", () => {
    const copies = 40;
    // Each copy of SHARED sits behind a line of its own, so no run reaches from one copy into the next.
    const many = source("src/many.ts", ...Array.from({ length: copies }, (_, copy) => [block(`gap${copy}`, 1), SHARED].join("\n")));
    const one = source("src/one.ts", SHARED);

    const reported = clonesBetween(many, one, OPTIONS).map((clone) => clone.here.startLine);

    // Copy `n` starts on line 9n + 2: the first 32 are reported, the last 8 are not.
    expect(reported).toEqual(Array.from({ length: MAX_SEEDS_PER_HASH }, (_, copy) => copy * 9 + 2));
    // From the other side the same 32 pairings, mirrored: the cap is symmetric.
    expect(clonesBetween(one, many, OPTIONS).map((clone) => clone.there.startLine)).toEqual(reported);
  });

  it("changes nothing below the cap: 32 copies are 32 reports", () => {
    const many = source("src/many.ts", ...Array.from({ length: MAX_SEEDS_PER_HASH }, (_, copy) => [block(`gap${copy}`, 1), SHARED].join("\n")));
    expect(clonesBetween(many, source("src/one.ts", SHARED), OPTIONS)).toHaveLength(MAX_SEEDS_PER_HASH);
  });
});

describe("candidatePaths", () => {
  const first = source("src/a.ts", block("one", 4), SHARED);
  const second = source("src/b.ts", SHARED, block("two", 4));
  const unrelated = source("src/c.ts", block("three", 12));
  const index = cloneIndex(
    [first, second, unrelated].map((entry) => ({ path: entry.path, hashes: fingerprintHashes(entry) })),
  );

  it("names the sources sharing a fingerprint, never the target itself", () => {
    expect(candidatePaths(first, index)).toEqual(["src/b.ts"]);
    expect(candidatePaths(unrelated, index)).toEqual([]);
  });

  it("nominates sources for a target the index has never seen", () => {
    expect(candidatePaths(source("src/new.ts", block("fresh", 2), SHARED), index)).toEqual(["src/a.ts", "src/b.ts"]);
  });
});
