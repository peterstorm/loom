/**
 * Round-14 remediation: the architecture panel's unpinned decision rules.
 *
 * Every rule here decides WHICH ARCHITECTURE SHIPS, and each survived the whole
 * suite as a mutant. They are grouped by the reviewer finding that exposed them.
 */

import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  aggregateVerdicts,
  candidateFilename,
  deriveJudgeCriteria,
  parseInterviewDigest,
  selectPanelLenses,
  serializeRankings,
  type CandidateFilename,
  type JudgeRanking,
  type JudgeVerdict,
} from "../../src/core/panel-contract";
import { coverageErrors, exactOrderedSetErrors } from "../../src/core/panel-kernel";

const digestOf = (overrides: Partial<Record<string, string>> = {}): string => {
  const fields: Record<string, string> = {
    "Primary axis": "simplicity",
    "Testability bar": "pure functional core",
    "Sensitive boundaries": "none",
    "Codebase maturity": "greenfield",
    "Codebase constraints": "none",
    "Error-handling philosophy": "Either/Result end-to-end",
    "Concurrency & state": "stateless and synchronous",
    "Data & persistence": "reuse existing files",
    "Tech preferences": "TypeScript",
    "Observability": "structured errors",
    "Backwards compatibility": "preserve current commands",
    "Deployment": "no change",
    "Out-of-scope": "nothing",
    "Executable-model signal": "none",
    ...overrides,
  };
  return Object.entries(fields)
    .map(([label, value]) => `**${label}:** ${value}`)
    .join("\n");
};

const digest = (overrides: Partial<Record<string, string>> = {}) => {
  const parsed = parseInterviewDigest(digestOf(overrides));
  if (!parsed.ok) throw new Error(`fixture must parse: ${parsed.errors.join("; ")}`);
  return parsed.value;
};

const ranking = (candidate: CandidateFilename, score: number): JudgeRanking => ({
  candidate,
  score,
  fatalFlaw: null,
  strongestIdea: "an idea",
});

/** One judge's verdict, built directly — these tests exercise `aggregateVerdicts`
 *  STANDALONE, which `panel-kernel` documents as a supported way to call it. */
const verdictOf = (
  criterion: string,
  scores: readonly (readonly [CandidateFilename, number])[],
): JudgeVerdict => ({
  criterion,
  entries: scores.map(([candidate, score]) => ranking(candidate, score)),
});

// ---------------------------------------------------------------------------
// C4 — the tie-break past the first criterion, and the criteria ORDER
// ---------------------------------------------------------------------------

describe("compareRankings breaks a total tie by walking every criterion", () => {
  const A = candidateFilename("simplicity-first");
  const B = candidateFilename("type-driven-fp");
  const CRITERIA = ["c0", "c1", "c2"] as const;

  /** Totals tie at 18. c0 ties; c1 favours A; c2 favours B. So the winner is
   *  decided entirely by which of c1/c2 the criteria order reaches first — the
   *  behaviour a `Math.min(1, …)` cap on the loop silently removed. */
  const TIED = [
    verdictOf("c0", [[A, 6], [B, 6]]),
    verdictOf("c1", [[A, 8], [B, 4]]),
    verdictOf("c2", [[A, 4], [B, 8]]),
  ];

  it("uses the SECOND criterion when the first ties", () => {
    const ranked = aggregateVerdicts(TIED, [...CRITERIA], [A, B]);
    expect(ranked.ok).toBe(true);
    if (!ranked.ok) return;
    expect(ranked.value.map((r) => r.totalScore)).toEqual([18, 18]);
    expect(ranked.value[0]!.candidate).toBe(A);
  });

  it("a different criteria ORDER produces a different winner — so the order is a contract", () => {
    const reversed = aggregateVerdicts(TIED, ["c2", "c1", "c0"], [A, B]);
    expect(reversed.ok).toBe(true);
    if (!reversed.ok) return;
    expect(reversed.value[0]!.candidate).toBe(B);
  });

  it("falls back to the lexicographically smallest filename only when every criterion ties", () => {
    const allTied = [
      verdictOf("c0", [[A, 6], [B, 6]]),
      verdictOf("c1", [[A, 6], [B, 6]]),
      verdictOf("c2", [[A, 6], [B, 6]]),
    ];
    const ranked = aggregateVerdicts(allTied, [...CRITERIA], [B, A]);
    expect(ranked.ok).toBe(true);
    if (!ranked.ok) return;
    expect(ranked.value.map((r) => r.candidate)).toEqual([...[A, B]].sort());
  });

  it("property: over K criteria, the winner is decided by the FIRST criterion that differs", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 3, max: 5 }),
        fc.integer({ min: 0, max: 4 }),
        (k, tieDepthRaw) => {
          // Build two candidates whose totals are equal and whose scores agree
          // on the first `tieDepth` criteria, then diverge.
          const tieDepth = Math.min(tieDepthRaw, k - 1);
          const criteria = Array.from({ length: k }, (_, i) => `c${i}`);
          const aScores: number[] = [];
          const bScores: number[] = [];
          for (let i = 0; i < k; i++) {
            if (i < tieDepth) {
              aScores.push(5);
              bScores.push(5);
            } else if (i === tieDepth) {
              aScores.push(8);
              bScores.push(2);
            } else {
              // Give the remainder back to B so the totals tie exactly.
              aScores.push(2);
              bScores.push(8);
            }
          }
          const total = (xs: number[]) => xs.reduce((s, x) => s + x, 0);
          // The construction only ties when there is exactly one trailing
          // criterion to give the difference back; skip the rest.
          if (total(aScores) !== total(bScores)) return true;

          const verdicts = criteria.map((criterion, i) =>
            verdictOf(criterion, [[A, aScores[i]!], [B, bScores[i]!]]),
          );
          const ranked = aggregateVerdicts(verdicts, criteria, [A, B]);
          if (!ranked.ok) return false;
          // A wins: it is ahead at index `tieDepth`, the first differing one.
          return ranked.value[0]!.candidate === A;
        },
      ),
    );
  });

  it("the criteria the handler passes are exactly deriveJudgeCriteria's, in its order", () => {
    // The handler's array order is the tie-break order proved above, so it is
    // itself a contract: `panel-contract aggregate` derives it from the
    // validated digest and must not reorder it.
    const derived = deriveJudgeCriteria(digest({ "Primary axis": "performance" }));
    expect(derived).toEqual(["performance", "pure functional core", "codebase fit + effort"]);
  });
});

// ---------------------------------------------------------------------------
// A12 — the score domain, standalone
// ---------------------------------------------------------------------------

describe("aggregateVerdicts validates the score domain when called standalone", () => {
  const A = candidateFilename("simplicity-first");
  const B = candidateFilename("type-driven-fp");

  it.each([
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["a negative score", -50],
    ["a fractional score", 3.7],
    ["a score above the cap", 11],
  ])("rejects %s rather than ranking it", (_label, score) => {
    // NaN was the worst: the comparator returned NaN, `sort` treats that as 0,
    // and the candidate came out RANK 1 with `"total_score": null` in the
    // artifact that decides which architecture ships.
    const ranked = aggregateVerdicts([verdictOf("c0", [[A, score], [B, 5]])], ["c0"], [A, B]);
    expect(ranked.ok).toBe(false);
    if (!ranked.ok) expect(ranked.errors.join(" ")).toContain("must be an integer from 0 to 10");
  });

  it("accepts the whole legal domain", () => {
    for (let score = 0; score <= 10; score++) {
      expect(aggregateVerdicts([verdictOf("c0", [[A, score], [B, score]])], ["c0"], [A, B]).ok).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// serializeRankings — rank numbering past the first row
// ---------------------------------------------------------------------------

describe("serializeRankings numbers every row, not just the first", () => {
  it("emits 1..N with no duplicates", () => {
    const candidates = ["simplicity-first", "type-driven-fp", "risk-security-first"].map(candidateFilename);
    const ranked = aggregateVerdicts(
      [verdictOf("c0", [[candidates[0]!, 9], [candidates[1]!, 7], [candidates[2]!, 5]])],
      ["c0"],
      candidates,
    );
    expect(ranked.ok).toBe(true);
    if (!ranked.ok) return;
    const parsed = JSON.parse(serializeRankings(ranked.value, ["c0"])) as {
      ranking: { rank: number; candidate: string; total_score: number }[];
    };
    expect(parsed.ranking.map((r) => r.rank)).toEqual([1, 2, 3]);
    expect(parsed.ranking.map((r) => r.total_score)).toEqual([9, 7, 5]);
  });
});

// ---------------------------------------------------------------------------
// A10 — every lens signal, at the panel size where it decides
// ---------------------------------------------------------------------------

describe("each lens signal is pinned at a size where it actually decides", () => {
  it.each([
    ["brownfield → codebase-conventionist", { "Codebase maturity": "brownfield" }, "codebase-conventionist"],
    ["flagged boundaries → risk-security-first", { "Sensitive boundaries": "flagged — auth" }, "risk-security-first"],
    ["performance axis → performance-first", { "Primary axis": "performance" }, "performance-first"],
  ])("%s", (_label, overrides, expected) => {
    // At size 3 exactly one slot is left after the two baselines, so the
    // signalled lens must take it. Replacing the brownfield signal with `null`
    // left the entire suite green, because the only test exercising it used a
    // digest whose other signals filled the slots first.
    const selected = selectPanelLenses(digest(overrides), 3);
    expect(selected.ok).toBe(true);
    if (!selected.ok) return;
    expect(selected.value).toEqual(["simplicity-first", "type-driven-fp", expected]);
  });

  it("an unsignalled digest falls through to table order", () => {
    const selected = selectPanelLenses(digest(), 3);
    expect(selected.ok).toBe(true);
    if (!selected.ok) return;
    expect(selected.value).toEqual(["simplicity-first", "type-driven-fp", "risk-security-first"]);
  });
});

// ---------------------------------------------------------------------------
// A5 / A28 — the kernel primitives the two panels now share
// ---------------------------------------------------------------------------

describe("coverageErrors reports a criterion with no verdict at all", () => {
  it("does not skip past it silently", () => {
    // The net exists to be redundant for standalone callers — and had a hole at
    // exactly the failure it is redundant against.
    const errors = coverageErrors(new Map(), ["c0"], ["x"], () => "x", "must cover everything");
    expect(errors).toEqual(["verdict for 'c0' is missing entirely"]);
  });
});

describe("exactOrderedSetErrors is one rule, used by both manifests", () => {
  it.each([
    ["a duplicate", ["a", "a"], ["a", "b"], "must be unique"],
    ["an absent member", ["a"], ["a", "b"], "missing"],
    ["a wrong order", ["b", "a"], ["a", "b"], "must exactly match"],
  ])("reports %s", (_label, actual, expected, fragment) => {
    const errors = exactOrderedSetErrors(actual, expected, {
      subject: "manifest lens ids",
      missing: "manifest is missing lens",
      ordered: "manifest lenses",
    });
    expect(errors.join(" ")).toContain(fragment);
  });

  it("is silent on an exact match", () => {
    expect(
      exactOrderedSetErrors(["a", "b"], ["a", "b"], { subject: "s", missing: "m", ordered: "o" }),
    ).toEqual([]);
  });
});
