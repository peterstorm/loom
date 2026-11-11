/**
 * The fingerprint cache document: it reads back exactly what it wrote, and
 * anything else is an empty cache — never an error, never a partial one.
 */
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import type { CloneOptions } from "../../../src/linter/clones/clone-detection";
import {
  cachedHashes,
  EMPTY_INDEX_CACHE,
  indexEntries,
  parseIndexCache,
  renderIndexCache,
  type CachedFile,
  type IndexCache,
} from "../../../src/linter/clones/index-cache";

const OPTIONS: CloneOptions = { minTokens: 100, minLines: 8 };

const cachedFile: fc.Arbitrary<CachedFile> = fc.record({
  size: fc.nat(),
  mtimeMs: fc.double({ min: 0, max: 4e12, noNaN: true }),
  hashes: fc.array(fc.integer({ min: -(2 ** 31), max: 2 ** 31 - 1 })),
});

const cache: fc.Arbitrary<IndexCache> = fc
  .dictionary(fc.stringMatching(/^[a-z]{1,8}(\/[a-z]{1,8}){0,3}\.ts$/), cachedFile)
  .map((files) => new Map(Object.entries(files)));

const FILE: CachedFile = { size: 10, mtimeMs: 1_700_000_000_123.5, hashes: [1, -2, 3] };
const ONE: IndexCache = new Map([["src/a.ts", FILE]]);

describe("index cache", () => {
  it("reads back exactly what it rendered", () => {
    fc.assert(
      fc.property(cache, (written) => {
        expect(parseIndexCache(renderIndexCache(written, OPTIONS), OPTIONS)).toEqual(written);
      }),
    );
  });

  it("is empty for a cache built with another token threshold: its hashes are of other k-grams", () => {
    expect(parseIndexCache(renderIndexCache(ONE, OPTIONS), { ...OPTIONS, minTokens: 70 })).toEqual(EMPTY_INDEX_CACHE);
  });

  it("keeps a cache when only the line threshold differs: fingerprints do not depend on it", () => {
    expect(parseIndexCache(renderIndexCache(ONE, OPTIONS), { ...OPTIONS, minLines: 3 })).toEqual(ONE);
  });

  it.each([
    ["not JSON", "{ torn"],
    ["not an object", "[]"],
    ["another version", JSON.stringify({ version: 0, minTokens: 100, files: {} })],
    ["no file table", JSON.stringify({ version: 1, minTokens: 100 })],
    ["an entry of another shape", JSON.stringify({ version: 1, minTokens: 100, files: { "a.ts": [1, 2] } })],
    ["a hash that is not an integer", JSON.stringify({ version: 1, minTokens: 100, files: { "a.ts": [1, 2, [0.5]] } })],
    ["one bad entry among good ones", JSON.stringify({ version: 1, minTokens: 100, files: { "a.ts": [1, 2, [3]], "b.ts": "x" } })],
  ])("is empty for a document that is %s", (_label, text) => {
    expect(parseIndexCache(text, OPTIONS)).toEqual(EMPTY_INDEX_CACHE);
  });

  it("answers with the cached hashes only while size and time both match", () => {
    expect(cachedHashes(ONE, "src/a.ts", { size: 10, mtimeMs: FILE.mtimeMs })).toEqual([1, -2, 3]);
    expect(cachedHashes(ONE, "src/a.ts", { size: 11, mtimeMs: FILE.mtimeMs })).toBeNull();
    expect(cachedHashes(ONE, "src/a.ts", { size: 10, mtimeMs: FILE.mtimeMs + 1 })).toBeNull();
    expect(cachedHashes(ONE, "src/b.ts", { size: 10, mtimeMs: FILE.mtimeMs })).toBeNull();
  });

  it("stands for one index entry per file", () => {
    expect(indexEntries(ONE)).toEqual([{ path: "src/a.ts", hashes: [1, -2, 3] }]);
  });
});
