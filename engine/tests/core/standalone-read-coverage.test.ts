import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  FROZEN_DIFF_PAGE_UNITS, READ_COVERAGE_SCOPE_BUDGET_UNITS, STANDALONE_READ_COVERAGE_V1,
  admitReadCoverage, freezeDiff, frozenDiffPage, mergeRanges, obligatedUnits, observeReadCoverage,
  parseFrozenDiff, parseReadCoverageObservation, parseStandaloneReadCoverage, readCoverageBudgetProblem,
  readCoverageGaps, type FrozenDiff, type UnitRange,
} from "../../src/core/standalone-read-coverage";

const REQUEST = Object.freeze({ requestId: "request:abc", contextDigest: "d".repeat(64) });

function diffOf(files: Readonly<Record<string, readonly [string | null, string | null]>>): FrozenDiff {
  return freezeDiff({
    baseRevision: "b".repeat(40), headRevision: "h".repeat(40),
    files: Object.entries(files).map(([path, [base, head]]) => ({
      path,
      base: base === null ? { kind: "absent" as const } : { kind: "text" as const, text: base },
      head: head === null ? { kind: "absent" as const } : { kind: "text" as const, text: head },
    })),
  });
}

/** The exact stdout lines the reader prints when paging `path` with `limit`. */
function pages(diff: FrozenDiff, path: string, limit: number): string[] {
  const out: string[] = [];
  let offset: number | null = 0;
  while (offset !== null) {
    const page = frozenDiffPage(diff, path, offset, limit);
    if (!page.ok) throw new Error(page.error);
    out.push(JSON.stringify(page.value));
    offset = page.value.nextOffset;
  }
  return out;
}

const longText = (prefix: string, lines: number) => Array.from({ length: lines }, (_, i) => `${prefix} line ${i}`).join("\n") + "\n";
const DIFF = diffOf({
  "src/a.ts": [longText("old", 1_000), longText("new", 1_000)],
  "src/new.ts": [null, "export const x = 1;\n"],
  "src/same.ts": ["same\n", "same\n"],
});

describe("frozen diff", () => {
  it("records a text diff per changed file and no obligation for unchanged or binary files", () => {
    expect(DIFF.files.map((file) => [file.path, file.kind])).toEqual([
      ["src/a.ts", "text-diff"], ["src/new.ts", "text-diff"], ["src/same.ts", "no-diff"]]);
    const binary = freezeDiff({ baseRevision: "b", headRevision: "h",
      files: [{ path: "img.png", base: { kind: "binary" }, head: { kind: "binary" } }] });
    expect(binary.files).toEqual([{ path: "img.png", kind: "no-diff", reason: "binary" }]);
    expect(obligatedUnits(binary)).toBe(0);
  });

  it("round-trips through its stored JSON and refuses a tampered text", () => {
    expect(parseFrozenDiff(JSON.parse(JSON.stringify(DIFF)))).toEqual({ ok: true, value: DIFF });
    const tampered = JSON.parse(JSON.stringify(DIFF));
    tampered.files[0].text = tampered.files[0].text.replace("new", "NEW");
    expect(parseFrozenDiff(tampered).ok).toBe(false);
  });

  it("refuses a scope over the per-reviewer budget", () => {
    expect(readCoverageBudgetProblem(DIFF)).toBeNull();
    const huge = diffOf({ "big.ts": [null, "x".repeat(READ_COVERAGE_SCOPE_BUDGET_UNITS)] });
    expect(readCoverageBudgetProblem(huge)).toMatch(/partition the scope/);
  });

  it("pages within the configured page size and refuses out-of-range reads", () => {
    const first = frozenDiffPage(DIFF, "src/a.ts", 0, FROZEN_DIFF_PAGE_UNITS);
    expect(first.ok && first.value.text.length).toBe(FROZEN_DIFF_PAGE_UNITS);
    expect(frozenDiffPage(DIFF, "src/a.ts", 0, FROZEN_DIFF_PAGE_UNITS + 1).ok).toBe(false);
    expect(frozenDiffPage(DIFF, "src/same.ts", 0, 100).ok).toBe(false);
    expect(frozenDiffPage(DIFF, "nope.ts", 0, 100).ok).toBe(false);
  });
});

describe("read coverage", () => {
  it("admits a reviewer who read every page of every text diff", () => {
    const outputs = [...pages(DIFF, "src/a.ts", 5_000), ...pages(DIFF, "src/new.ts", 5_000)];
    const observation = observeReadCoverage(DIFF, REQUEST, outputs);
    expect(readCoverageGaps(DIFF, observation)).toEqual([]);
    expect(admitReadCoverage(DIFF, REQUEST, observation)).toEqual({ ok: true, value: null });
  });

  it("leaves exactly the skipped page unread, whatever page is skipped", () => {
    const all = pages(DIFF, "src/a.ts", 3_000);
    fc.assert(fc.property(fc.integer({ min: 0, max: all.length - 1 }), (skip) => {
      const outputs = [...all.filter((_, i) => i !== skip), ...pages(DIFF, "src/new.ts", 3_000)];
      const skipped = JSON.parse(all[skip]!) as { offset: number; text: string };
      expect(readCoverageGaps(DIFF, observeReadCoverage(DIFF, REQUEST, outputs))).toEqual([
        { path: "src/a.ts", totalUnits: (DIFF.files[0] as { totalUnits: number }).totalUnits,
          unread: [[skipped.offset, skipped.offset + skipped.text.length]] },
      ]);
    }), { seed: 22_101, numRuns: 50 });
  });

  it("counts pages in any order, duplicated, or chained in one output", () => {
    const outputs = [...pages(DIFF, "src/a.ts", 4_000), ...pages(DIFF, "src/new.ts", 4_000)];
    fc.assert(fc.property(fc.shuffledSubarray(outputs, { minLength: outputs.length }), fc.boolean(), (shuffled, chain) => {
      const delivered = chain ? [shuffled.join("\n")] : [...shuffled, ...shuffled.slice(0, 1)];
      expect(readCoverageGaps(DIFF, observeReadCoverage(DIFF, REQUEST, delivered))).toEqual([]);
    }), { seed: 22_102, numRuns: 100 });
  });

  it("does not count a forged, truncated, or foreign page", () => {
    const real = JSON.parse(pages(DIFF, "src/new.ts", 5_000)[0]!) as Record<string, unknown>;
    const forgeries = [
      JSON.stringify({ ...real, text: String(real.text).replace("x", "y") }),
      JSON.stringify({ ...real, digest: "0".repeat(64) }),
      JSON.stringify({ ...real, text: String(real.text).slice(0, 5), nextOffset: null }),
      JSON.stringify({ ...real, path: "src/same.ts" }),
      `I read ${String(real.path)} completely.`,
      pages(DIFF, "src/new.ts", 5_000)[0]!.slice(0, -10),
    ];
    for (const forged of forgeries) {
      const gaps = readCoverageGaps(DIFF, observeReadCoverage(DIFF, REQUEST, [...pages(DIFF, "src/a.ts", 5_000), forged]));
      expect(gaps.map(({ path }) => path)).toEqual(["src/new.ts"]);
    }
  });

  it("refuses an absent, unobservable, or foreign observation", () => {
    expect(admitReadCoverage(DIFF, REQUEST, null).ok).toBe(false);
    expect(admitReadCoverage(DIFF, REQUEST, observeReadCoverage(DIFF, REQUEST, null))).toMatchObject({ ok: false, error: expect.stringMatching(/not observed/) });
    const foreign = observeReadCoverage(DIFF, { ...REQUEST, requestId: "request:other" }, []);
    expect(admitReadCoverage(DIFF, REQUEST, foreign)).toMatchObject({ ok: false, error: expect.stringMatching(/different request/) });
  });

  it("obliges nothing, and so needs no observation, when no scoped file has a text diff", () => {
    const unchanged = diffOf({ "src/same.ts": ["same\n", "same\n"] });
    expect(admitReadCoverage(unchanged, REQUEST, null)).toEqual({ ok: true, value: null });
  });

  it("names every unread file and range in the refusal", () => {
    const refused = admitReadCoverage(DIFF, REQUEST, observeReadCoverage(DIFF, REQUEST, pages(DIFF, "src/new.ts", 5_000)));
    expect(refused).toMatchObject({ ok: false, error: expect.stringContaining("src/a.ts (") });
  });

  it("round-trips the stored observation", () => {
    const observation = observeReadCoverage(DIFF, REQUEST, pages(DIFF, "src/a.ts", 2_500));
    expect(parseReadCoverageObservation(JSON.parse(JSON.stringify(observation)))).toEqual({ ok: true, value: observation });
    expect(parseReadCoverageObservation({ ...observation, covered: [{ path: "x", ranges: [[5, 2]] }] }).ok).toBe(false);
  });
});

describe("policy and ranges", () => {
  it("parses only the exact v1 policy", () => {
    expect(parseStandaloneReadCoverage(JSON.parse(JSON.stringify(STANDALONE_READ_COVERAGE_V1)))).toEqual({ ok: true, value: STANDALONE_READ_COVERAGE_V1 });
    expect(parseStandaloneReadCoverage({ ...STANDALONE_READ_COVERAGE_V1, pageUnits: 1 }).ok).toBe(false);
    expect(parseStandaloneReadCoverage({ ...STANDALONE_READ_COVERAGE_V1, extra: true }).ok).toBe(false);
  });

  const range = fc.tuple(fc.nat(500), fc.nat(500)).map(([a, b]): UnitRange => [Math.min(a, b), Math.max(a, b)]);
  const covers = (ranges: readonly UnitRange[], unit: number) => ranges.some(([s, e]) => unit >= s && unit < e);

  it("merges ranges into a disjoint sorted union covering exactly the same units", () => {
    fc.assert(fc.property(fc.array(range, { maxLength: 20 }), (ranges) => {
      const merged = mergeRanges(ranges);
      for (let unit = 0; unit < 510; unit += 1) expect(covers(merged, unit)).toBe(covers(ranges, unit));
      merged.slice(1).forEach(([start], i) => expect(start).toBeGreaterThan(merged[i]![1]));
      expect(mergeRanges(merged)).toEqual(merged);
    }), { seed: 22_103, numRuns: 300 });
  });
});
