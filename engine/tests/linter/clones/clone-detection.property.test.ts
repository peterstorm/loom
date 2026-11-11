/**
 * The laws the clone detector's callers rely on, over generated sources:
 *   - completeness: a block planted in two sources is always reported, however
 *     it is surrounded — the winnowing guarantee, end to end;
 *   - soundness: every reported run really is the same tokens on both sides;
 *   - symmetry: asking from either side gives the same runs;
 *   - layout independence: blank lines and comments change nothing;
 *   - index completeness: a pair with a clone is always nominated.
 */
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  candidatePaths,
  cloneIndex,
  clonesBetween,
  fingerprint,
  fingerprintHashes,
  tokenStream,
  type Clone,
  type CloneOptions,
} from "../../../src/linter/clones/clone-detection";

/** Eight tokens a line, so three lines clear the token threshold. */
const OPTIONS: CloneOptions = { minTokens: 24, minLines: 3 };

const line = (id: number): string => `const v${id} = f${id}(${id});`;

/** Lines drawn from a small alphabet, so generated sources share runs by accident. */
const lines = (minLength = 0): fc.Arbitrary<readonly string[]> =>
  fc.array(fc.integer({ min: 0, max: 12 }).map(line), { minLength, maxLength: 30 });

/** Lines drawn from an alphabet of their own, sharing no statement with `lines` or each other. */
const linesFrom = (base: number): fc.Arbitrary<readonly string[]> =>
  fc.array(fc.integer({ min: base, max: base + 50 }).map(line), { maxLength: 15 });

/** A block of distinct statements no other alphabet holds, long enough to be a clone. */
const planted = fc.integer({ min: 4, max: 12 }).map((length) => Array.from({ length }, (_, row) => line(1000 + row)));

const linesOf = (content: readonly string[], site: Clone["here"]): string =>
  content.slice(site.startLine - 1, site.endLine).join("\n");

const mirrored = (clones: readonly Clone[]): readonly Clone[] =>
  clones
    .map((clone) => ({ ...clone, here: clone.there, there: clone.here }))
    .sort((left, right) => left.here.startLine - right.here.startLine || left.there.startLine - right.there.startLine);

describe("clone detection laws", () => {
  it("always reports a block planted in two sources", () => {
    fc.assert(
      fc.property(linesFrom(100), linesFrom(200), linesFrom(300), linesFrom(400), planted, (before, after, lead, tail, block) => {
        const target = fingerprint("target.ts", [...before, ...block, ...after].join("\n"), OPTIONS);
        const other = fingerprint("other.ts", [...lead, ...block, ...tail].join("\n"), OPTIONS);

        const clones = clonesBetween(target, other, OPTIONS);

        const first = before.length + 1;
        const last = before.length + block.length;
        expect(clones.some((clone) => clone.here.startLine <= first && clone.here.endLine >= last)).toBe(true);
      }),
    );
  });

  it("reports only runs that are the same tokens on both sides", () => {
    fc.assert(
      fc.property(lines(), lines(), (left, right) => {
        const target = fingerprint("left.ts", left.join("\n"), OPTIONS);
        const other = fingerprint("right.ts", right.join("\n"), OPTIONS);

        for (const clone of clonesBetween(target, other, OPTIONS)) {
          const here = Array.from(tokenStream(linesOf(left, clone.here)).hashes);
          expect(here).toEqual(Array.from(tokenStream(linesOf(right, clone.there)).hashes));
          expect(here.length).toBe(clone.tokens);
          expect(clone.tokens).toBeGreaterThanOrEqual(OPTIONS.minTokens);
        }
      }),
    );
  });

  it("finds the same runs from either side", () => {
    fc.assert(
      fc.property(lines(), lines(), (left, right) => {
        const a = fingerprint("left.ts", left.join("\n"), OPTIONS);
        const b = fingerprint("right.ts", right.join("\n"), OPTIONS);
        expect(clonesBetween(b, a, OPTIONS)).toEqual(mirrored(clonesBetween(a, b, OPTIONS)));
      }),
    );
  });

  it("is unmoved by blank lines and comments", () => {
    fc.assert(
      fc.property(lines(3), lines(3), (left, right) => {
        const plain = fingerprint("left.ts", left.join("\n"), OPTIONS);
        const padded = fingerprint("left.ts", left.map((text) => `${text} // note`).join("\n\n/* gap */\n"), OPTIONS);
        const other = fingerprint("right.ts", right.join("\n"), OPTIONS);

        const digests = (target: typeof plain): readonly string[] =>
          clonesBetween(target, other, OPTIONS).map((clone) => `${clone.digest}:${clone.tokens}`);

        expect(digests(padded)).toEqual(digests(plain));
      }),
    );
  });

  it("nominates every pair that holds a clone", () => {
    fc.assert(
      fc.property(lines(), lines(), (left, right) => {
        const a = fingerprint("left.ts", left.join("\n"), OPTIONS);
        const b = fingerprint("right.ts", right.join("\n"), OPTIONS);
        const index = cloneIndex([a, b].map((entry) => ({ path: entry.path, hashes: fingerprintHashes(entry) })));

        if (clonesBetween(a, b, OPTIONS).length > 0) expect(candidatePaths(a, index)).toEqual(["right.ts"]);
      }),
    );
  });
});
