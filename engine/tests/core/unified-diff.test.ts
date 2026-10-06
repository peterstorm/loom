import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { applyUnifiedDiff, unifiedDiff } from "../../src/core/unified-diff";

/** Texts built from a small line alphabet so generated pairs share many lines. */
const line = fc.constantFrom("alpha", "beta", "gamma", "delta", "", "  indented", "tab\there", "crlf\r", "\\ backslash", "+plus", "-minus", "@@ at");
const text = fc.record({ lines: fc.array(line, { maxLength: 40 }), finalNewline: fc.boolean() })
  .map(({ lines, finalNewline }) => lines.length === 0 ? "" : lines.join("\n") + (finalNewline ? "\n" : ""));
const side = fc.option(text, { nil: null });

describe("unifiedDiff", () => {
  it("is exact: applying the diff to base reproduces head", () => {
    fc.assert(fc.property(side, side, (base, head) => {
      expect(applyUnifiedDiff(base, unifiedDiff("f.ts", base, head))).toBe(head);
    }), { seed: 22_001, numRuns: 2_000 });
  });

  it("is empty exactly when the two sides are equal", () => {
    fc.assert(fc.property(side, side, (base, head) => {
      expect(unifiedDiff("f.ts", base, head) === "").toBe(base === head);
    }), { seed: 22_002, numRuns: 1_000 });
  });

  it("is deterministic", () => {
    fc.assert(fc.property(side, side, (base, head) => {
      expect(unifiedDiff("f.ts", base, head)).toBe(unifiedDiff("f.ts", base, head));
    }), { seed: 22_003, numRuns: 300 });
  });

  it("renders a modification with context and Git-style headers", () => {
    const base = "one\ntwo\nthree\nfour\nfive\n";
    const head = "one\ntwo\nTHREE\nfour\nfive\n";
    expect(unifiedDiff("src/x.ts", base, head)).toBe(
      "--- a/src/x.ts\n+++ b/src/x.ts\n@@ -1,5 +1,5 @@\n one\n two\n-three\n+THREE\n four\n five\n");
  });

  it("renders an added file against /dev/null", () => {
    expect(unifiedDiff("new.ts", null, "a\nb\n")).toBe("--- /dev/null\n+++ b/new.ts\n@@ -0,0 +1,2 @@\n+a\n+b\n");
  });

  it("renders a deleted file against /dev/null", () => {
    expect(unifiedDiff("old.ts", "a\n", null)).toBe("--- a/old.ts\n+++ /dev/null\n@@ -1 +0,0 @@\n-a\n");
  });

  it("marks a final line that lacks a newline", () => {
    expect(unifiedDiff("x", "a\n", "a")).toBe(
      "--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+a\n\\ No newline at end of file\n");
  });

  it("splits distant changes into separate hunks", () => {
    const base = Array.from({ length: 30 }, (_, i) => `l${i}`).join("\n") + "\n";
    const head = base.replace("l2\n", "L2\n").replace("l27\n", "L27\n");
    expect(unifiedDiff("x", base, head).match(/^@@ /gm)).toHaveLength(2);
  });

  it("stays exact past the edit-distance cap by emitting one replacement", () => {
    const base = Array.from({ length: 2_500 }, (_, i) => `base-${i}`).join("\n") + "\n";
    const head = Array.from({ length: 2_500 }, (_, i) => `head-${i}`).join("\n") + "\n";
    const diff = unifiedDiff("big.ts", base, head);
    expect(applyUnifiedDiff(base, diff)).toBe(head);
  });
});
