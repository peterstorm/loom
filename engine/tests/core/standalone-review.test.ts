import { describe, expect, it } from "vitest";
import { parseFindingBriefJson } from "../../src/core/review-panel";
import {
  STANDALONE_REVIEW_SUBJECT,
  aggregateStandaloneReview,
  finalizeStandaloneReview,
  parseStandaloneAggregate,
  parseStandalonePanelOutcomes,
  serializeStandaloneAggregate,
} from "../../src/core/standalone-review";

const transcript = (critical: string[] = [], advisory: string[] = []) => [
  "### Machine Summary",
  `CRITICAL_COUNT: ${critical.length}`,
  `ADVISORY_COUNT: ${advisory.length}`,
  ...critical.map((claim) => `CRITICAL: ${claim}`),
  ...advisory.map((claim) => `ADVISORY: ${claim}`),
  "",
  "```findings",
  JSON.stringify([
    ...critical.map((claim) => ({ severity: "critical", file: "src/x.ts", line: 3, claim })),
    ...advisory.map((claim) => ({ severity: "advisory", file: null, line: null, claim })),
  ]),
  "```",
].join("\n");

function required() {
  const result = aggregateStandaloneReview({
    runId: "run.abc",
    scope: ["src/x.ts"],
    transcripts: [
      { agent: "code-reviewer", output: transcript(["real blocker"], ["small improvement"]) },
      { agent: "type-design-analyzer", output: transcript(["duplicate wording"]) },
    ],
  });
  expect(result.ok).toBe(true);
  if (!result.ok || result.value.kind !== "requires-refutation") throw new Error("expected criticals");
  return result.value;
}

describe("standalone review aggregate", () => {
  it("parses, attributes, and preserves findings from every reviewer", () => {
    const state = required();
    expect(state.criticals.map((finding) => finding.id)).toEqual(["code-reviewer-1", "type-design-analyzer-1"]);
    expect(state.aggregate.findings.map((finding) => finding.claim)).toEqual([
      "real blocker", "small improvement", "duplicate wording",
    ]);
  });

  it("fails closed when any reviewer omits its evidence marker", () => {
    const result = aggregateStandaloneReview({
      runId: "run.abc",
      scope: ["src/x.ts"],
      transcripts: [{ agent: "code-reviewer", output: "looks fine" }],
    });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.errors.join("\n")).toContain("CRITICAL_COUNT marker not found");
  });

  it("represents zero criticals as an explicit clean state", () => {
    const result = aggregateStandaloneReview({
      runId: "run.abc",
      scope: ["src/x.ts"],
      transcripts: [{ agent: "code-reviewer", output: transcript([], ["small improvement"]) }],
    });
    expect(result.ok && result.value.kind).toBe("clean");
  });

  it("round-trips the aggregate through its untrusted boundary", () => {
    const aggregate = required().aggregate;
    const parsed = parseStandaloneAggregate(JSON.parse(serializeStandaloneAggregate(aggregate)));
    expect(parsed).toEqual({ ok: true, value: aggregate });
  });
});

describe("standalone brief source invariant", () => {
  it("rejects a standalone source flag on a non-standalone subject", () => {
    const parsed = parseFindingBriefJson({
      wave: 9,
      source_kind: "standalone",
      severity: "critical",
      task_ids: ["T1"],
      findings: [{
        id: "T1:code-reviewer-1", task_id: "T1", agent: "code-reviewer",
        severity: "critical", file: null, line: null, claim: "blocker",
      }],
    });
    expect(parsed.ok).toBe(false);
    expect(!parsed.ok && parsed.errors.join("\n")).toContain("standalone brief.wave must be 1");
    expect(!parsed.ok && parsed.errors.join("\n")).toContain("standalone brief.task_ids must be exactly");
  });
});

describe("standalone review adjudication", () => {
  it("partitions every critical into surviving or audibly refuted", () => {
    const state = required();
    const raw = {
      lenses: ["reproduction", "intent", "blast-radius"],
      threshold: 2,
      surviving: 1,
      refuted: 1,
      outcomes: state.criticals.map((finding, index) => ({
        finding_id: `${STANDALONE_REVIEW_SUBJECT}:${finding.id}`,
        task_id: STANDALONE_REVIEW_SUBJECT,
        claim: finding.claim,
        survives: index === 0,
        refuted_by: index === 0 ? [] : ["reproduction", "intent"],
        reasoning: index === 0 ? [] : ["cannot trigger", "deliberate"],
        upheld_by: index === 0 ? ["reproduction", "intent"] : ["blast-radius"],
        uncertain_from: index === 0 ? ["blast-radius"] : [],
      })),
    };
    const panel = parseStandalonePanelOutcomes(raw, state.criticals, ["reproduction", "intent", "blast-radius"]);
    expect(panel.ok).toBe(true);
    if (!panel.ok) return;
    const result = finalizeStandaloneReview(state.aggregate, panel.value);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.survivingCriticals.map((finding) => finding.claim)).toEqual(["real blocker"]);
    expect(result.value.refutedCriticals[0]?.finding.claim).toBe("duplicate wording");
    expect(result.value.refutedCriticals[0]?.refutations).toEqual([
      { lens: "reproduction", reason: "cannot trigger" },
      { lens: "intent", reason: "deliberate" },
    ]);
    expect(result.value.advisories.map((finding) => finding.claim)).toEqual(["small improvement"]);
  });

  it("rejects missing, foreign, duplicate, or threshold-inconsistent outcomes", () => {
    const state = required();
    const one = state.criticals[0]!;
    const parsed = parseStandalonePanelOutcomes({
      lenses: ["reproduction", "intent", "blast-radius"], threshold: 2,
      outcomes: [{
        finding_id: `${STANDALONE_REVIEW_SUBJECT}:${one.id}`,
        claim: one.claim,
        survives: false,
        refuted_by: ["intent"], reasoning: ["not enough"], upheld_by: [], uncertain_from: [],
      }],
    }, state.criticals, ["reproduction", "intent", "blast-radius"]);
    expect(parsed.ok).toBe(false);
    expect(!parsed.ok && parsed.errors.join("\n")).toContain("must meet threshold");
    expect(!parsed.ok && parsed.errors.join("\n")).toContain("missing critical finding");
  });

  it("cannot finalize critical findings without a panel", () => {
    const result = finalizeStandaloneReview(required().aggregate, null);
    expect(result).toEqual({ ok: false, errors: ["standalone review has unadjudicated critical findings"] });
  });
});
