import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { PLAN_DESIGN_REVIEWERS } from "../../src/core/plan-design-review";
import { selectStandaloneReviewers, type StandaloneReviewKind, type StandaloneReviewMetadata } from "../../src/core/standalone-review-scope";

/**
 * Reviewer selection is the policy that decides which specialists a scope
 * deserves. These tests pin the simplifier's membership rules: an explicit
 * `simplify` request always gets it, and the default `all` review includes it
 * exactly when the scope contains source or test changes — a docs-only or
 * metadata-only scope has nothing for the distill catalog to act on, and a
 * roster member with an empty mandate is pure spend.
 */
const metadata = (
  overrides: Partial<StandaloneReviewMetadata> & { requestedKinds: readonly StandaloneReviewKind[] },
): StandaloneReviewMetadata => {
  const value = {
  docsOnly: false,
  sourceOrTestChanged: false,
  typesChanged: false,
  commentsChanged: false,
  additions: 10,
  fileCount: 2,
  newStructure: false,
  languages: ["typescript"],
  ...overrides,
  requestedKinds: Object.freeze([...overrides.requestedKinds]) as StandaloneReviewMetadata["requestedKinds"],
  };
  if (value.docsOnly && (value.sourceOrTestChanged || !value.commentsChanged)) throw new Error("contradictory fixture metadata");
  return value.docsOnly
    ? { ...value, docsOnly: true, sourceOrTestChanged: false, commentsChanged: true }
    : { ...value, docsOnly: false };
};

describe("selectStandaloneReviewers: code-simplifier membership", () => {
  it("explicit simplify kind always selects code-simplifier, even without source changes", () => {
    const selected = selectStandaloneReviewers(metadata({ requestedKinds: ["simplify"] }));
    expect(selected).toContain("code-simplifier");
  });

  it("all + source/test changes selects code-simplifier", () => {
    const selected = selectStandaloneReviewers(metadata({
      requestedKinds: ["all"],
      sourceOrTestChanged: true,
    }));
    expect(selected).toContain("code-simplifier");
  });

  it("all without source/test changes (docs-only scope) omits code-simplifier", () => {
    const selected = selectStandaloneReviewers(metadata({
      requestedKinds: ["all"],
      docsOnly: true,
      commentsChanged: true,
    }));
    expect(selected).not.toContain("code-simplifier");
  });

  it("non-simplify kinds never select code-simplifier, even when source changed", () => {
    for (const kind of ["code", "errors", "tests", "types", "comments", "architecture"] as const) {
      const selected = selectStandaloneReviewers(metadata({
        requestedKinds: [kind],
        sourceOrTestChanged: true,
        typesChanged: true,
        commentsChanged: true,
      }));
      expect(selected, `kind '${kind}' must not select the simplifier`).not.toContain("code-simplifier");
    }
  });

  it("keeps canonical spawn order: code-simplifier stays last in the full all roster", () => {
    const selected = selectStandaloneReviewers(metadata({
      requestedKinds: ["all"],
      sourceOrTestChanged: true,
      typesChanged: true,
      commentsChanged: true,
      additions: 600,
      fileCount: 12,
      newStructure: true,
    }));
    expect(selected).toEqual([
      "code-reviewer",
      "silent-failure-hunter",
      "pr-test-analyzer",
      "type-design-analyzer",
      "comment-analyzer",
      "architecture-tech-lead",
      "code-simplifier",
    ]);
  });
});

describe("selectStandaloneReviewers: plan-design roster (ADR-0070)", () => {
  it("is the fixed plan design roster whatever the scope facts say", () => {
    fc.assert(fc.property(
      fc.record({
        docsOnly: fc.boolean(), sourceOrTestChanged: fc.boolean(), typesChanged: fc.boolean(), commentsChanged: fc.boolean(),
        additions: fc.nat(5_000), fileCount: fc.integer({ min: 1, max: 40 }), newStructure: fc.boolean(),
      }),
      (facts) => {
        const scope = facts.docsOnly && !facts.sourceOrTestChanged && facts.commentsChanged
          ? { docsOnly: true, sourceOrTestChanged: false, commentsChanged: true } as const
          : { docsOnly: false } as const;
        expect(selectStandaloneReviewers(metadata({ ...facts, ...scope, requestedKinds: ["plan-design"] })))
          .toEqual(["code-reviewer", "type-design-analyzer", "architecture-tech-lead"]);
      },
    ));
  });

  it("selects the type and architecture lenses for a Markdown plan no other kind would give them to", () => {
    const markdownPlan = { docsOnly: true, commentsChanged: true, fileCount: 1 } as const;
    expect(selectStandaloneReviewers(metadata({ ...markdownPlan, requestedKinds: ["types"] }))).not.toContain("type-design-analyzer");
    expect(selectStandaloneReviewers(metadata({ ...markdownPlan, requestedKinds: ["code"] }))).not.toContain("architecture-tech-lead");
    expect(selectStandaloneReviewers(metadata({ ...markdownPlan, requestedKinds: ["plan-design"] }))).toEqual(PLAN_DESIGN_REVIEWERS);
  });
});
