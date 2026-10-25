import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { changedHeadLines, unifiedDiff } from "../../src/core/unified-diff";

/** Texts built from a small line alphabet so generated pairs share many lines. */
const line = fc.constantFrom("alpha", "beta", "gamma", "delta", "", "  indented", "+plus", "-minus", "@@ at");
const text = fc.record({ lines: fc.array(line, { maxLength: 30 }), finalNewline: fc.boolean() })
  .map(({ lines, finalNewline }) => lines.length === 0 ? "" : lines.join("\n") + (finalNewline ? "\n" : ""));

const headLineCount = (head: string): number => head === "" ? 0 : head.replace(/\n$/, "").split("\n").length;
const all = (count: number): readonly number[] => Array.from({ length: count }, (_, index) => index + 1);
const sortedOf = (lines: ReadonlySet<number>): readonly number[] => [...lines].sort((left, right) => left - right);

/** The 1-based head lines `unifiedDiff` marks `+`: the same edit script, read back from its rendering. */
function addedLinesOfDiff(diff: string): readonly number[] {
  const added: number[] = [];
  let head = 0;
  for (const row of diff.split("\n").slice(2)) {
    const header = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@$/.exec(row);
    if (header !== null) {
      head = header[2] === "0" ? Number(header[1]) : Number(header[1]) - 1;
      continue;
    }
    if (row.startsWith("+")) { head += 1; added.push(head); }
    else if (row.startsWith(" ")) head += 1;
  }
  return added;
}

describe("changedHeadLines", () => {
  it("AS-014: an unchanged owner has no changed line", () => {
    const owner = "export const a = 1;\nexport const b = 2;\n";
    expect(sortedOf(changedHeadLines(owner, owner))).toEqual([]);
  });

  it("FR-009: a null base (a new owner) marks every head line changed", () => {
    expect(sortedOf(changedHeadLines(null, "one\ntwo\nthree\n"))).toEqual([1, 2, 3]);
    expect(sortedOf(changedHeadLines(null, "one\ntwo"))).toEqual([1, 2]);
    expect(sortedOf(changedHeadLines(null, ""))).toEqual([]);
  });

  it("FR-009: a modified line and an inserted line are changed; untouched lines are not", () => {
    const base = "one\ntwo\nthree\nfour\n";
    expect(sortedOf(changedHeadLines(base, "one\nTWO\nthree\nfour\n"))).toEqual([2]);
    expect(sortedOf(changedHeadLines(base, "one\ntwo\ninserted\nthree\nfour\n"))).toEqual([3]);
    expect(sortedOf(changedHeadLines(base, "zero\none\ntwo\nthree\nfour\nfive\n"))).toEqual([1, 6]);
  });

  it("FR-009: a deletion changes no head line", () => {
    expect(sortedOf(changedHeadLines("one\ntwo\nthree\n", "one\nthree\n"))).toEqual([]);
    expect(sortedOf(changedHeadLines("one\n", ""))).toEqual([]);
  });

  it("FR-009: a final line that gains or loses its newline is changed", () => {
    expect(sortedOf(changedHeadLines("one\ntwo", "one\ntwo\n"))).toEqual([2]);
    expect(sortedOf(changedHeadLines("one\ntwo\n", "one\ntwo"))).toEqual([2]);
  });

  it("FR-011: law — the changed lines are exactly the `+` lines of the module's own unified diff", () => {
    fc.assert(fc.property(text, text, (base, head) => {
      expect(sortedOf(changedHeadLines(base, head))).toEqual(addedLinesOfDiff(unifiedDiff("f.ts", base, head)));
    }), { seed: 22_101, numRuns: 1_000 });
  });

  it("FR-011: law — every changed line is a head line, and the unchanged head lines are a subsequence of base", () => {
    fc.assert(fc.property(text, text, (base, head) => {
      const changed = changedHeadLines(base, head);
      const headLines = head === "" ? [] : head.replace(/\n$/, "").split("\n");
      for (const lineNumber of changed) expect(lineNumber >= 1 && lineNumber <= headLineCount(head)).toBe(true);
      const kept = headLines.filter((_, index) => !changed.has(index + 1));
      const baseLines = base === "" ? [] : base.replace(/\n$/, "").split("\n");
      let cursor = 0;
      for (const keptLine of kept) {
        while (cursor < baseLines.length && baseLines[cursor] !== keptLine) cursor += 1;
        expect(cursor < baseLines.length).toBe(true);
        cursor += 1;
      }
    }), { seed: 22_102, numRuns: 1_000 });
  });

  it("FR-011: law — identical sides change nothing and a null base changes everything", () => {
    fc.assert(fc.property(text, (head) => {
      expect(changedHeadLines(head, head).size).toBe(0);
      expect(sortedOf(changedHeadLines(null, head))).toEqual(all(headLineCount(head)));
    }), { seed: 22_103, numRuns: 300 });
  });
});
