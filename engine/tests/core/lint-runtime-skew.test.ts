/**
 * Lint runtime skew (issue #57 D6): which lint-rule files differ between the
 * loaded runtime and the gated branch, and the sentence a refusal carries
 * when they do. The comparison is a set rule over path → digest maps, so it
 * is pinned as properties; the rendering is pinned by examples.
 */
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { lintRuntimeSkew, renderLintRuntimeSkew, type LintRuleDigests } from "../../src/core/lint-runtime-skew";

const ROOT = "/runtime/loom";

const digestsArb: fc.Arbitrary<LintRuleDigests> = fc
  .dictionary(
    fc.constantFrom("lint-rules/a.json", "lint-rules/b.json", "engine/src/linter/x.ts", "engine/src/linter/y.ts", "engine/src/linter/programmatic/z.ts"),
    fc.constantFrom("d1", "d2", "d3"),
  )
  .map((record) => new Map(Object.entries(record)));

/** The paths whose digests differ, or that only one map has. */
const expectedDiffering = (runtime: LintRuleDigests, branch: LintRuleDigests): readonly string[] =>
  [...new Set([...runtime.keys(), ...branch.keys()])].filter((path) => runtime.get(path) !== branch.get(path)).sort();

const reversed = (digests: LintRuleDigests): LintRuleDigests => new Map([...digests].reverse());

describe("lintRuntimeSkew", () => {
  it("has nothing to compare when the gated repository is not a Loom checkout", () => {
    fc.assert(fc.property(digestsArb, (runtime) => {
      expect(lintRuntimeSkew(ROOT, runtime, null)).toEqual({ kind: "not-a-loom-checkout" });
    }));
  });

  it("is no-skew exactly when both trees carry the same paths with the same digests", () => {
    fc.assert(fc.property(digestsArb, digestsArb, (runtime, branch) => {
      const skew = lintRuntimeSkew(ROOT, runtime, branch);
      expect(skew.kind === "no-skew").toBe(expectedDiffering(runtime, branch).length === 0);
      expect(lintRuntimeSkew(ROOT, runtime, new Map(runtime)).kind).toBe("no-skew");
    }));
  });

  it("names exactly the changed and one-sided paths, sorted and once each", () => {
    fc.assert(fc.property(digestsArb, digestsArb, (runtime, branch) => {
      const skew = lintRuntimeSkew(ROOT, runtime, branch);
      const expected = expectedDiffering(runtime, branch);
      if (expected.length === 0) return;
      expect(skew).toEqual({ kind: "skewed", runtimeRoot: ROOT, differing: expected });
    }));
  });

  it("is independent of the order either tree was observed in, and symmetric in which paths differ", () => {
    fc.assert(fc.property(digestsArb, digestsArb, (runtime, branch) => {
      expect(lintRuntimeSkew(ROOT, reversed(runtime), reversed(branch))).toEqual(lintRuntimeSkew(ROOT, runtime, branch));
      const forward = lintRuntimeSkew(ROOT, runtime, branch);
      const backward = lintRuntimeSkew(ROOT, branch, runtime);
      expect(forward.kind === "skewed" ? forward.differing : []).toEqual(backward.kind === "skewed" ? backward.differing : []);
    }));
  });
});

describe("renderLintRuntimeSkew", () => {
  it("says nothing unless the rules were not the branch's", () => {
    expect(renderLintRuntimeSkew({ kind: "not-a-loom-checkout" })).toBeNull();
    expect(renderLintRuntimeSkew({ kind: "no-skew" })).toBeNull();
  });

  it("names the runtime, the differing files, and the runbook entry", () => {
    const note = renderLintRuntimeSkew({ kind: "skewed", runtimeRoot: ROOT, differing: ["engine/src/linter/programmatic/no-cross-boundary-imports.ts"] });
    expect(note).toContain(`loaded runtime's lint rules (${ROOT})`);
    expect(note).toContain("engine/src/linter/programmatic/no-cross-boundary-imports.ts");
    expect(note).toContain("runtime skew, not a code defect");
    expect(note).toContain(`"Wave Gate full-tier lint refuses imports the branch allows"`);
  });

  it("names at most eight files and counts the rest", () => {
    const differing = Array.from({ length: 11 }, (_, index) => `engine/src/linter/r${String(index).padStart(2, "0")}.ts`);
    const note = renderLintRuntimeSkew({ kind: "skewed", runtimeRoot: ROOT, differing: differing as [string, ...string[]] });
    expect(note).toContain("engine/src/linter/r07.ts and 3 more");
    expect(note).not.toContain("engine/src/linter/r08.ts");
  });
});
