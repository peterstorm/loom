import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { spawnSync } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { canonicalTempDir } from "../fixtures/canonical-temp-dir";
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

  it("stays exact and minimal for a large, heavily rewritten file without any distance cap", () => {
    // Every third line kept: a large edit distance whose minimal script keeps the shared lines.
    const base = Array.from({ length: 6_000 }, (_, i) => i % 3 === 0 ? `kept-${i}` : `base-${i}`).join("\n") + "\n";
    const head = Array.from({ length: 6_000 }, (_, i) => i % 3 === 0 ? `kept-${i}` : `head-${i}`).join("\n") + "\n";
    const diff = unifiedDiff("big.ts", base, head);
    expect(applyUnifiedDiff(base, diff)).toBe(head);
    expect(diff.split("\n").filter((row) => row.startsWith(" kept-")).length).toBeGreaterThan(1_000);
  });

  it("changes exactly as many lines as Git's minimal diff", () => {
    const root = canonicalTempDir("loom-unified-diff-");
    try {
      fc.assert(fc.property(text, text, (base, head) => {
        writeFileSync(join(root, "a"), base); writeFileSync(join(root, "b"), head);
        const git = spawnSync("git", ["diff", "--no-index", "--minimal", "--numstat", "--", join(root, "a"), join(root, "b")], { encoding: "utf8" });
        // A dead oracle (git unspawnable, or a git failure) must fail loudly,
        // never read as "no diff": `--no-index` exits 1 exactly when the files differ.
        expect(git.error, "git could not be spawned").toBeUndefined();
        expect(git.status, git.stderr).toBe(base === head ? 0 : 1);
        const [added = "0", removed = "0"] = git.stdout.trim() === "" ? [] : git.stdout.trim().split(/\s+/);
        const rows = unifiedDiff("f", base, head).split("\n").filter((row) => !row.startsWith("+++ ") && !row.startsWith("--- "));
        expect([rows.filter((row) => row.startsWith("+")).length, rows.filter((row) => row.startsWith("-")).length])
          .toEqual([Number(added), Number(removed)]);
      }), { seed: 22_004, numRuns: 150 });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
